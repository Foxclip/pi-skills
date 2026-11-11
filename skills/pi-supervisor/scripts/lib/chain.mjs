// lib/chain.mjs — the window-end chain step (v0.27.0 — sub-runs as projects).
//
// A deterministic, idempotent transition from "window run-N of node X ended"
// to the project's next state: either a NEW WINDOW is launched (continuation
// of the same node, the spawned child's first window, or a parent re-entry)
// or the chain HALTS (stopped / blocked / done-idle / deadline-expired).
// No LLM in the chain — judgment lives in-window; the chain only reads
// on-disk facts (the guard's terminal status, FINAL-REPORT.md, the node's
// deadline, the window's spawn-request.json) and applies the decision table
// (plan §5.3).
//
// Called by:
//   (a) guard.mjs, after its final status is durable — the primary path. The
//       guard is detached (process-group leader), so the chain fires even
//       when no terminal is watching.
//   (b) the repair path (ralph.sh attach / zero-arg, repair=true): re-runs
//       any window that ended without chain-done.json (e.g. the guard died
//       with the machine; the user stop killed the group before the hook).
//
// Idempotency: <window>/chain-done.json. A window with the marker is never
// stepped again. A failed launch STILL writes the marker (outcome halted:
// "launch failed — human attention needed") with the node blocked — a
// persistent retry loop is worse than a visible halt, and the user's next
// ralph.sh allocates the freed window number again.
//
// Runs under the project lock (.pi-supervisor/.lock).

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import {
  ROOT,
  parentNodePath,
  childName,
  readJson,
  writeJson,
  readNode,
  listWindows,
  newestWindow,
  pidAlive,
  clearActive,
  windowBudget,
  withLock,
  supRoot,
  supNodePath,
  projectOfNode,
  nodePathOfProject,
  windowProjectOf,
  nodeJsonAt,
  nodeRunsDir,
  stateFileOf,
  ensureRootNode,
  ensureStateMdAt,
  grantChildAccess,
  registerChild,
  commitDetached,
  allocWindowIn,
  writeActive,
  isWindowName,
  windowNumber,
} from "./node.mjs";
import { sizeDeadline } from "./deadline.mjs";

const LIB = path.dirname(new URL(import.meta.url).pathname);
const SCRIPTS = path.dirname(LIB);
const LAUNCH = path.join(SCRIPTS, "launch.mjs");
const HARVEST = path.join(LIB, "harvest.mjs");

// ---------- logging ---------------------------------------------------------
// The chain appends every decision to <window>/chain.log (files only — the
// terminal follows via active.json; the terminal is a viewer, not a driver).
function clog(projectDir, windowDir, line) {
  const ts = new Date().toISOString();
  try {
    appendTolerant(path.join(windowDir, "chain.log"), `${ts} ${line}\n`);
  } catch { /* best effort — the marker + decision files are the record */ }
}

// ---------- fs helpers ------------------------------------------------------
// Append tolerating ownership drift (v0.30.0 P1, run37): if a direct append
// fails with EACCES/EPERM — e.g. a STATE.md the child's own pi process wrote
// (run dirs are mkdtemp, pichild-owned, so the files inside can be pichild-
// owned too) — rename the file aside, rewrite old+new as the caller, unlink
// the backup. Needs directory write (rename target), not file write, so it
// works on files we do not own. The rewritten file is caller-owned: the
// owner keeps taking back what the child touched.
export function appendTolerant(file, text) {
  try {
    fs.appendFileSync(file, text);
  } catch (err) {
    if (err && (err.code === "EACCES" || err.code === "EPERM")) {
      const old = fs.readFileSync(file, "utf8");
      const bak = `${file}.bak-${Date.now()}-${process.pid}`;
      fs.renameSync(file, bak);
      fs.writeFileSync(file, old + text);
      // v0.31.0 (PLAN-run2 item 3): the reclaim flipped ownership back to the
      // caller — re-grant the worker on the state files it must be able to
      // append (STATE.md/TASK.md only; chain.log lives in the child-owned run
      // dir where the child has full control anyway).
      if (/^(STATE|TASK)\.md$/.test(path.basename(file))) grantChildAccess(file);
      try { fs.unlinkSync(bak); } catch { /* best effort */ }
    } else {
      throw err;
    }
  }
}

// ---------- classification --------------------------------------------------
// The window's terminal kind — the row of the §5.3 table.
//   guard-driven (cfg.repair falsy): the guard's own fresh outcome is truth.
//   repair (cfg.repair true): the guard is dead; FINAL-REPORT.md (written by
//     the monitor's STOP judgment) is the "completed" marker; a stale
//     running/absent status = user stop or reboot → "stopped" (halt; a human
//     decides whether to continue — never auto-relaunch over user intent).
export function classifyWindow(projectDir, windowDir, st, hasFinalReport, repair) {
  // v0.30.1: an explicit user stop (ralph.sh's Ctrl-C trap / the `stop`
  // subcommand) writes user-stop.json before the group kill. User intent is
  // not read from the terminal status — a graceful stop leaves
  // "error/killed-SIGTERM", which the table below would misread as an
  // abnormal end (blocked + "human attention needed"). The marker wins in
  // BOTH modes; an external kill has no marker and still classifies below.
  try {
    fs.statSync(path.join(windowDir, "user-stop.json"));
    return "stopped";
  } catch { /* no user-stop marker — the table below applies */ }
  if (!repair) {
    const o = st?.exitReason;
    if (o === "completed" || o === "completed-finalized" || hasFinalReport) return "completed";
    if (o === "hard-timeout") return "budget-used";
    return "blocked"; // stuck-* / consult-* / error / aborted-external
  }
  if (hasFinalReport || st?.status === "completed") return "completed";
  if (st?.exitReason === "hard-timeout") return "budget-used";
  if (st && ["stuck", "consult", "error"].includes(st.status)) return "blocked";
  return "stopped"; // stale running / dead guard, no report — user stop, reboot, kill
}

// ---------- briefs (plan §5.6) ----------------------------------------------
// Deterministic assembly from on-disk facts; the guard prepends
// --preamble standard (templates/standard-contract.md) on launch, so each
// brief carries only the node-specific content.
function readOrNull(p, max = 20000) {
  try {
    const s = fs.readFileSync(p, "utf8");
    return s.length > max ? `…(truncated ${s.length}→${max} chars)\n` + s.slice(-max) : s;
  } catch { return null; }
}

// The final report of a window: FINAL-REPORT.md (the monitor's judgment) if
// present, else the harvested RUN-REPORT.md, else the guard's final text.
function windowFinalReport(wdir) {
  for (const f of ["FINAL-REPORT.md", "RUN-REPORT.md"]) {
    const s = readOrNull(path.join(wdir, f));
    if (s) return s;
  }
  const st = readJson(path.join(wdir, "pi-child-status.json"));
  return st?.finalText ? st.finalText.slice(0, 4000) : "(no report on disk)";
}

