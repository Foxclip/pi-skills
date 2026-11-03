// lib/chain.mjs — the window-end chain step (v0.26.0).
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
  nodeDir,
  nodePathOf,
  parentNodePath,
  childName,
  readJson,
  writeJson,
  readNode,
  ensureNode,
  allocWindow,
  listWindows,
  newestWindow,
  pidAlive,
  clearActive,
  windowBudget,
  withLock,
} from "./node.mjs";

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
    fs.appendFileSync(path.join(windowDir, "chain.log"), `${ts} ${line}\n`);
  } catch { /* best effort — the marker + decision files are the record */ }
}

// ---------- classification --------------------------------------------------
// The window's terminal kind — the row of the §5.3 table.
//   guard-driven (cfg.repair falsy): the guard's own fresh outcome is truth.
//   repair (cfg.repair true): the guard is dead; FINAL-REPORT.md (written by
//     the monitor's STOP judgment) is the "completed" marker; a stale
//     running/absent status = user stop or reboot → "stopped" (halt; a human
//     decides whether to continue — never auto-relaunch over user intent).
export function classifyWindow(projectDir, windowDir, st, hasFinalReport, repair) {
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
  L.push("- Work the task; update this node's STATE.md (in your node folder, one up) at every milestone — it is the distillation the next window reads.");
  L.push("- To start your own sub-project: write its task file, run `ralph.sh spawn --name <node> --task <file> [--deadline <t>] [--runtime <m>]`, then END THE TURN cleanly. You will be paused and re-entered later. Direct launches are denied for child sessions.");
  L.push("- When the task is done: end with a final report (the standard contract's report protocol) — the chain reads it when it re-enters your parent.");
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
  L.push("1. Read the previous report and the node's STATE.md (in your node folder, one up).");
  L.push("2. Continue the remaining work — pick up where it stopped.");
  L.push("3. Keep STATE.md current; end with the standard final report when the goal is met (or when this budget runs out — the next window continues).");
  L.push("");
  return L.join("\n");
}

// Re-entry — the parent node resumes after a child node ended (done or
// deadline-expired). A bookkeeping turn, not a work turn.
function briefReentry({ nodePath, window, childPath, childState, childFinalDir, decision, budget }) {
  const L = [];
  L.push(`# RE-ENTRY — ${nodePath} / ${window}`);
  L.push("");
  L.push(`The child node \`${childPath}\` has ended (state: ${childState}). This is a BOOKKEEPING window: read, distill, decide. Do not start new work here.`);
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
  L.push("3. Do not start new work in this window.");
  L.push("");
  return L.join("\n");
}

// ---------- node state bookkeeping -------------------------------------------
function setNodeState(projectDir, nodePath, state) {
  const nj = readNode(projectDir, nodePath);
  if (!nj) return;
  nj.state = state;
  writeJson(path.join(nodeDir(projectDir, nodePath), "node.json"), nj);
}

function appendState(projectDir, nodePath, lines) {
  const sp = path.join(nodeDir(projectDir, nodePath), "STATE.md");
  fs.appendFileSync(sp, "\n" + lines + "\n");
}

