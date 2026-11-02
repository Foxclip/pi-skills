#!/usr/bin/env node
// ralph-monitor.mjs — v0.24.3: the parent as a ralph loop.
//
// A long-lived goal-mode parent session is fragile: one 400 "model not
// running" (shared local model pool) or one context overflow wedges the whole
// supervision (BlockGame6 2026-11-01: parent goal blocked, child kept going
// unmonitored). This script replaces the parent session with an outer loop:
// the SCHEDULE lives in the shell, every LLM turn is a fresh bounded
// `pi --print` cycle, and all memory is on disk. A dead model now kills one
// iteration (logged, retried next cycle) instead of the job.
//
// Per cycle:
//   1. PRE-CHECKS (no LLM, deterministic):
//        deadline reached            → exit 4
//        status terminal (completed) → exit 0 (5 if the child failed)
//        guard pid dead / status stale (running) → exit 2
//        no toolCalls growth for --stuck-sec     → exit 4 (stalled)
//        interventions budget exhausted          → exit 4
//   2. LLM: one `pi --print --no-session` turn (fresh each cycle by default;
//      pass --session <file> to let pi resume a persistent monitor session)
//      with the monitor contract. The final output line must be:
//        DECISION: OK
//        DECISION: NUDGE: <message delivered to the child>
//        DECISION: STOP: <reason>
//      Missing/unknown line → OK (safe default: no action).
//      pi itself failing (model 400, timeout) → logged, counted in
//      llmFailStreak, loop CONTINUES (this is the anti-wedge behavior);
//      --llm-fail-max (default 6) consecutive failures → exit 4.
//   3. ACT: NUDGE is delivered through monitor.mjs --steer (the v0.17.0
//      parent-nudge channel — same .steer-inbox/ mechanics, tested there).
//   4. SLEEP to the next cycle boundary.
//
// Disk state (run dir):
//   ralph-monitor-state.json  loop-owned: cycles, interventions, lastToolCalls,
//                             lastProgressAt, lastDecision, llmFailStreak
//   ralph-monitor.log         one line per cycle + pre-check exits
//
// Exit codes:
//   0 child completed (exitReason=completed)
//   2 child dead: guard pid gone or status stale while running
//   4 loop gave up: deadline / stall / budget / llm-down / LLM said STOP
//   5 child terminal with a failure exitReason
//   1 usage error, 130 SIGINT
//
// Usage:
//   node ralph-monitor.mjs --run-dir <dir> --pi <path>
//     [--project-dir <dir>] [--model <spec>] [--provider <spec>]
//     [--session <file|id>] [--cycle-sec 1200] [--max-interventions 3]
//     [--stuck-sec 3600] [--stale-sec 180] [--deadline <ISO|epoch|HH:MM>]
//     [--max-hours 12] [--llm-fail-max 6] [--timeout-sec 600]
//     [--prompt-file <p>] [--log-file <p>] [--once] [--dry-run]
//   --once    run a single cycle (pre-check + one LLM turn + act) and exit 0.
//   --dry-run pre-checks + state update only; no LLM call (prints the view).

import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeadline } from "./lib/deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

function usage() {
  return "usage: ralph-monitor.mjs --run-dir <dir> --pi <path> [--project-dir <d>] [--model <s>] [--provider <s>] [--session <f|id>] [--cycle-sec 1200] [--max-interventions 3] [--stuck-sec 3600] [--stale-sec 180] [--deadline <ISO|epoch|HH:MM>] [--max-hours 12] [--llm-fail-max 6] [--timeout-sec 600] [--prompt-file <p>] [--log-file <p>] [--once] [--dry-run]";
}