function budgetLine(budget) {
  if (!budget || !budget.ok) return "(no remaining budget — this window may be a bookkeeping-only turn)";
  const d = new Date(budget.deadlineMs);
  const p = (n) => String(n).padStart(2, "0");
  return `~${budget.minutes} minutes, hard deadline ${d.toISOString()} (${d.getHours()}:${p(d.getMinutes())} local)`;
}

// Sub window 1 — a spawned child node's first window.
function briefSub({ nodePath, taskText, budget }) {
  const L = [];
  L.push(`# SUB-PROJECT — ${nodePath}`);
  L.push("");
  L.push("You are the first window of this node. The node's deadline is invariant across its windows; this window's budget:");
  L.push(`- ${budgetLine(budget)}`);
  L.push("");
  L.push("## Your task (the sub-project's task file, verbatim)");
  L.push("");
  L.push("```");
  L.push(taskText.trim());
  L.push("```");
  L.push("");
  L.push("## Sub-run rules (on top of the standard contract above)");
  L.push(`- Work the task; update this node's STATE.md (in your project dir, one level up from .pi-supervisor) at every milestone — it is the distillation the next window reads.`);
  L.push("- To start your own sub-project: write its task file, run `ralph.sh spawn --name <node> --task <file> [--deadline <t>] [--runtime <m>]`, then END THE TURN cleanly. You will be paused and re-entered later. Direct launches are denied for child sessions.");
  L.push("- When the task is done: end with a final report (the standard contract's report protocol) — the chain reads it when it re-enters your parent.");
  L.push("");
  return L.join("\n");
}

// Continuation (resume) — v0.30.0: the previous window's session still fits
// under the resume gate, so the node's run continues in the SAME session.
// The child gets full context; the brief is a nudge, not a handoff.
function briefResumeContinue({ nodePath, window, prevWindowDir, budget }) {
  const L = [];
  L.push(`# CONTINUATION (resume) — ${nodePath} / ${window}`);
  L.push("");
  L.push(`Your previous window (${path.basename(prevWindowDir)}) used its launch budget before declaring the goal met. This window RESUMES that session — your full context is intact. Continue; do not restart.`);
  L.push("");
  L.push(`## Budget`);
  L.push(`- ${budgetLine(budget)}`);
  L.push("");
  L.push("## Your job");
  L.push("1. Continue exactly where the previous window stopped (its final report is the last message of this session).");
  L.push("2. Keep STATE.md current (in your project dir, one level up from .pi-supervisor).");
  L.push("3. End with the standard final report when the goal is met (or when this budget runs out — the next window continues).");
  L.push("");
  return L.join("\n");
}

// Continuation — the same node, previous window used its budget, goal not met.
function briefContinuation({ nodePath, window, prevWindowDir, budget }) {
  const L = [];
  L.push(`# CONTINUATION — ${nodePath} / ${window}`);
  L.push("");
  L.push(`This node's previous window (${path.basename(prevWindowDir)}) used its budget without declaring the goal met. RESUME — do not restart.`);
  L.push("");
  L.push(`## Budget`);
  L.push(`- ${budgetLine(budget)}`);
  L.push("");
  L.push("## Previous window's final report");
  L.push("");
  L.push("```");
  L.push(windowFinalReport(prevWindowDir).trim());
  L.push("```");
  L.push("");
  L.push("## Your job");
  L.push(`1. Read the previous report and the node's STATE.md (in your project dir, one level up from .pi-supervisor).`);
  L.push("2. Continue the remaining work — pick up where it stopped.");
  L.push("3. Keep STATE.md current; end with the standard final report when the goal is met (or when this budget runs out — the next window continues).");
  L.push("");
  return L.join("\n");
}

// Re-entry — the parent node resumes after a child node ended (done or
// deadline-expired). Resume variant (v0.30.0): the parent's own session still
// fits, so the re-entry window RESUMES it — the run continues with full
// context; the bookkeeping (distill + next-step decision) happens in-place.
// Fresh variant: a bookkeeping turn, not a work turn.
function briefReentry({ nodePath, window, childPath, childState, childFinalDir, decision, budget, resume = false }) {
  const L = [];
  L.push(resume ? `# RE-ENTRY (resume) — ${nodePath} / ${window}` : `# RE-ENTRY — ${nodePath} / ${window}`);
  L.push("");
  if (resume) {
    L.push(`The child node \`${childPath}\` has ended (state: ${childState}). This window RESUMES your own session — your full context is intact. Take over: distill, decide the next step.`);
  } else {
    L.push(`The child node \`${childPath}\` has ended (state: ${childState}). This is a BOOKKEEPING window: read, distill, decide. Do not start new work here.`);
  }
  L.push("");
  L.push(`## Budget`);
  L.push(`- ${budgetLine(budget)}`);
  L.push("");
  L.push("## Child's final report");
  L.push("");
  L.push("```");
  L.push(windowFinalReport(childFinalDir).trim());
  L.push("```");
  L.push("");
  L.push("## The spawn decision that launched it");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify(decision ?? null, null, 2));
  L.push("```");
  L.push("");
  L.push("## Your job");
  L.push("1. Distill the child's outcome into this node's STATE.md (verified facts / next).");
  L.push("2. Decide: `ralph.sh spawn --name <next> --task <file>` for the next sub-project (then END THE TURN), or declare this node done (end with the standard final report).");
  if (resume) L.push("3. If the node's next step of work is yours, you may continue it here — you have the full context.");
  else L.push("3. Do not start new work in this window.");
  L.push("");
  return L.join("\n");
}

// ---------- node state bookkeeping -------------------------------------------
// nodeJsonAt/stateFileOf resolve the node's project (its dot-dir node.json,
// its root STATE.md — root and sub-projects alike).
function setNodeState(projectDir, nodePath, state) {
  const nj = readNode(projectDir, nodePath);
  if (!nj) return;
  const p = nodeJsonAt(projectDir, nodePath);
  if (!p) return;
  nj.state = state;
  writeJson(p, nj);
}

function appendState(projectDir, nodePath, lines) {
  const sp = stateFileOf(projectDir, nodePath);
  if (!sp) return;
  appendTolerant(sp, "\n" + lines + "\n");
}

// Clear the active slot of the tree root AND of the window's own project when
// they differ (v0.27.0 §3: two slots — the window's project slot is the
// terminal's; the root slot is what the root's attach follows). Same dir →
// one clear.
function clearActiveSlots(projectDir, windowDir) {
  clearActive(projectDir);
  const wproj = windowProjectOf(windowDir);
  if (wproj && path.resolve(wproj) !== path.resolve(projectDir)) clearActive(wproj);
}

// Allocate a window for a node: into the node project's own runs dir, under
// that project's lock (nested lock order is always root → child; the caller
// holds the root lock).
async function allocForNode(projectDir, nodePath) {
  const pof = projectOfNode(projectDir, nodePath);
  const runsDir = nodeRunsDir(projectDir, nodePath);
  if (!pof.dir || !runsDir) return null;
  if (path.resolve(pof.dir) === path.resolve(projectDir)) return allocWindowIn(runsDir); // caller holds the root lock
  return withLock(pof.dir, () => allocWindowIn(runsDir));
}