// ---------- launch ------------------------------------------------------------
// Launch a window through launch.mjs (it writes active.json, the PI_SUP_* env,
// the guard detached). Synchronous: the chain must know before it records the
// outcome. Returns { ok, error, launchOut }.
function launchWindow(projectDir, nodePath, wdir, budget, cfg, windowDir, log) {
  const L = cfg.launch || {};
  const args = [
    LAUNCH,
    "--task-file", path.join(wdir, "TASK.md"),
    "--out-dir", wdir,
    "--project", projectDir,
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
  log(`launch: node=${nodePath || ROOT} window=${path.basename(wdir)} deadline=${new Date(budget.deadlineMs).toISOString()}`);
  let r;
  try {
    r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 180000 });
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
export async function step(projectDir, windowDir, cfg = {}) {
  const marker = path.join(windowDir, "chain-done.json");
  if (fs.existsSync(marker)) return { skipped: "chain-done" };
  const nodePath = nodePathOf(projectDir, path.dirname(windowDir)) || ROOT;
  const log = (line) => {
    clog(projectDir, windowDir, line);
    if (typeof cfg.log === "function") { try { cfg.log(line); } catch { /* sink must not kill the chain */ } }
  };
  return withLock(projectDir, async () => {
    if (fs.existsSync(marker)) return { skipped: "chain-done" }; // re-check under the lock
    const st = readJson(path.join(windowDir, "pi-child-status.json"));
    const hasFinal = fs.existsSync(path.join(windowDir, "FINAL-REPORT.md"));
    const kind = classifyWindow(projectDir, windowDir, st, hasFinal, Boolean(cfg.repair));
    log(`step start: window=${path.basename(windowDir)} node=${nodePath} kind=${kind} repair=${Boolean(cfg.repair)}`);

    const done = (outcome) => {
      const rec = { v: 1, at: new Date().toISOString(), kind, outcome };
      writeJson(marker, rec);
      log(`step done: outcome=${outcome.next || "halted"}${outcome.node_path ? ` next=${outcome.node_path}/${outcome.window}` : ""}`);
      return { kind, outcome };
    };

    // ensureNode materializes the node lazily (root included — back-compat:
    // a project without node.json works as today, the root appears on first step)
    const { node: nj } = ensureNode(projectDir, nodePath, {});

    // ---- 1) stopped (user stop / reboot — repair path): halt, no auto-next
    if (kind === "stopped") {
      setNodeState(projectDir, nodePath, "stopped");
      appendState(projectDir, nodePath,
        `- [${new Date().toISOString()}] window ${path.basename(windowDir)} ended externally (user stop / reboot) — chain halted; continue only on explicit relaunch`);
      clearActive(projectDir);
      return done({ next: "halted", reason: "stopped" });
    }

    // ---- 2) harvest (idempotent, never throws)
    harvest(windowDir);

    // ---- 3) spawn request — the child's last durable intent. Honored even
    // if the window ended by error, as long as the request is valid (plan §5.3.4).
    const reqPath = path.join(windowDir, "spawn-request.json");
    if (fs.existsSync(reqPath)) {
      const req = readJson(reqPath);
      const decision = await processSpawnRequest(projectDir, nodePath, windowDir, req, cfg, log);
      writeJson(path.join(windowDir, "spawn-decision.json"), decision);
      if (decision.ok) {
        return done({ next: "spawned", node_path: decision.node_path, window: decision.window, run_dir: decision.run_dir, deadline: decision.deadline });
      }
      log(`spawn request rejected: ${decision.reason} — falling through to the terminal table`);
    }

    // ---- 4) the terminal table (no request, or an invalid one)
    const parent = parentNodePath(nodePath);
    const parentName = parent === null ? null : parent; // root has no parent
    const isRoot = parentName === null;

    if (kind === "completed") {
      setNodeState(projectDir, nodePath, "done");
      appendState(projectDir, nodePath,
        `- [${new Date().toISOString()}] window ${path.basename(windowDir)} completed — node done`);
      if (isRoot) { clearActive(projectDir); return done({ next: "idle", reason: "root-done" }); }
      return await reentry(parentName, projectDir, nodePath, windowDir, cfg, log, "done", (o) => done(o));
    }

    if (kind === "budget-used") {
      const expired = nodeDeadlineExpired(nj, projectDir, nodePath, windowDir);
      if (expired) {
        setNodeState(projectDir, nodePath, "deadline-expired");
        appendState(projectDir, nodePath,
          `- [${new Date().toISOString()}] window ${path.basename(windowDir)} used its budget and the node deadline has passed — deadline-expired`);
        if (isRoot) { clearActive(projectDir); return done({ next: "idle", reason: "root-deadline-expired" }); }
        return await reentry(parentName, projectDir, nodePath, windowDir, cfg, log, "deadline-expired", (o) => done(o));
      }
      // continuation of the same node
      const b = windowBudget({ nodeDeadline: nj.deadline, runtimeMin: cfg.launch?.runtimeMin ?? 90, now: new Date() });
      if (!b.ok) { return haltBlocked(projectDir, nodePath, windowDir, log, `cannot size the continuation budget: ${b.why}`, (o) => done(o)); }
      const prevReport = windowFinalReport(windowDir);
      const brief = (wname) => briefContinuation({ nodePath, window: wname, prevWindowDir: windowDir, budget: b });
      const opened = await openWithRetryName({ projectDir, nodePath, brief, budget: b, cfg, windowDir, log });
      if (!opened.ok) { return haltBlocked(projectDir, nodePath, windowDir, log, `continuation launch failed: ${opened.error}`, (o) => done(o)); }
      setNodeState(projectDir, nodePath, "active");
      appendState(projectDir, nodePath,
        `- [${new Date().toISOString()}] window ${path.basename(windowDir)} used its budget — continuation ${opened.window} launched (deadline ${new Date(b.deadlineMs).toISOString()})`);
      return done({ next: "continuation", node_path: nodePath, window: opened.window, run_dir: opened.dir, deadline: new Date(b.deadlineMs).toISOString() });
    }

    // blocked (stuck / consult / error / aborted)
    return haltBlocked(projectDir, nodePath, windowDir, log, `window ended ${st?.exitReason || st?.status || "unclassified"} — human attention needed`, (o) => done(o));
  });
}

// Allocate a window, write its brief (a function of the window name, so the
// header names its own window), launch. On launch failure: remove the freshly
// allocated window dir (no process could have started from it) so the number
// is not burned, and leave NO chain-done marker (retryable via repair).
async function openWithRetryName({ projectDir, nodePath, brief, budget, cfg, windowDir, log }) {
  const { window, dir: wdir } = allocWindow(projectDir, nodePath);
  fs.writeFileSync(path.join(wdir, "TASK.md"), brief(window));
  const r = launchWindow(projectDir, nodePath, wdir, budget, cfg, windowDir, log);
  if (!r.ok) {
    clog(projectDir, windowDir, `launch FAILED for ${nodePath}/${window}: ${r.error} — window dir removed (caller records the blocked outcome)`);
    try { fs.rmSync(wdir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, error: r.error };
  }
  return { ok: true, window, dir: wdir, launchOut: r.launchOut };
}

async function reentry(parentPath, projectDir, childPath, childWindowDir, cfg, log, childState, done) {
  const pnj = readNode(projectDir, parentPath);
  // the child's final window (its report is the re-entry's input)
  const childNodeDir = nodeDir(projectDir, childPath);
  const childFinalDir = path.join(childNodeDir, newestWindow(childNodeDir) || "run-1");
  // the spawn decision lives in the child's window that carries it (the window
  // that wrote the request is the child node's own window 1 — but a re-spawned
  // node may have later decisions; newest-first scan)
  const decision = findChildDecision(childNodeDir);
  void childWindowDir; // kept in the signature for the log trail
  const b = windowBudget({ nodeDeadline: pnj?.deadline ?? null, runtimeMin: cfg.launch?.runtimeMin ?? 90, now: new Date() });
  if (!b.ok) return haltBlocked(projectDir, parentPath, childWindowDir, log, `cannot size the re-entry budget for ${parentPath}: ${b.why}`, done);
  const brief = (wname) => briefReentry({
    nodePath: parentPath, window: wname, childPath, childState,
    childFinalDir, decision, budget: b,
  });
  const opened = await openWithRetryName({ projectDir, nodePath: parentPath, brief, budget: b, cfg, windowDir: childWindowDir, log });
  if (!opened.ok) {
    // the child already ended; the parent just cannot be relaunched right now
    setNodeState(projectDir, parentPath, "blocked");
    appendState(projectDir, parentPath, `- [${new Date().toISOString()}] re-entry launch failed: ${opened.error}`);
    return done({ next: "halted", reason: `reentry-launch-failed: ${opened.error}` });
  }
  setNodeState(projectDir, parentPath, "active");
  appendState(projectDir, parentPath,
    `- [${new Date().toISOString()}] child ${childPath} ended (${childState}) — re-entry ${opened.window} launched (deadline ${new Date(b.deadlineMs).toISOString()})`);
  return done({ next: "reentry", node_path: parentPath, window: opened.window, run_dir: opened.dir, deadline: new Date(b.deadlineMs).toISOString(), child: childPath });
}

function findChildDecision(childNodeDir) {
  let ents = [];
  try { ents = fs.readdirSync(childNodeDir, { withFileTypes: true }); } catch { return null; }
  const wins = ents.filter((e) => e.isDirectory() && /^run-\d+$/.test(e.name))
    .map((e) => e.name).sort((a, b) => Number(b.slice(4)) - Number(a.slice(4)));
  for (const w of wins) {
    const d = readJson(path.join(childNodeDir, w, "spawn-decision.json"));
    if (d) return d;
  }
  return null;
}

function haltBlocked(projectDir, nodePath, windowDir, log, reason, done) {
  setNodeState(projectDir, nodePath, "blocked");
  appendState(projectDir, nodePath, `- [${new Date().toISOString()}] window ${path.basename(windowDir)}: ${reason}`);
  clearActive(projectDir);
  return done({ next: "halted", reason });
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
      if (n2 && !n2.deadline) writeJson(path.join(nodeDir(projectDir, nodePath), "node.json"), { ...n2, deadline: String(dl) });
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
  if (/^run-\d+$/i.test(nm)) return fail(`node name "${nm}" collides with the window names (run-N)`);
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

  const { node: cnj, dir: cdir } = ensureNode(projectDir, full, { deadline: childDeadline });
  fs.writeFileSync(path.join(cdir, "task.md"), taskText); // the node's persistent sub-task

  const b = windowBudget({ nodeDeadline: cnj.deadline, runtimeMin: req.runtime_min ?? null, now: new Date() });
  if (!b.ok) {
    if (b.expired) return fail(`deadline expired: ${b.why}`);
    return fail(`cannot size window 1: ${b.why} — pass --deadline or --runtime to the spawn`);
  }

  // A join (the node already has windows) gets a continuation-style brief
  // (previous report + unchanged task); a fresh node gets the sub brief.
  const prevWins = listWindows(cdir);
  const brief = prevWins.length
    ? (wname) => briefContinuation({ nodePath: full, window: wname, prevWindowDir: path.join(cdir, prevWins[prevWins.length - 1]), budget: b })
      + `\n## Task (the node's task file, unchanged)\n\n\`\`\`\n${taskText.trim()}\n\`\`\`\n`
    : (wname) => briefSub({ nodePath: full, taskText, budget: b });
  // launch via the shared opener (alloc + brief + launch; failure = blocked marker)
  return openChildWindow(projectDir, full, brief, b, cfg, windowDir, log, full);
}

// (openChildWindow = openWithRetryName with the decision shape on success)
async function openChildWindow(projectDir, nodePath, brief, budget, cfg, windowDir, log, childPath) {
  const opened = await openWithRetryName({ projectDir, nodePath, brief, budget, cfg, windowDir, log });
  if (!opened.ok) {
    return { ok: false, reason: `launch failed: ${opened.error}`, node: childName(nodePath), at: new Date().toISOString() };
  }
  setNodeState(projectDir, nodePath, "active");
  const parent = parentNodePath(nodePath);
  if (parent) {
    setNodeState(projectDir, parent, `paused(waiting:${childName(nodePath)})`);
    appendState(projectDir, parent,
      `- [${new Date().toISOString()}] child ${childName(nodePath)} spawned — window ${opened.window} launched (deadline ${new Date(budget.deadlineMs).toISOString()}); parent paused`);
  }
  log(`spawn decision: OK — ${nodePath}/${opened.window} launched (deadline ${new Date(budget.deadlineMs).toISOString()})`);
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