// ---- args
const argv = process.argv.slice(2);
const num = (s) => { const n = Number(s); if (!Number.isFinite(n)) { console.error(`bad number: ${s}`); process.exit(1); } return n; };
const A = {
  runDir: null, pi: null, projectDir: null, model: null, provider: null, session: null,
  cycleSec: 1200, maxInterventions: 3, stuckSec: 3600, staleSec: 180,
  deadline: null, maxHours: 12, llmFailMax: 6, timeoutSec: 600, finalizeGraceSec: 900,
  promptFile: null, logFile: null, once: false, dryRun: false,
};
for (let i = 0; i < argv.length; i++) {
  const x = argv[i];
  if (x === "--run-dir") A.runDir = argv[++i];
  else if (x === "--pi") A.pi = argv[++i];
  else if (x === "--project-dir") A.projectDir = argv[++i];
  else if (x === "--model") A.model = argv[++i];
  else if (x === "--provider") A.provider = argv[++i];
  else if (x === "--session") A.session = argv[++i];
  else if (x === "--cycle-sec") A.cycleSec = num(argv[++i]);
  else if (x === "--max-interventions") A.maxInterventions = num(argv[++i]);
  else if (x === "--stuck-sec") A.stuckSec = num(argv[++i]);
  else if (x === "--stale-sec") A.staleSec = num(argv[++i]);
  else if (x === "--deadline") A.deadline = argv[++i];
  else if (x === "--finalize-grace-sec") A.finalizeGraceSec = num(argv[++i]);
  else if (x === "--max-hours") A.maxHours = num(argv[++i]);
  else if (x === "--llm-fail-max") A.llmFailMax = num(argv[++i]);
  else if (x === "--timeout-sec") A.timeoutSec = num(argv[++i]);
  else if (x === "--prompt-file") A.promptFile = argv[++i];
  else if (x === "--log-file") A.logFile = argv[++i];
  else if (x === "--once") A.once = true;
  else if (x === "--dry-run") A.dryRun = true;
  else { console.error(usage()); process.exit(1); }
}
if (!A.runDir || !A.pi) { console.error(usage()); process.exit(1); }
if (!existsSync(A.runDir)) { console.error(`run dir not found: ${A.runDir}`); process.exit(1); }

// deadline: explicit --deadline wins; else now + --max-hours
let deadlineMs = null;
if (A.deadline !== null) {
  const d = parseDeadline(A.deadline);
  if (!d.ok) { console.error(`bad --deadline: ${d.why}`); process.exit(1); }
  deadlineMs = d.ts.getTime();
} else if (A.maxHours > 0) {
  deadlineMs = Date.now() + A.maxHours * 3600_000;
}