// ---------- launch ------------------------------------------------------------
// v0.30.0 chain-level resume gate (Box2D rule, plan §2): a window's last
// session resumes ONLY while the session file stays under the overflow
// threshold — the same knob and default as the guard's --overflow-threshold-mb
// (cfg.launch.overflowThresholdMb, default 3 MB), because resuming a
// transcript near the model's context window just stalls (the Box2D run).
// sessionFile (a path) is preferred over sessionId (an ID resolves only in
// the guard's cwd, and cannot be sized). Returns { resume, why, ref }.
export function sessionGate(windowDir, cfg) {
  const st = readJson(path.join(windowDir, "pi-child-status.json"));
  const ref = st?.sessionFile || st?.sessionId || null;
  if (!ref) return { resume: false, why: "no session recorded in pi-child-status.json", ref: null };
  if (!path.isAbsolute(String(ref))) return { resume: false, why: `session ref is not a file path (cannot size it): ${ref}`, ref };
  let size;
  try { size = fs.statSync(ref).size; } catch (e) { return { resume: false, why: `session file unreadable (${e.code || e.message}): ${ref}`, ref }; }
  const mb = Number(cfg?.launch?.overflowThresholdMb) || 3;
  if (size >= mb * 1048576) return { resume: false, why: `session ${(size / 1048576).toFixed(1)}MB >= ${mb}MB threshold (Box2D rule — a near-window resume just stalls)`, ref };
  return { resume: true, why: null, ref, sizeMb: size / 1048576 };
}

// Launch a window through launch.mjs (it writes active.json, the PI_SUP_* env,
// the guard detached). Synchronous: the chain must know before it records the
// outcome. Returns { ok, error, launchOut }. sessionRef (v0.30.0) is passed to
// launch.mjs/guard as --session: the window RESUMES that session file.
function launchWindow(projectDir, nodePath, wdir, budget, cfg, windowDir, log, sessionRef = null, taskFile = null) {
  const L = cfg.launch || {};
  // v0.29.2 (run34): never hand launch.mjs a deadline it is forced to reject —
  // the same rule sizeDeadline applies at its wall clock, checked once here
  // (covers the continuation and re-entry paths; the spawn path ALSO checks
  // this earlier, before its side effects).
  {
    const finalizeMin = Number(L.finalizeMin) || 10;
    const sized = sizeDeadline({ ts: new Date(budget.deadlineMs), finalizeMin, now: new Date() });
    if (!sized.ok) {
      log(`launch refused: node=${nodePath || ROOT} window=${path.basename(wdir)} — ${sized.why}`);
      return { ok: false, error: sized.why };
    }
  }
  // v0.27.0: the window's OWN project (its runs/ home — the sub-project, or
  // the tree root itself) vs the SCHEDULER ROOT (projectDir).
  // launch.mjs records active.json in the window's project and spawns the
  // guard with cwd = that project, so the child pi works in it (plan §3/§4).
  const wproj = windowProjectOf(wdir) || projectDir;
  const args = [
    LAUNCH,
    "--task-file", taskFile || path.join(wdir, "TASK.md"),
    "--out-dir", wdir,
    "--project", wproj,
    "--tree-root", projectDir,
    "--node", nodePath || ROOT,
    "--deadline", String(Math.floor(budget.deadlineMs / 1000)),
    "--idle-timeout", String(L.idleTimeoutSec ?? 300),
    "--turn-stall", String(L.turnStallSec ?? 900),
    "--finalize", String(L.finalizeMin ?? 10),
  ];
  if (L.preamble) args.push("--preamble", L.preamble);
  if (L.provider) args.push("--provider", L.provider);
  if (L.model) args.push("--model", L.model);
  if (L.thinking != null) args.push("--thinking", String(L.thinking));
  if (sessionRef) args.push("--session", String(sessionRef));
  // v0.35.14 (7.8): file keeps the ISO deadline; the terminal line carries the
  // local date+time (the terminal never shows ISO-8601).
  log(
    `launch: node=${nodePath || ROOT} window=${path.basename(wdir)} project=${wproj} deadline=${new Date(budget.deadlineMs).toISOString()}${sessionRef ? ` session=${sessionRef}` : ""}`,
    `launch: node=${nodePath || ROOT} window=${path.basename(wdir)} project=${wproj} deadline=${new Date(budget.deadlineMs).toLocaleString("en-CA", { hour12: false })}${sessionRef ? ` session=${sessionRef}` : ""}`
  );
  let r;
  try {
    r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 180000, cwd: wproj });
  } catch (e) {
    return { ok: false, error: `spawnSync threw: ${e.message}` };
  }
  if (r.status !== 0) {
    return { ok: false, error: `launch.mjs exited ${r.status}: ${(r.stderr || r.stdout || "").slice(-500)}` };
  }
  return { ok: true, launchOut: (r.stdout || "").trim() };
}

// ---------- harvest ------------------------------------------------------------
function harvest(windowDir) {
  try {
    spawnSync(process.execPath, [HARVEST, windowDir], { encoding: "utf8", timeout: 120000 });
  } catch { /* harvest is best-effort by contract */ }
}

// ---------- the step ------------------------------------------------------------
/**
 * step(projectDir, windowDir, cfg) — one chain step for the ended window.
 * cfg: {
 *   repair: boolean,              // repair path (guard already dead)
 *   launch: { model, provider, thinking, preamble, idleTimeoutSec,
 *             turnStallSec, finalizeMin, runtimeMin },   // window sizing + model
 *   log: (line) => void,          // optional extra sink (guard log, ralph.log)
 * }
 * Returns { kind, outcome, decision?, next? } — see chain-done.json.
 */
// v0.27.0: which node owns this window dir? Legacy shape first: the window's
// The window's own project (its runs live in the project's .pi-supervisor/
// runs/), looked up in the tree registry via nodePathOfProject (BFS over
// each project's own children — the registry is distributed, one level per
// project). ROOT when the window's project IS the project; null when the
// registry does not know the project (moved or foreign — the caller then
// treats the window as standalone).
function resolveWindowNode(projectDir, windowDir) {
  const wproj = windowProjectOf(windowDir);
  if (!wproj) return null;
  return nodePathOfProject(projectDir, wproj);
}

export async function step(projectDir, windowDir, cfg = {}) {
  const marker = path.join(windowDir, "chain-done.json");
  if (fs.existsSync(marker)) return { skipped: "chain-done" };
  // v0.35.14 (7.8): the FILE line (chain.log) keeps ISO; the TERMINAL variant
  // (2nd arg) may differ so the terminal never shows ISO-8601 (e.g. deadlines).
  const log = (line, terminal) => {
    clog(projectDir, windowDir, line);
    if (typeof cfg.log === "function") { try { cfg.log(terminal ?? line); } catch { /* sink must not kill the chain */ } }
  };
  // v0.27.0: the scheduler root no longer holds .pi-supervisor (the tree moved
  // away or was deleted) — the window has no parent tree to be decided by.
  // DEGRADE TO STANDALONE (plan §4): the window's own project decides it with
  // the same table as root, its own lock, one-time parent:null demotion. A
  // normal mode change, NOT an error — no chain-error.json.
  if (!fs.existsSync(supRoot(projectDir))) {
    return stepStandalone(projectDir, windowDir, cfg, log);
  }
  return withLock(projectDir, () => stepCore(projectDir, windowDir, cfg, log, false));
}

// Standalone degradation (plan §4): step the window under ITS OWN project —
// same terminal table with isRoot=true, the project's own lock, one-time
// `parent: null` demotion in the project's node.json.
async function stepStandalone(treeRoot, windowDir, cfg, log) {
  const wproj = windowProjectOf(windowDir);
  if (!wproj) {
    log(`standalone: tree root ${treeRoot} AND the window's project are both gone — cannot step`);
    return { kind: "standalone", outcome: { next: "halted", reason: "standalone-unresolved" } };
  }
  const njp = supNodePath(wproj);
  const snj = readJson(njp);
  if (snj && snj.parent) {
    snj.parent = null;
    writeJson(njp, snj);
    ensureStateMdAt(path.join(wproj, "STATE.md"), snj.name || "(root)");
    appendTolerant(path.join(wproj, "STATE.md"),
      `\n- [${new Date().toISOString()}] tree root ${treeRoot} is gone — this project is now STANDALONE (parent demoted to null); its windows are decided by its own chain\n`);
    log(`standalone mode: demoted ${wproj} to parent:null`);
  } else {
    log(`standalone mode: tree root ${treeRoot} no longer holds .pi-supervisor — stepping ${wproj} on its own`);
  }
  return withLock(wproj, () => stepCore(wproj, windowDir, cfg, log, true));
}

// The terminal table (shared by the tree path and standalone degradation).
// projectDir is the SCHEDULER project whose lock the caller ALREADY HOLDS:
// the tree root, or — standalone — the window's own project.
async function stepCore(projectDir, windowDir, cfg, log, standalone) {
  const marker = path.join(windowDir, "chain-done.json");
  if (fs.existsSync(marker)) return { skipped: "chain-done" }; // re-check under the lock
  let nodePath = standalone ? ROOT : resolveWindowNode(projectDir, windowDir);
  if (!nodePath) {
    // v2 window in a project the registry does not know (moved back, foreign)
    // — treat it as standalone: demotion + its own lock (root → child order).
    const wproj = windowProjectOf(windowDir);
    if (!wproj) {
      const reason = "cannot resolve the window's project from its location";
      log(reason);
      try { writeJson(marker, { v: 1, at: new Date().toISOString(), kind: "unresolved", outcome: { next: "halted", reason } }); } catch { /* best effort */ }
      return { kind: "unresolved", outcome: { next: "halted", reason } };
    }
    log(`window's project ${wproj} is not in the tree's registry — treating it as standalone`);
    return stepStandalone(projectDir, windowDir, cfg, log);
  }
  const st = readJson(path.join(windowDir, "pi-child-status.json"));
  const hasFinal = fs.existsSync(path.join(windowDir, "FINAL-REPORT.md"));
  const kind = classifyWindow(projectDir, windowDir, st, hasFinal, Boolean(cfg.repair));
  log(`step start: window=${path.basename(windowDir)} node=${nodePath} kind=${kind} repair=${Boolean(cfg.repair)} standalone=${standalone}`);

  const done = (outcome) => {
    const rec = { v: 1, at: new Date().toISOString(), kind, outcome };
    writeJson(marker, rec);
    // run4 fix (F2): a halt is a TERMINAL run decision — leave a durable,
    // greppable marker next to chain-done.json so the monitor can detect the
    // halt without parsing prose and write the final report (7.7) with the
    // halt context (the run ended; the sub-run's report is on disk).
    if (outcome.next === "halted") {
      try {
        writeJson(path.join(windowDir, "chain-halt.json"), {
          v: 1, at: new Date().toISOString(), kind, node: nodePath || ROOT,
          reason: outcome.reason || null, window: path.basename(windowDir),
        });
      } catch { /* best effort — the marker is a convenience for the monitor */ }
    }
    log(`step done: outcome=${outcome.next || "halted"}${outcome.node_path ? ` next=${outcome.node_path}/${outcome.window}` : ""}`);
    return { kind, outcome };
  };

  // Materialize the node: the root node lazily (ensureRootNode, idempotent);
  // a sub-node already exists — it was materialized by the spawn that
  // created its project.
  const nj = nodePath === ROOT ? ensureRootNode(projectDir, {}).node : readNode(projectDir, nodePath);
  if (!nj) {
    return haltBlocked(projectDir, nodePath, windowDir, log, `node ${nodePath} has no node.json (registry entry without a project?) — human attention`, (o) => done(o));
  }

  // ---- 1) stopped (user stop / reboot — repair path): halt, no auto-next
  if (kind === "stopped") {
    setNodeState(projectDir, nodePath, "stopped");
    appendState(projectDir, nodePath,
      `- [${new Date().toISOString()}] window ${path.basename(windowDir)} ended externally (user stop / reboot) — chain halted; continue only on explicit relaunch`);
    clearActiveSlots(projectDir, windowDir);
    return done({ next: "halted", reason: "stopped" });
  }

    // ---- 2) harvest (idempotent, never throws)
    harvest(windowDir);

    // ---- 3) spawn request — the child's last durable intent. Honored even
    // if the window ended by error, as long as the request is valid (plan §5.3.4).
    const reqPath = path.join(windowDir, "spawn-request.json");
    let spawnRejected = null;
    if (fs.existsSync(reqPath)) {
      const req = readJson(reqPath);
      const decision = await processSpawnRequest(projectDir, nodePath, windowDir, req, cfg, log);
      writeJson(path.join(windowDir, "spawn-decision.json"), decision);
      if (decision.ok) {
        return done({ next: "spawned", node_path: decision.node_path, window: decision.window, run_dir: decision.run_dir, deadline: decision.deadline });
      }
      spawnRejected = decision.reason;
      appendState(projectDir, nodePath, `- [${new Date().toISOString()}] spawn request (${decision.node || "?"}) rejected: ${decision.reason}`);
      log(`spawn request rejected: ${decision.reason} — falling through to the terminal table`);
    }

    // ---- 4) the terminal table (no request, or an invalid one)
    const parent = parentNodePath(nodePath);
    const parentName = parent === null ? null : parent; // root has no parent
    // standalone: the project decides as its own root — no re-entry, no hand-off
    const isRoot = standalone || parentName === null;

    if (kind === "completed") {
      setNodeState(projectDir, nodePath, "done");
      appendState(projectDir, nodePath,
        `- [${new Date().toISOString()}] window ${path.basename(windowDir)} completed — node done`);
      if (isRoot) {
        clearActiveSlots(projectDir, windowDir);
        if (spawnRejected) {
          // A rejected spawn at a terminal root would otherwise disappear
          // into a quiet "done" — escalate: the root is BLOCKED, not idle.
          return haltBlocked(projectDir, nodePath, windowDir, log,
            `spawn request rejected (${spawnRejected}) — all windows completed and no window left to carry it — manual attention: fix the cause, then re-spawn under the same name (a sub-project left behind stays registered, state blocked — the retry joins it) or free the name (remove its dir + its line in .pi-supervisor/node.json), and run ralph.sh in this project`, (o) => done(o));
        }
        return done({ next: "idle", reason: standalone ? "standalone-done" : "root-done" });
      }
      // The re-entry launches the PARENT's window (launch.mjs writes that slot);
      // without this clear, this window's own project slot (written by launch.mjs
      // when it launched) is never cleared — a stale active.json with a dead
      // guard_pid (e2e-final 2026-11-04: the sub project's slot survived the run).
      clearActiveSlots(projectDir, windowDir);
      return await reentry(parentName, projectDir, nodePath, windowDir, cfg, log, "done", (o) => done(o));
    }

    if (kind === "budget-used") {
      const expired = nodeDeadlineExpired(nj, projectDir, nodePath, windowDir);
      if (expired) {
        setNodeState(projectDir, nodePath, "deadline-expired");
        appendState(projectDir, nodePath,
          `- [${new Date().toISOString()}] window ${path.basename(windowDir)} used its budget and the node deadline has passed — deadline-expired`);
        if (isRoot) {
          clearActiveSlots(projectDir, windowDir);
          if (spawnRejected) {
            return haltBlocked(projectDir, nodePath, windowDir, log,
              `spawn request rejected (${spawnRejected}) — the node is deadline-expired with no window left to carry it — manual attention: the invariant deadline has passed (it never moves) — re-spawn under a fresh name with a later --deadline, or remove the node dir + registry line to free the name`, (o) => done(o));
          }
          return done({ next: "idle", reason: standalone ? "standalone-deadline-expired" : "root-deadline-expired" });
        }
        // Same stale-slot clear as the completed path above (the re-entry
        // launches the parent's window; this window's slots must go).
        clearActiveSlots(projectDir, windowDir);
        return await reentry(parentName, projectDir, nodePath, windowDir, cfg, log, "deadline-expired", (o) => done(o));
      }
      // v0.32.0 (3.2): no automatic continuation — the run ENDED at its
      // deadline (the hard timeout already killed the window); a new run is
      // a human's (2.1) and picks up from the on-disk state. The node pauses.
      setNodeState(projectDir, nodePath, "paused");
      appendState(projectDir, nodePath,
        `- [${new Date().toISOString()}] window ${path.basename(windowDir)} used its budget — the run ended at its deadline (3.2); goal not met; state on disk; a human starts the next run (2.1) (node deadline ${nj.deadline ?? "(none)"})`);
      clearActiveSlots(projectDir, windowDir);
      return done({ next: "idle", reason: "budget-used" });
    }

    // blocked (stuck / consult / error / aborted)
    return haltBlocked(projectDir, nodePath, windowDir, log, `window ended ${st?.exitReason || st?.status || "unclassified"} — human attention needed`, (o) => done(o));
}