// ---- state + log
const statePath = path.join(A.runDir, "ralph-monitor-state.json");
const logPath = A.logFile || path.join(A.runDir, "ralph-monitor.log");
let state = null;
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first cycle */ }
state = state || {
  startedAt: new Date().toISOString(), cycles: 0, interventions: 0,
  lastToolCalls: -1, lastProgressAt: new Date().toISOString(),
  lastDecision: null, llmFailStreak: 0,
};
const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
// v0.21.0 terminal design (terminal is human-facing, files are machine-facing —
// ralph-monitor.log's format is UNCHANGED: `[iso] cycle=N decision=...`):
//   terminal: dim short local-ts [HH:MM:SS], one scannable line per cycle,
//   verdict glyphs, colored when stderr is a tty (NO_COLOR respected),
//   reasoning in dim type under each cycle. Files: full ISO-8601 UTC, everything.
const tsLocalShort = (d) => { const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
const flog = (line) => appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
const tty = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const C = (code) => (tty ? `\x1b[${code}m` : "");
const tlog = (line) => process.stderr.write(line + "\n");
const log = (line) => { flog(line); tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${line}`); };
// v0.24.0: glyphed terminal line — the FILE line stays plain (the log's format
// contract: `[iso] ...`), the terminal line carries the shared status glyph
// (· info dim, ! warn yellow, ✓ success green, ✗ failure red), matching the
// tick/ask/beat lines and ralph.sh/harvest terminal lines
const glog = (glyph, color, line) => {
  flog(line);
  tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(color)}${glyph} ${line}${C(0)}`);
};
const tick = (n, verdict, detail, reasoning) => {
  const sym = verdict === "OK" ? `${C(32)}✓${C(0)}` : verdict === "NUDGE" ? `${C(33)}→${C(0)}` : `${C(31)}✗${C(0)}`;
  tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${sym} ${C(1)}cycle ${n} · ${verdict}${C(0)}${detail ? " — " + detail : ""}`);
  for (const line of (reasoning || "").split("\n")) tlog(`${C(2)}    ${line}${C(0)}`);
};
// "in progress" indicator (terminal only — the log file's format is unchanged):
// a parent LLM call can take a while, and without this the terminal looks frozen
const ask = (msg) => tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(36)}…${C(0)} ${C(2)}${msg}${C(0)}`);
// v0.21.2: child heartbeat — one dim line with the CHILD's live state.
// Without it the terminal only shows the parent's judgment lines and the run
// reads as if the parent were doing all the work.
// v0.24.2: the line fires on every toolCalls CHANGE (not every poll) — with
// the 5s poll a new tool call shows up within ~5s — plus a 60s fallback so
// the terminal still proves the child is alive between tool calls (thinking).
const humanLeft = (ms) => {
  let s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
};
const beat = (s) => {
  const tc = Number(s.toolCalls) || 0;
  const last = s.lastTool ? ` · last: ${s.lastTool}` : "";
  const left = deadlineMs !== null ? ` · ${humanLeft(deadlineMs - Date.now())} left` : "";
  tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(2)}·${C(0)} ${C(1)}child ${s.status}${C(0)}${C(2)} · ${tc} tool call${tc === 1 ? "" : "s"}${last}${left}${C(0)}`);
};
// v0.24.2: change-driven beats — print when toolCalls CHANGES, or at least
// once a minute (the "still alive, thinking" proof). First poll always beats.
let lastBeat = { tc: null, at: 0 };
const beatMaybe = (s) => {
  const tc = Number(s.toolCalls);
  const changed = Number.isFinite(tc) && (lastBeat.tc === null || tc !== lastBeat.tc);
  const overdue = Date.now() - lastBeat.at >= 60_000;
  if (!changed && !overdue) return;
  if (Number.isFinite(tc)) lastBeat.tc = tc;
  lastBeat.at = Date.now();
  beat(s);
};
process.on("SIGINT", () => { glog("!", 33, "sigint: stopping"); saveState(); process.exit(130); });

// ---- helpers
const pidAlive = (pid) => {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const readStatus = () => {
  try { return JSON.parse(readFileSync(path.join(A.runDir, "pi-child-status.json"), "utf8")); }
  catch { return null; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Async command runner: the event loop stays alive while the child runs, so
// SIGINT is handled promptly even mid-LLM-turn (a synchronous spawnSync would
// swallow signals arriving during the call — verified empirically in testing).
function runCmd(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    const finish = (extra) => { if (!done) { done = true; resolve({ ...extra }); } };
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL" });
    p.stdout.on("data", (d) => { stdout += d; if (stdout.length > 16 * 1024 * 1024) p.kill("SIGKILL"); });
    p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 16 * 1024 * 1024) p.kill("SIGKILL"); });
    p.on("error", (e) => finish({ status: null, signal: null, stdout, stderr, error: String(e) }));
    p.on("close", (status, signal) => finish({ status, signal, stdout, stderr }));
  });
}
// v0.23.0: judgment invocations are tracked so the deadline watcher can KILL a
// judgment stuck in the model queue (run4: the judgment burned its whole
// --timeout-sec budget behind the degenerate child while the loop — pre-checks
// included — was blind for the entire wait).
let judgmentProc = null;
async function runCmdTracked(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL" });
    judgmentProc = p;
    const finish = (extra) => { if (!done) { done = true; if (judgmentProc === p) judgmentProc = null; resolve({ ...extra }); } };
    p.stdout.on("data", (d) => { stdout += d; if (stdout.length > 16 * 1024 * 1024) p.kill("SIGKILL"); });
    p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 16 * 1024 * 1024) p.kill("SIGKILL"); });
    p.on("error", (e) => finish({ status: null, signal: null, stdout, stderr, error: String(e) }));
    p.on("close", (status, signal) => finish({ status, signal, stdout, stderr }));
  });
}

// ---- deterministic pre-checks (run before any LLM call)
function preCheck(status) {
  const now = Date.now();
  if (deadlineMs !== null && now >= deadlineMs) {
    // v0.23.0: the deadline is the CHILD's wall clock — the guard enforces it
    // (finalization window). If the child is still running, wait it out
    // (bounded by the grace cap) so the monitor exits with the run's TRUE
    // terminal state and the parent's final report runs AFTER the child is
    // dead (the model slot is free). run4: the old immediate exit skipped the
    // report entirely and orphaned the guard's window.
    const s0 = status && status.status;
    if (s0 === "completed") {
      const ok0 = /^completed/.test(status.exitReason || "");
      return { stop: true, code: ok0 ? 0 : 5, reason: `deadline: child-terminal (${status.exitReason || "completed"})` };
    }
    if (s0 === "stuck" || s0 === "failed" || s0 === "aborted")
      return { stop: true, code: 4, reason: `deadline: child-terminal (${s0})` };
    if (s0 === "running" || s0 === "starting") {
      if (now >= deadlineMs + A.finalizeGraceSec * 1000)
        return { stop: true, code: 4, reason: `deadline (child still running after ${A.finalizeGraceSec}s grace)` };
      return { stop: false, waiting: "child-finalizing" };
    }
    return { stop: true, code: 4, reason: "deadline" };
  }
  const s = status && status.status;
  if (s === "completed") {
    // the guard exits 0 for "completed" AND "completed-finalized" (the timeout
    // absorbed by the finalization window — the usual outcome of --deadline
    // launches), so both are success here too
    const ok = /^completed/.test(status.exitReason || "");
    return { stop: true, code: ok ? 0 : 5, reason: `child-terminal (${status.exitReason || "completed"})` };
  }
  if (s === "running" || s === "starting") {
    const at = Date.parse(status.at || "");
    const age = Number.isFinite(at) ? now - at : Infinity;
    if (s === "running") {
      const gp = Number(status.guardPid);
      if (gp > 0 && !pidAlive(gp) && age > 60_000)
        return { stop: true, code: 2, reason: `child-dead (guard pid ${gp} gone)` };
      if (age > A.staleSec * 1000)
        return { stop: true, code: 2, reason: `child-stale (no status update for ${Math.round(age / 1000)}s)` };
      // progress tracking for stall detection
      const tc = Number(status.toolCalls);
      if (Number.isFinite(tc) && tc > state.lastToolCalls) {
        state.lastToolCalls = tc;
        state.lastProgressAt = new Date(now).toISOString();
      }
      if (A.stuckSec > 0 && now - Date.parse(state.lastProgressAt || now) > A.stuckSec * 1000)
        return { stop: true, code: 4, reason: `stalled (no toolCalls growth for ${A.stuckSec}s)` };
    }
    if (state.interventions >= A.maxInterventions)
      return { stop: true, code: 4, reason: "budget (interventions exhausted)" };
  }
  return { stop: false };
}

// ---- the LLM turn (one fresh cycle)
const DEFAULT_PROMPT = `You are one cycle of a ralph-loop supervisor for a pi child agent run.
You are STATELESS: your only context is what you read from disk right now. Do not assume anything from a previous cycle — the loop keeps its memory in files, not in you.

Run directory: <run-dir>
<project-dir-line>

Read (budget: AT MOST 4 tool calls, use tail/jq — you are one cycle of many and
speed matters more than depth):
1. <run-dir>/pi-child-status.json     — live guard status (jq: status, toolCalls, lastTool)
2. <run-dir>/ralph-monitor.log        — tail -20 (previous cycle decisions)
3. <run-dir>/pi-child-progress.log    — tail -30 (what the child has been doing)
4. <project-dir>/STATUS.md or TASK.md — the child's own notes / the task (pick the one that helps)

The loop already checked deterministic health (deadline, guard liveness, staleness,
stall, intervention budget) and would have stopped itself if any failed. Being
asked means: the child is alive, fresh, and within budget. Judge the WORK, not the plumbing:
is the child making real progress on the task? Stuck repeating itself? Off-track?

Output format (STRICT): your final line must be exactly one of:
DECISION: OK
DECISION: NUDGE: <one-line message, specific, actionable, referencing what you saw>
DECISION: STOP: <one-line reason the run cannot succeed>
Any other final line is treated as OK. Do NOT end with anything after the DECISION line.`;

async function llmDecide() {
  const projectLine = A.projectDir
    ? `Project directory: ${A.projectDir} (the child's git repo / task workspace)`
    : "Project directory: unknown (find it via pi-child-status.json sessionFile or git in the run dir)";
  let prompt = A.promptFile ? readFileSync(A.promptFile, "utf8") : DEFAULT_PROMPT;
  prompt = prompt.replaceAll("<run-dir>", A.runDir)
    .replaceAll("<project-dir-line>", projectLine)
    .replaceAll("<cycle>", String(state.cycles + 1));
  const args = ["--print"];
  if (A.session) args.push("--session", A.session);
  else args.push("--no-session");
  if (A.model) args.push("--model", A.model);
  if (A.provider) args.push("--provider", A.provider);
  args.push(prompt);
  const r = await runCmdTracked(A.pi, args, A.timeoutSec * 1000);
  const out = ((r.stdout || "") + "\n" + (r.stderr || "")).trim();
  const tail = out.split("\n").filter(Boolean);
  let decision = "OK", detail = "", raw = "";
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(/^DECISION:\s*([A-Za-z]+)(?::\s*(.*))?$/);
    if (m) { raw = tail[i]; decision = m[1].toUpperCase(); detail = (m[2] || "").trim(); break; }
  }
  // text = the parent's full response (stdout only — stderr is noise for display)
  return { okExit: r.status === 0, decision, detail, raw, tail, text: (r.stdout || "").trim(), exitStatus: r.status === 0 ? 0 : (r.status ?? r.signal) };
}