// Allocate a window, write its brief (a function of the window name, so the
// header names its own window), launch. On launch failure: remove the freshly
// allocated window dir (no process could have started from it) so the number
// is not burned, and leave NO chain-done marker (retryable via repair).
async function openWithRetryName({ projectDir, nodePath, brief, budget, cfg, windowDir, log, sessionRef = null, targetWindowDir = null, briefFile = "TASK.md" }) {
  // v0.32.0 (2.3/5.1): targetWindowDir = RE-ACTIVATION — reuse an existing
  // window dir (no allocation; nothing is removed on failure, the window
  // stays), brief written to briefFile (RE-ENTRY.md, never the original task).
  let window, wdir;
  if (targetWindowDir) {
    window = path.basename(targetWindowDir);
    wdir = targetWindowDir;
  } else {
    const a = await allocForNode(projectDir, nodePath);
    if (!a) {
      clog(projectDir, windowDir, `allocation failed for ${nodePath}: the node's runs dir is unresolvable (project dir missing?)`);
      return { ok: false, error: "allocation failed (node's runs dir unresolvable)" };
    }
    window = a.window; wdir = a.dir;
  }
  fs.writeFileSync(path.join(wdir, briefFile), brief(window));
  const r = launchWindow(projectDir, nodePath, wdir, budget, cfg, windowDir, log, sessionRef, briefFile === "TASK.md" ? null : path.join(wdir, briefFile));
  if (!r.ok) {
    clog(projectDir, windowDir, `launch FAILED for ${nodePath}/${window}: ${r.error}${targetWindowDir ? " — re-activation of the existing window (nothing removed)" : " — window dir removed (caller records the blocked outcome)"}`);
    if (!targetWindowDir) {
      try { fs.rmSync(wdir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    return { ok: false, error: r.error };
  }
  // v0.27.0 §3: the chain maintains the TREE ROOT's active slot (what a root
  // attach follows) from the launched guard's pid; the window's OWN project
  // slot is launch.mjs's (already written under that project's lock).
  const wproj = windowProjectOf(wdir);
  if (wproj && path.resolve(wproj) !== path.resolve(projectDir)) {
    let pid = null;
    try {
      const last = (r.launchOut || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
      const j = JSON.parse(last);
      pid = j.guardPid ?? j.pid ?? null;
    } catch { /* the slot is a convenience — a parse miss is not fatal */ }
    try {
      writeActive(projectDir, {
        run_dir: wdir,
        node: nodePath || ROOT,
        guard_pid: pid,
        window,
        started_at: new Date().toISOString(),
        deadline: new Date(budget.deadlineMs).toISOString(),
      });
    } catch { /* best effort — the launch itself is the truth */ }
  }
  return { ok: true, window, dir: wdir, launchOut: r.launchOut };
}

export async function reentry(parentPath, projectDir, childPath, childWindowDir, cfg, log, childState, done) {
  // §6 child-moved: (a) the re-entry TARGET's project dir is gone, or
  // (b) the parent is paused(waiting:X) and X's dir is gone. A detached
  // line is never re-entered — a human decides (re-point or clear it).
  {
    const pof = projectOfNode(projectDir, parentPath);
    if (!pof.dir) {
      const gparent = parentNodePath(parentPath);
      const gproj = (gparent === null || gparent === ROOT)
        ? projectDir
        : (projectOfNode(projectDir, gparent).dir || projectDir);
      commitDetached(gproj, childName(parentPath));
      return haltBlocked(projectDir, parentPath, childWindowDir, log,
        `child-moved: the re-entry target's project dir for ${parentPath} is not found (moved?) — point the registry at the new location or clear the line`, done);
    }
    const pnj0 = readNode(projectDir, parentPath) || {};
    const m = String(pnj0.state || "").match(/^paused\(waiting:([A-Za-z0-9._-]+)\)$/);
    if (m) {
      const x = m[1];
      const xFull = parentPath === ROOT ? x : `${parentPath}/${x}`;
      const xproj = projectOfNode(projectDir, xFull);
      if (!xproj.dir) {
        commitDetached(pof.dir, x);
        appendState(projectDir, parentPath,
          `- [${new Date().toISOString()}] child ${xFull} is DETACHED (dir not found — moved?) — no re-entry; point the registry at the new location or clear this line`);
        return haltBlocked(projectDir, parentPath, childWindowDir, log,
          `child-moved: ${xFull} is detached (dir not found — moved?) — point the registry at the new location or clear the line`, done);
      }
    }
  }
  // the child's final window (its report is the re-entry's input) — the
  // child project's OWN runs dir.
  const childRuns = nodeRunsDir(projectDir, childPath);
  if (!childRuns) {
    return haltBlocked(projectDir, parentPath, childWindowDir, log,
      `cannot resolve the child's runs dir for ${childPath} (registry entry without a project?) — human attention`, done);
  }
  const childFinalDir = path.join(childRuns, newestWindow(childRuns) || "run-1");
  // v0.32.0 (2.3/5.1): the re-entry RE-ACTIVATES the parent's original run —
  // the window that carried the spawn decision (or, without a decision on
  // disk, the parent's newest window — its state is the on-disk fact) — same
  // run dir, same deadline, no new window, no new run of its own project.
  const pdir = nodeRunsDir(projectDir, parentPath);
  if (!pdir) {
    return haltBlocked(projectDir, parentPath, childWindowDir, log,
      `cannot resolve the re-entry target's runs dir for ${parentPath} (registry entry without a project?) — human attention`, done);
  }
  let spawnWin = findSpawnWindow(projectDir, parentPath, childPath);
  if (!spawnWin) {
    let ents = [];
    try { ents = fs.readdirSync(pdir, { withFileTypes: true }); } catch { ents = []; }
    spawnWin = ents.filter((e) => e.isDirectory() && isWindowName(e.name))
      .map((e) => e.name).sort((a, b) => windowNumber(b) - windowNumber(a))[0] || null;
  }
  if (!spawnWin) {
    return haltBlocked(projectDir, parentPath, childWindowDir, log,
      `cannot find the parent run to re-activate (no window in ${pdir}) — human attention`, done);
  }
  const winDir = path.join(pdir, spawnWin);
  // The RUN's deadline (1.3 invariant — a run owns its deadline; only a fresh
  // human launch moves it). run4 fixes (F1, D1-a): the re-entry is PART OF
  // THE RUN, so its budget is sized against the NODE's deadline, not the dead
  // launch instance's hard stop (run4: the window allocation had 10.9min
  // left, the run had 21.7min — the old gate halted, 52s short of the
  // window deadline). The window's recovered deadline stays only as the
  // fallback when the node has none recorded.
  const pnj = readNode(projectDir, parentPath) || {};
  const nodeDl = pnj.deadline || null;
  const winSt = readJson(path.join(winDir, "pi-child-status.json")) || {};
  const monSt = readJson(path.join(winDir, "ralph-monitor-state.json")) || {};
  const winDl = winSt.deadlineIso || monSt.deadlineIso || winSt.deadline || null;
  const dlIso = nodeDl || winDl || null;
  const dlMs = dlIso ? Date.parse(dlIso) : NaN;
  if (!dlIso || Number.isNaN(dlMs)) {
    return haltBlocked(projectDir, parentPath, childWindowDir, log,
      `cannot recover the run's deadline (no deadline on the node and no deadlineIso in ${path.join(winDir, "pi-child-status.json")}) — human attention`, done);
  }
  // 1.3/3.2: the run may not re-activate if its deadline is spent — the SAME
  // rule launchWindow applies (single source of truth).
  const sized = sizeDeadline({ ts: new Date(dlMs), finalizeMin: Number(cfg.launch?.finalizeMin) || 10, now: new Date() });
  if (!sized.ok) {
    // v0.35.17 (7.8, run90 streak check): this reason string is human-facing
    // and IS PRINTED to the terminal (the launch notice, the final report's
    // halt context) — the terminal never shows ISO-8601. Local date+time here;
    // the machine-readable deadline stays ISO in the structured fields.
    return haltBlocked(projectDir, parentPath, childWindowDir, log,
      `child ${childPath} ended (${childState}); the run's deadline (${new Date(dlMs).toLocaleString("en-CA", { hour12: false })}) was reached (3.2) before hand-back — the run is over; the sub-run's report is on disk at ${childFinalDir}; start a fresh run (2.1) to continue`, done);
  }
  // ok:true — the budget IS available here (the sizing gate above just
  // rejected the no-budget case); without it budgetLine() renders the
  // "no remaining budget" fallback in RE-ENTRY.md (run35, 2026-11-09).
  const budget = { ok: true, deadlineMs: dlMs, deadlineIso: dlIso, minutes: Math.max(0, Math.round((dlMs - Date.now()) / 60000)), remainingMs: Math.max(0, dlMs - Date.now()) };
  // the decision that launched THIS child lives in the PARENT's window that
  // carried the request (newest-first: a re-spawned child takes its latest)
  const decision = findSpawnDecision(projectDir, parentPath, childPath);
  // v0.30.0 (5.1/5.2/5.3): the parent's last session before the sub-run lives
  // in the re-activated window. Under the resume gate (Box2D rule) the re-entry
  // RESUMES it — the run continues with full context; over the gate, a fresh
  // session carrying the distilled brief (same run, same deadline).
  const gate = sessionGate(winDir, cfg);
  const brief = (wname) => briefReentry({
    nodePath: parentPath, window: wname, childPath, childState,
    childFinalDir, decision, budget, resume: gate.resume,
  });
  // The prior step already recorded its outcome — clear the marker (and the
  // consumed spawn request, else the final step re-spawns the same child)
  // BEFORE the launch, under the existing lock (stepCore). The re-activated
  // window's final termination then gets a fresh step.
  fs.rmSync(path.join(winDir, "chain-done.json"), { force: true });
  fs.rmSync(path.join(winDir, "spawn-request.json"), { force: true });
  const opened = await openWithRetryName({ projectDir, nodePath: parentPath, brief, budget, cfg, windowDir: childWindowDir, log, sessionRef: gate.resume ? gate.ref : null, targetWindowDir: winDir, briefFile: "RE-ENTRY.md" });
  if (!opened.ok) {
    // the child already ended; the parent just cannot be relaunched right now
    setNodeState(projectDir, parentPath, "blocked");
    appendState(projectDir, parentPath, `- [${new Date().toISOString()}] re-activation of ${spawnWin} failed: ${opened.error}`);
    return done({ next: "halted", reason: `re-activation launch failed: ${opened.error}` });
  }
  setNodeState(projectDir, parentPath, "active");
  appendState(projectDir, parentPath,
    `- [${new Date().toISOString()}] child ${childPath} ended (${childState}) — run ${spawnWin} re-activated (${gate.resume ? `resumed session ${gate.sizeMb.toFixed(1)}MB` : `fresh session — ${gate.why}`}); deadline unchanged (${dlIso})`);
  return done({ next: "reentry", node_path: parentPath, window: spawnWin, run_dir: winDir, deadline: dlIso, child: childPath, resumed: gate.resume });
}

function findSpawnDecision(projectDir, parentPath, childPath) {
  const pdir = nodeRunsDir(projectDir, parentPath);
  let ents = [];
  try { ents = fs.readdirSync(pdir, { withFileTypes: true }); } catch { return null; }
  const wins = ents.filter((e) => e.isDirectory() && isWindowName(e.name))
    .map((e) => e.name).sort((a, b) => windowNumber(b) - windowNumber(a));
  for (const w of wins) {
    const d = readJson(path.join(pdir, w, "spawn-decision.json"));
    if (d && d.node_path === childPath) return d;
  }
  return null;
}

// The window (name) whose spawn-decision.json launched childPath — the
// parent's last window before the sub-run, whose pi-child-status.json holds
// the session to resume (v0.30.0). Newest-first, same order as findSpawnDecision.
function findSpawnWindow(projectDir, parentPath, childPath) {
  const pdir = nodeRunsDir(projectDir, parentPath);
  let ents = [];
  try { ents = fs.readdirSync(pdir, { withFileTypes: true }); } catch { return null; }
  const wins = ents.filter((e) => e.isDirectory() && isWindowName(e.name))
    .map((e) => e.name).sort((a, b) => windowNumber(b) - windowNumber(a));
  for (const w of wins) {
    const d = readJson(path.join(pdir, w, "spawn-decision.json"));
    if (d && d.node_path === childPath) return w;
  }
  return null;
}

function haltBlocked(projectDir, nodePath, windowDir, log, reason, done) {
  setNodeState(projectDir, nodePath, "blocked");
  appendState(projectDir, nodePath, `- [${new Date().toISOString()}] window ${path.basename(windowDir)}: ${reason}`);
  clearActiveSlots(projectDir, windowDir);
  markRunHalted(projectDir, nodePath);
  return done({ next: "halted", reason });
}
// run4 fix (F5): a halt is the run's end state — the node says `blocked`, so
// the run's INDEX entry says `halted` too (before the fix, a pending
// spawn-request kept the entry `paused` forever while the node said blocked —
// three contradictory end states in one tree). Best effort.
function markRunHalted(projectDir, nodePath) {
  const runs = nodeRunsDir(projectDir, nodePath);
  if (!runs) return;
  let ents = [];
  try { ents = fs.readdirSync(runs, { withFileTypes: true }); } catch { return; }
  const win = ents.filter((e) => e.isDirectory() && isWindowName(e.name))
    .map((e) => e.name).sort((a, b) => windowNumber(b) - windowNumber(a))[0];
  if (!win) return;
  try {
    const idxPath = path.join(runs, "INDEX.json");
    let idx = readJson(idxPath);
    if (!idx || typeof idx !== "object" || !Array.isArray(idx.runs)) idx = { v: 1, updated: null, runs: [] };
    idx.updated = new Date().toISOString();
    const i = idx.runs.findIndex((r) => r.run === win);
    const entry = i >= 0 ? idx.runs[i] : { run: win, dir: path.join(runs, win) };
    entry.status = "halted";
    if (i >= 0) idx.runs[i] = entry; else idx.runs.push(entry);
    writeJson(idxPath, idx);
  } catch { /* best effort — the halt itself is the truth */ }
}

// The node's deadline (if any) has passed. Also ADOPTS the window's own
// deadline into the node while the node has none (the invariant start: from
// the second window on, the node's deadline is what caps the budgets).
function nodeDeadlineExpired(nj, projectDir, nodePath, windowDir) {
  let dl = nj?.deadline ?? null;
  if (!dl) {
    const st = readJson(path.join(windowDir, "pi-child-status.json"));
    dl = st?.deadlineIso || st?.deadline || null;
    if (dl) {
      const n2 = readNode(projectDir, nodePath);
      const p2 = nodeJsonAt(projectDir, nodePath);
      if (n2 && p2 && !n2.deadline) writeJson(p2, { ...n2, deadline: String(dl) });
    }
  }
  if (!dl) return false; // no deadline anywhere — never "expired"
  const d = new Date(dl);
  return Number.isFinite(d.getTime()) && d.getTime() <= Date.now();
}

// ---------- spawn request handling (plan §5.3.4) ------------------------------
async function processSpawnRequest(projectDir, parentNodePath2, windowDir, req, cfg, log) {
  const fail = (reason) => {
    log(`spawn decision: REJECTED — ${reason}`);
    return { ok: false, reason, node: req?.node ?? null, at: new Date().toISOString() };
  };
  if (!req || req.kind !== "spawn") return fail("malformed request (kind != spawn)");
  const nm = String(req.node || "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(nm)) return fail(`bad node name "${nm}"`);
  if (/^run-?\d+$/i.test(nm)) return fail(`node name "${nm}" collides with the window names (run-N)`);
  const taskFile = String(req.task || "");
  let taskText = null;
  try {
    if (!taskFile || !fs.existsSync(taskFile)) return fail(`task file missing: ${taskFile || "(none)"}`);
    taskText = fs.readFileSync(taskFile, "utf8");
    if (!taskText.trim()) return fail(`task file is empty: ${taskFile}`);
  } catch (e) { return fail(`task file unreadable: ${e.message}`); }

  const parent = readNode(projectDir, parentNodePath2) || {};
  // the child's deadline ("inherit parent remaining"): the request's absolute
  // deadline, else the parent node's (invariant) deadline, else the parent
  // window's own deadline (its remaining budget), else runtime-bounded from now.
  let childDeadline = req.deadline ? String(req.deadline) : (parent.deadline ?? null);
  if (!childDeadline) {
    const pst = readJson(path.join(windowDir, "pi-child-status.json"));
    childDeadline = pst?.deadlineIso || pst?.deadline || null;
  }
  if (!childDeadline && req.runtime_min) {
    childDeadline = new Date(Date.now() + Number(req.runtime_min) * 60000).toISOString();
  }
  const full = parentNodePath2 === ROOT ? nm : `${parentNodePath2}/${nm}`;

  // plan §4: the sub-run IS a project — P/<name>/ with its own
  // .pi-supervisor, its own TASK.md at the project root, next to the code.
  const pof = projectOfNode(projectDir, parentNodePath2);
  const parentProj = pof.dir || projectDir;
  const njParent = readJson(supNodePath(parentProj)) || {};
  const existing = (Array.isArray(njParent.children) ? njParent.children : []).find((c) => c && c.name === nm);
  if (existing && !fs.existsSync(path.join(parentProj, String(existing.dir)))) {
    commitDetached(parentProj, nm);
    return fail(`"${nm}" is detached (its dir ${existing.dir} is not found — moved?) — point the registry at the new location or clear the line; not re-creating silently`);
  }
  const subDir = path.join(parentProj, nm);
  const snjPath = supNodePath(subDir);
  const snj = readJson(snjPath);
  // The effective deadline: the node's own once it exists (the invariant —
  // set at join/create, never moves), else the request's. Validated BEFORE
  // any side effects: a rejected spawn must not leave partial state behind.
  const nodeDeadline = (snj ? snj.deadline : null) ?? childDeadline;
  const b = windowBudget({ nodeDeadline, runtimeMin: req.runtime_min ?? null, now: new Date() });
  if (!b.ok) {
    if (b.expired) {
      return fail(`deadline expired: ${b.why}${snj?.deadline ? ` — node "${nm}" holds deadline ${snj.deadline} (invariant, set at join/create — never moves), so the request's deadline (${childDeadline ?? "none"}) was ignored. Re-spawn under a fresh name or move the sub-project aside` : ""}`);
    }
    return fail(`cannot size window 1: ${b.why} — pass --deadline or --runtime to the spawn`);
  }
  // v0.29.2 (run34): the SAME rule launch.mjs applies at its wall clock —
  // sizeDeadline() needs strictly more work minutes than the finalize
  // reservation. Enforced HERE, before the sub-project scaffolding exists, so
  // an infeasible-by-sizing request rejects with NO partial state. run34:
  // --runtime 10 sized a 10min window; launch reserved 10min for finalization
  // and rejected — after the node was already registered.
  {
    const finalizeMin = Number(cfg?.launch?.finalizeMin) || 10;
    const sized = sizeDeadline({ ts: new Date(b.deadlineMs), finalizeMin, now: new Date() });
    if (!sized.ok) {
      return fail(`${sized.why} — re-request with a larger --runtime or a later --deadline`);
    }
  }
  fs.mkdirSync(path.join(subDir, ".pi-supervisor", "runs"), { recursive: true });
  fs.writeFileSync(path.join(subDir, "TASK.md"), taskText); // the sub-project's task file
  grantChildAccess(path.join(subDir, "TASK.md"));
  ensureStateMdAt(path.join(subDir, "STATE.md"), nm);
  if (!snj) {
    // parent = the parent node's path ("(root)" for a top-level sub-project
    // — plan §4.2). Live children therefore read parent != null; only the
    // one-time standalone demotion (a moved tree) writes null, which is
    // exactly the signal ralph.sh's up-front spawn refusal keys on.
    writeJson(snjPath, { v: 2, name: nm, path: full, parent: parentNodePath2, deadline: childDeadline, state: "active", children: [], createdAt: new Date().toISOString() });
  } else if (childDeadline && !snj.deadline) {
    snj.deadline = childDeadline;
    writeJson(snjPath, snj);
  }
  registerChild(parentProj, nm, nm, { parentPath: parentNodePath2 });
  const cdir = nodeRunsDir(projectDir, full);

  // A join (the node already has windows) gets a continuation-style brief
  // (previous report + unchanged task); a fresh node gets the sub brief.
  const prevWins = listWindows(cdir);
  const brief = prevWins.length
    ? (wname) => briefContinuation({ nodePath: full, window: wname, prevWindowDir: path.join(cdir, prevWins[prevWins.length - 1]), budget: b })
      + `\n## Task (the node's task file, unchanged)\n\n\`\`\`\n${taskText.trim()}\n\`\`\`\n`
    : (wname) => briefSub({ nodePath: full, taskText, budget: b });
  // launch via the shared opener (alloc + brief + launch; failure = blocked marker)
  const dec = await openChildWindow(projectDir, full, brief, b, cfg, windowDir, log, full);
  if (dec.ok) {
    // run4 fix (F3, V5): the spawn RECEIPT flags the sub's budget vs the PARENT
    // WINDOW's remaining — the sub can legally out-run the parent window
    // (early-finish sub-runs are common; run4's finished in 62 s), but if it
    // uses its full budget the hand-back lands after the parent's hard stop:
    // the window is dead (changed supervision topology) and, pre-F1, the run
    // would have ended (3.2). Informational post-F1 (the re-entry gate sizes
    // against the run's deadline) — the judge and the monitor still plan
    // around the window's hard stop.
    try {
      const pst = readJson(path.join(windowDir, "pi-child-status.json")) || {};
      const pwDl = pst.deadlineIso || pst.deadline || null;
      const pwMs = pwDl ? Date.parse(pwDl) : NaN;
      const subMs = Date.parse(dec.deadline);
      if (!Number.isNaN(pwMs) && !Number.isNaN(subMs) && subMs > pwMs) {
        const rem = pwMs - Date.now();
        const remTxt = rem > 0 ? `${Math.floor(rem / 60000)}m ${Math.floor((rem % 60000) / 1000)}s` : "0s";
        dec.warn = `WARN: sub runtime exceeds the parent window's remaining (${remTxt}) — if the sub-run uses its full budget, the hand-back lands after the parent's hard stop (${pwDl}) and the run ends (3.2); pass a smaller --runtime to keep re-entry inside the window`;
      }
    } catch { /* receipt note is best effort */ }
  }
  return dec;
}

// (openChildWindow = openWithRetryName with the decision shape on success)
async function openChildWindow(projectDir, nodePath, brief, budget, cfg, windowDir, log, childPath) {
  const opened = await openWithRetryName({ projectDir, nodePath, brief, budget, cfg, windowDir, log });
  if (!opened.ok) {
    // v0.29.2 (run34): the sub-project exists now (TASK.md, STATE.md,
    // node.json, the registry line) but its first window never launched —
    // the node says blocked, not active. A re-spawn under the same name
    // joins this node (a fresh window); removing the dir + registry line
    // frees the name.
    try { setNodeState(projectDir, nodePath, "blocked"); } catch { /* best effort */ }
    return { ok: false, reason: `launch failed: ${opened.error}`, node: childName(nodePath), at: new Date().toISOString() };
  }
  setNodeState(projectDir, nodePath, "active");
  const parent = parentNodePath(nodePath);
  if (parent) {
    setNodeState(projectDir, parent, `paused(waiting:${childName(nodePath)})`);
    appendState(projectDir, parent,
      `- [${new Date().toISOString()}] child ${childName(nodePath)} spawned — window ${opened.window} launched (deadline ${new Date(budget.deadlineMs).toISOString()}); parent paused`);
  }
  // v0.35.14 (7.8): file keeps ISO; terminal gets the local deadline.
  log(
    `spawn decision: OK — ${nodePath}/${opened.window} launched (deadline ${new Date(budget.deadlineMs).toISOString()})`,
    `spawn decision: OK — ${nodePath}/${opened.window} launched (deadline ${new Date(budget.deadlineMs).toLocaleString("en-CA", { hour12: false })})`
  );
  return {
    ok: true,
    node: childName(nodePath),
    node_path: nodePath,
    window: opened.window,
    run_dir: opened.dir,
    deadline: new Date(budget.deadlineMs).toISOString(),
    at: new Date().toISOString(),
  };
}