// ---- final report (v0.20.0) — when the work ENDS, the parent (one fresh
// judgment-model turn) writes a summary of what was done to FINAL-REPORT.md.
// ralph.sh prints the file to the terminal when the monitor exits.
// Triggers: child completed, parent STOP decision, intervention budget
// exhausted. NOT on deadline/stale/stuck/child-dead (plumbing exits, not
// work outcomes) — and a failed report never changes the exit code.
const SUMMARY_PROMPT = `You are the final report writer for a ralph-supervised child run that has just ended.
End reason: <end-reason>

Run directory: <run-dir>
<project-dir-line>

Read (budget: AT MOST 4 tool calls, use tail — be fast):
1. <project-dir>/STATUS.md or TASK.md — the task and the child's own notes
2. <run-dir>/pi-child-progress.log — tail -60 (what the child has been doing)
3. <run-dir>/ralph-monitor.log — tail -40 (supervisor decisions)
4. <run-dir>/pi-child-status.json — the final status

Then print the final report as MARKDOWN. This IS your answer — print the report
to stdout and nothing else (no preamble, no DECISION line).

# Final report — <one line: what was asked → what happened>
## What was requested
## What was done
## Outcome
## Remaining
Keep it under ~40 lines. Facts about the work only — no apologies, no
meta-commentary about this report.`;

async function writeFinalReport(reason) {
  ask("final report — asking parent to summarize the run…");
  const projectLine = A.projectDir
    ? `Project directory: ${A.projectDir}`
    : "Project directory: unknown (check pi-child-status.json / git in the run dir)";
  const prompt = SUMMARY_PROMPT.replaceAll("<run-dir>", A.runDir)
    .replaceAll("<project-dir-line>", projectLine)
    .replaceAll("<end-reason>", reason);
  const args = ["--print", "--no-session"];   // fresh writer, never the judgment session
  if (A.model) args.push("--model", A.model);
  if (A.provider) args.push("--provider", A.provider);
  args.push(prompt);
  let r;
  try {
    const stopHb = heartbeat("final report — parent summarizing");   // v0.24.3
    try { r = await runCmd(A.pi, args, A.timeoutSec * 1000); } finally { stopHb(); }
  } catch (e) {
    glog("✗", 31, `final-report: FAILED (${e.message}) — skipping`);
    return null;
  }
  const text = (r.stdout || "").trim();
  if (r.status !== 0 || !text) {
    glog("✗", 31, `final-report: FAILED (exit=${r.status ?? r.signal}) — skipping`);
    return null;
  }
  const p = path.join(A.runDir, "FINAL-REPORT.md");
  try {
    writeFileSync(p, text + "\n");
    glog("✓", 32, `final-report: written (${text.length} chars) → ${p}`);
    return p;
  } catch (e) {
    glog("✗", 31, `final-report: write failed (${e.message})`);
    return null;
  }
}

async function deliverNudge(msg) {
  // reuse the v0.17.0 parent-nudge channel (monitor.mjs --steer → .steer-inbox/)
  const r = await runCmd(NODE, [
    path.join(HERE, "monitor.mjs"),
    "--status", path.join(A.runDir, "pi-child-status.json"),
    "--steer", msg,
  ], 30_000);
  const out = ((r.stdout || "").trim());
  try { const j = JSON.parse(out.split("\n").pop()); if (j && j.steer === false) return { ok: false, why: j.reason || "rejected" }; }
  catch { /* fall through to exit code */ }
  return { ok: r.status === 0, why: r.status === 0 ? "" : `steer exit ${r.status}: ${out.slice(0, 200)}` };
}

// ---- main loop
// Tight poll: the pre-checks (pure file reads, no LLM) run every POLL_SEC so a
// completed/stale/deadline child is noticed within ~5s, not up to one full
// cycle later. The 5s cadence is what lets the child heartbeat fire per tool
// call (v0.24.2). The LLM judgment still only runs every --cycle-sec.
const POLL_SEC = 5;
let lastJudgment = 0; // 0 = judgment due immediately
// v0.24.3: heartbeats for the waits where the loop BLOCKS on a long LLM call —
// without them the terminal goes silent for the whole call (run8: 8 minutes
// between '… asking parent for judgment…' and '✓ cycle 1 · OK', because the
// beat lines stop while the loop is blocked in llmDecide). One dim `…` line
// per RM_HEARTBEAT_SEC (default 60s) with the elapsed wait + the child's live
// state, read fresh from disk on every tick. Returns a stop function.
const HEARTBEAT_SEC = Math.max(1, Number(process.env.RM_HEARTBEAT_SEC) || 60);
const heartbeat = (label) => {
  const startedAt = Date.now();
  const iv = setInterval(() => {
    const el = Math.round((Date.now() - startedAt) / 1000);
    const s = readStatus();
    const tc = s && Number.isFinite(Number(s.toolCalls)) ? ` · ${s.toolCalls} tool calls` : "";
    const last = s && s.lastTool ? ` · last: ${s.lastTool}` : "";
    const child = s ? ` · child ${s.status}${tc}${last}` : "";
    const left = deadlineMs !== null ? ` · ${humanLeft(deadlineMs - Date.now())} left` : "";
    tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(36)}…${C(0)} ${C(2)}${label}${C(0)}${C(2)} · ${el}s${child}${left}${C(0)}`);
  }, HEARTBEAT_SEC * 1000);
  iv.unref?.();
  return () => clearInterval(iv);
};
let finalWaitAnnounced = false;   // v0.24.3: announce the finalization wait once
// v0.23.0: one stop path for all pre-check stops. The parent's final report
// also runs on deadline/stuck endings — that is exactly when the user needs
// the "what happened" answer, and the child is terminal here, so the model
// slot is free for the report (a failed report never changes the exit code).
async function stopLoop(pc) {
  glog(pc.code === 0 ? "✓" : "✗", pc.code === 0 ? 32 : 31,
    `pre-check STOP: ${pc.reason} (cycle=${state.cycles} interventions=${state.interventions})`);
  saveState();
  if (pc.code === 0 || pc.code === 4) await writeFinalReport(pc.reason);
  process.exit(pc.code);
}
(async () => {
for (;;) {
  const status = readStatus();
  const pc = preCheck(status);
  if (pc.stop) await stopLoop(pc);
  // v0.24.3: the grace-bounded finalization wait (deadline passed, child still
  // finishing its turn) was the last silent stretch — announce entry once; the
  // 60s child beats keep the wait visible until it ends.
  if (pc.waiting === "child-finalizing" && !finalWaitAnnounced) {
    finalWaitAnnounced = true;
    glog("…", 36, `deadline reached — waiting for the child to finalize (grace ${A.finalizeGraceSec}s)`);
  }
  if (status && status.status === "running") beatMaybe(status);
  const nowMs = Date.now();
  if (nowMs - lastJudgment < A.cycleSec * 1000 - 500) {
    await sleep(Math.min(POLL_SEC * 1000, Math.max(5000, A.cycleSec * 1000 - (nowMs - lastJudgment))));
    continue;
  }
  state.cycles += 1;
  state.lastCycleAt = new Date(nowMs).toISOString();
  lastJudgment = nowMs;

  if (A.dryRun) {
    glog("·", 2, `cycle=${state.cycles} dry-run: status=${status ? status.status : "absent"} toolCalls=${status ? status.toolCalls : "?"} — no LLM call`);
    saveState();
    if (A.once) process.exit(0);
  } else {
    ask(`cycle ${state.cycles} — asking parent for judgment…`);
    const stopHb = heartbeat(`cycle ${state.cycles} — parent judging`);   // v0.24.3
    // v0.23.0: race the judgment against the deadline — see runCmdTracked.
    let watcherDone = false;
    const watcher = (async () => {
      while (!watcherDone) {
        if (deadlineMs !== null && Date.now() >= deadlineMs) return "deadline";
        await sleep(5000);
      }
      return null;
    })();
    const raced = await Promise.race([llmDecide(), watcher]);
    watcherDone = true;
    stopHb();
    if (raced === "deadline") {
      if (judgmentProc) { try { judgmentProc.kill("SIGKILL"); } catch { /* best effort */ } }
      glog("!", 33, `cycle=${state.cycles} deadline passed while asking parent — judgment killed, handing off to the pre-checks`);
      saveState();
      continue;
    }
    const d = raced;
    if (!d.okExit) {
      // pi itself failed (model 400 "not running", crash, timeout): log and
      // RETRY next cycle — the loop never dies on one bad LLM call
      // (the anti-BlockGame6 behavior)
      state.llmFailStreak += 1;
      glog("!", 33, `cycle=${state.cycles} llm-failed (exit=${d.exitStatus} streak=${state.llmFailStreak}): ${(d.tail[d.tail.length - 1] || "").slice(0, 200)}`);
      saveState();
      if (A.once) process.exit(4);
      if (state.llmFailStreak >= A.llmFailMax) {
        glog("✗", 31, `llm-down: ${state.llmFailStreak} consecutive failed cycles — giving up`);
        process.exit(4);
      }
    } else if (d.raw === "") {
      // pi exited 0 but printed nothing: suspicious — count as a failed cycle
      state.llmFailStreak += 1;
      glog("!", 33, `cycle=${state.cycles} llm-empty (streak=${state.llmFailStreak}) — no output at all`);
      saveState();
      if (A.once) process.exit(4);
      if (state.llmFailStreak >= A.llmFailMax) {
        glog("✗", 31, `llm-down: ${state.llmFailStreak} consecutive empty cycles — giving up`);
        process.exit(4);
      }
    } else {
      state.llmFailStreak = 0;
      // v0.21.0: the FULL reasoning goes to ralph-monitor.log (the permanent
      // record — format unchanged); the terminal gets a scannable tick line
      // plus the reasoning in dim type.
      if (d.text) flog(`cycle=${state.cycles} parent:\n${d.text}`);
      // a judgment whose final line was not DECISION: — treat as OK, log the anomaly
      const wasBadLine = !/^DECISION:\s*(OK|NUDGE|STOP)\b/i.test(d.raw || "");
      const reasoning = (d.text || "").replace(/\n*DECISION:[^\n]*\s*$/i, "").trimEnd();
      if (d.decision === "OK") {
        state.lastDecision = "OK";
        flog(`cycle=${state.cycles} decision=OK${wasBadLine ? " (note: final line was not DECISION:, treated as OK)" : ""}`);
        tick(state.cycles, "OK", wasBadLine ? "final line was not DECISION: — treated as OK" : undefined, reasoning);
      } else if (d.decision === "NUDGE") {
        state.lastDecision = `NUDGE: ${d.detail}`;
        state.interventions += 1;
        const nr = await deliverNudge(d.detail || "please continue and update STATUS.md");
        flog(`cycle=${state.cycles} decision=NUDGE interventions=${state.interventions} delivered=${nr.ok}${nr.why ? " why=" + nr.why : ""} msg=${JSON.stringify(d.detail)}`);
        tick(state.cycles, "NUDGE", d.detail, reasoning);
        // nudge delivery status (dead guard, etc.) — the pre-checks will catch a
        // truly dead child next cycle; the budget slot is burned either way
        tlog(`${C(2)}    nudge ${nr.ok ? "delivered" : `NOT delivered${nr.why ? ` (${nr.why})` : ""}`}${C(0)}`);
        if (state.interventions >= A.maxInterventions) {
          glog("✗", 31, `budget exhausted (${state.interventions}/${A.maxInterventions}) — stopping loop`);
          await writeFinalReport(`parent stop: intervention budget exhausted (${state.interventions}/${A.maxInterventions})`);
          saveState();
          process.exit(4);
        }
      } else if (d.decision === "STOP") {
        state.lastDecision = `STOP: ${d.detail}`;
        flog(`cycle=${state.cycles} decision=STOP reason=${JSON.stringify(d.detail)}`);
        tick(state.cycles, "STOP", d.detail || "no reason given", reasoning);
        await writeFinalReport(`parent stop: ${d.detail || "no reason given"}`);
        saveState();
        process.exit(4);
      } else {
        flog(`cycle=${state.cycles} unknown-decision=${JSON.stringify(d.raw.slice(0, 120))} — treating as OK`);
        tick(state.cycles, "OK", "unknown final line — treated as OK", reasoning);
        state.lastDecision = "unknown→OK";
      }
      saveState();
      if (A.once) process.exit(0);
    }
  }

  await sleep(Math.min(POLL_SEC * 1000, Math.max(5000, A.cycleSec * 1000 - (Date.now() - lastJudgment))));
}
})();
