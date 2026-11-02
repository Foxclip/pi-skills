#!/usr/bin/env node
// ralph-monitor.mjs — v0.25.8: the parent as a ralph loop.
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
  lastDecision: null, llmFailStreak: 0, lastJudgeToolCalls: null,
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
// v0.25.7: bright flag — the final-report ask line is the run's end, not a
// routine wait, and reads bright like the event lines.
const ask = (msg, bright = false) => tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(36)}…${C(0)} ${bright ? C(1) : C(2)}${msg}${C(0)}`);
// v0.21.2: child heartbeat — one dim line with the CHILD's live state.
// Without it the terminal only shows the parent's judgment lines and the run
// reads as if the parent were doing all the work.
// v0.24.2: the line fires on every toolCalls CHANGE (not every poll) — with
// the 5s poll a new tool call shows up within ~5s — plus a 60s fallback so
// the terminal still proves the child is alive between tool calls (thinking).
// v0.25.5: TWO message types (was one line shape for both):
//   (A) per tool call — toolCalls GREW since the last poll → line names the
//       tool. The monitor only sees count snapshots at 5s granularity — two
//       calls in one poll gap = one line, final count.
//   (B) liveness — child alive but quiet: every QUIET_SEC (default 60s)
//       after the last tool call, with the idle duration (· no new tool call
//       for 1m 5s). The anchor is the last TOOL CALL, not the last line: an
//       active child gets one line per tool call and nothing else; a quiet
//       child gets exactly one line per minute. The heartbeat child line
//       (judgment/final-report waits) and the launch baseline are type (B).
// v0.25.6: "child running" becomes "child finalizing" once the child's own
// deadline (status.deadlineIso) has passed: the guard has aborted the work
// turn and sent the finalize prompt.
// v0.25.7 (run13 screenshot): ONE family, ONE format per type — the phase
// word is the only phase-dependent text. (A) BRIGHT: `· child <phase> ·
// tool call N: X [· L left]` (N = latest index = total count). (B) GRAY —
// `· child <phase> · N tool call(s) [· no new tool call for D] [· last: X]
// [· L left]`. The launch baseline line is back (v0.25.6 removed it).
// v0.25.8 (run14 screenshot): (B) is C(2) dim — the SAME grey as the other
// status lines (the monitor's ask/beat lines; ralph.sh prints its status
// bodies normal, which reads as the same grey). \x1b[90m bright-black is
// NOT it: it renders DARKER than those lines in the user's terminal. No
// new colors — C(2) or none.
const humanLeft = (ms) => {
  let s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
};
// v0.25.6: the phase LABEL of the child lines — "finalizing" from the moment
// the child's own deadline (status.deadlineIso, guard-written at launch) has
// passed while the child is still running: the guard has aborted the work
// turn and sent the finalize prompt. Same predicate preCheck uses for the
// child-finalizing wait.
const childPhase = (s) => {
  if (s.status !== "running") return s.status;
  const cd = s.deadlineIso ? Date.parse(s.deadlineIso) : NaN;
  return Number.isFinite(cd) && Date.now() >= cd ? "finalizing" : s.status;
};
// (A) per tool call — BRIGHT, and the tool name IS the message: "tool call
// N" is the latest call's index = the total count (5s snapshots: calls inside
// one poll gap show as one line with the final count).
const childToolLine = (s) => {
  const tc = Number(s.toolCalls) || 0;
  const tool = s.lastTool ? `: ${s.lastTool}` : "";
  const left = deadlineMs !== null ? ` · ${humanLeft(deadlineMs - Date.now())} left` : "";
  tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(2)}·${C(0)} ${C(1)}child ${childPhase(s)} · tool call ${tc}${tool}${C(0)}${C(2)}${left}${C(0)}`);
};
// (B) liveness line — GRAY (C(2), the same grey as the other status lines):
// a liveness proof, not an event.
// bright=true is the terminal EVENT variant (stopLoop): final status, no
// countdown — the child is terminal.
const childLiveLine = (s, { idleMs = null, bright = false, withLeft = true } = {}) => {
  const tc = Number(s.toolCalls) || 0;
  const idle = idleMs !== null ? ` · no new tool call for ${humanLeft(idleMs)}` : "";
  const last = s.lastTool ? ` · last: ${s.lastTool}` : "";
  const left = withLeft && deadlineMs !== null ? ` · ${humanLeft(deadlineMs - Date.now())} left` : "";
  tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(2)}·${C(0)} ${C(bright ? 1 : 2)}child ${childPhase(s)} · ${tc} tool call${tc === 1 ? "" : "s"}${idle}${last}${C(0)}${C(2)}${left}${C(0)}`);
};
// The first poll anchors the quiet timer to the child's own data when
// available (attach: real idle, not 0) — and v0.25.7: PRINTS the launch
// baseline line (gray, count + last + left) right after "child launched".
const QUIET_SEC = Math.max(1, Number(process.env.RM_QUIET_SEC) || 60);
let seen = { tc: null, lastToolAt: 0, lastQuiet: 0 };
const beatMaybe = (s) => {
  const tc = Number(s.toolCalls);
  if (!Number.isFinite(tc)) return;
  const now = Date.now();
  if (seen.tc === null) {
    seen.tc = tc;
    const lts = s.lastToolStartedAt ? Date.parse(s.lastToolStartedAt) : NaN;
    seen.lastToolAt = Number.isFinite(lts) ? lts : now;
    seen.lastQuiet = now;
    childLiveLine(s);                       // launch baseline (gray)
    return;
  }
  if (tc !== seen.tc) {                     // a tool call happened → bright
    seen.tc = tc;
    seen.lastToolAt = now;
    seen.lastQuiet = now;
    childToolLine(s);
    return;
  }
  if (now - seen.lastQuiet >= QUIET_SEC * 1000) {   // quiet for a minute → gray
    seen.lastQuiet = now;
    childLiveLine(s, { idleMs: now - seen.lastToolAt });
  }
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
  // v0.25.1: the finalization trigger is the SOONEST of the monitor's own
  // deadline and the child's own deadline (status.deadlineIso, written by the
  // guard at launch). run9: the child's 4-min budget expired while the
  // monitor's deadline was 26 min away — the loop kept judging on stale
  // settle snapshots during the child's finalize window.
  const cd = status && status.deadlineIso ? Date.parse(status.deadlineIso) : NaN;
  const effDl = Math.min(deadlineMs ?? Infinity, Number.isFinite(cd) ? cd : Infinity);
  if (effDl !== Infinity && now >= effDl) {
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
      if (now >= effDl + A.finalizeGraceSec * 1000)
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

// v0.25.1: machine-generated LIVE view for the judgment prompt — read at
// prompt-build time, so it is always fresher than anything the judge
// re-reads from disk (run9: the judge's one-shot file reads raced the child's
// finalize window and it judged a 3-min-stale tools=0 settle snapshot).
function buildLiveView() {
  const now = Date.now();
  const s = readStatus();
  if (!s) return "(pi-child-status.json unreadable at prompt-build time)";
  const tc = Number(s.toolCalls);
  const last = s.lastTool ? `; lastTool=${s.lastTool}@${s.lastToolStartedAt || "?"}` : "";
  const delta = Number.isFinite(tc) && Number.isFinite(state.lastJudgeToolCalls)
    ? `; since last judgment: ${tc - state.lastJudgeToolCalls >= 0 ? "+" : ""}${tc - state.lastJudgeToolCalls} tool call(s)`
    : "";
  const lines = [`LIVE (monitor-observed at ${new Date(now).toISOString()}): status=${s.status || "?"} toolCalls=${Number.isFinite(tc) ? tc : "?"}${last}${delta}`];
  const dl = [];
  const cdl = s.deadlineIso ? Date.parse(s.deadlineIso) : NaN;
  if (Number.isFinite(cdl)) dl.push(`child deadline ${s.deadlineIso} ${now >= cdl ? "PASSED — child in finalize window" : `in ${humanLeft(cdl - now)}`}`);
  if (deadlineMs !== null) dl.push(`monitor deadline ${new Date(deadlineMs).toISOString()} ${now >= deadlineMs ? "PASSED" : `in ${humanLeft(deadlineMs - now)}`}`);
  if (dl.length) lines.push(dl.join(" | "));
  return lines.join("\n");
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

<live-view>

The LIVE block above was read by the monitor at prompt-build time — it is
fresher than anything in the logs. If the child is active (tool calls after
the newest [settle] line in the progress log), that settle is stale: judge
the live state, and never STOP a child that is actively working.

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
    .replaceAll("<cycle>", String(state.cycles + 1))
    .replaceAll("<live-view>", buildLiveView());
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
  ask("final report — asking parent to summarize the run…", true);   // v0.25.7: bright — the run's end
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
    const left = deadlineMs !== null ? ` · ${humanLeft(deadlineMs - Date.now())} left` : "";
    // v0.25.3: the parent's wait and the child's state are SEPARATE messages —
    // they used to share one line (… parent judging · 60s · child running · …).
    // v0.25.4: the child line only while the child is RUNNING — a terminal
    // child's state is announced once, as an EVENT, in stopLoop before the
    // STOP line; repeating it every tick read like a late event (run11:
    // "child completed" printed 60s AFTER the lines that reacted to it).
    tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(36)}…${C(0)} ${C(2)}${label}${C(0)}${C(2)} · ${el}s${left}${C(0)}`);
    if (s && s.status === "running") {
      // v0.25.7: the heartbeat child line is the SAME liveness line as the
      // per-minute quiet line (gray, count + idle + last + left) — the old
      // bright count-only line read as a different message (run13).
      const lts = s.lastToolStartedAt ? Date.parse(s.lastToolStartedAt) : NaN;
      const anchor = Number.isFinite(lts) ? lts : (seen.lastToolAt || 0);
      childLiveLine(s, { idleMs: anchor ? Date.now() - anchor : null });
    }
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
  // v0.25.4: event ordering — when the stop IS the child going terminal,
  // announce the child's state FIRST (same shape as the child beat line):
  // cause before reaction. (run11: the terminal state was first visible in
  // the STOP line, then re-printed by the heartbeat 60s later.)
  if (/child-terminal/.test(pc.reason)) {
    const s = readStatus();
    if (s) {
      const tc = Number.isFinite(Number(s.toolCalls)) ? ` · ${s.toolCalls} tool call${Number(s.toolCalls) === 1 ? "" : "s"}` : "";
      const last = s.lastTool ? ` · last: ${s.lastTool}` : "";
      // v0.25.6: glog's dim glyph attribute was leaking over the whole line,
      // so the event read dim. v0.25.7: the event IS the liveness line with
      // the final status (bright, no countdown — the child is terminal);
      // the FILE line is unchanged.
      flog(`child ${s.status}${tc}${last}`);
      childLiveLine(s, { bright: true, withLeft: false });
    }
  }
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
  // v0.25.1: no LLM judgment inside the finalize window — the parent has no
  // meaningful action there: NUDGE can't reach a mid-finalize turn, STOP
  // can't kill the detached child (run9: a STOP on a stale settle snapshot
  // ended the loop with a false "gave up" code while the child completed
  // fine). The pre-checks own this wait: terminal → 0/5, grace cap → 4 +
  // final report.
  if (pc.waiting === "child-finalizing") {
    await sleep(POLL_SEC * 1000);
    continue;
  }
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
    // v0.25.1: toolCalls baseline at judgment start — the stale-STOP veto
    // and the log audit compare against it when the verdict returns.
    const sJs = readStatus();
    const toolsAtJudgeStart = sJs ? Number(sJs.toolCalls) : NaN;
    if (Number.isFinite(toolsAtJudgeStart)) state.lastJudgeToolCalls = toolsAtJudgeStart;
    const stopHb = heartbeat(`cycle ${state.cycles} — parent judging`);   // v0.24.3
    // v0.23.0: race the judgment against the deadline — see runCmdTracked.
    // v0.25.2: AND against the CHILD's own deadline (status.deadlineIso, written
    // by the guard at launch). Once it has passed the loop has no useful
    // verdict to act on — NUDGE can't reach a mid-finalize turn, STOP can't
    // kill the detached child (the v0.25.1 principle). run10: a judgment
    // hung on a stalled model until its own 600s --timeout-sec, 6 min past
    // the child's deadline, with the loop blind the whole time.
    let watcherDone = false;
    const watcher = (async () => {
      while (!watcherDone) {
        const now = Date.now();
        if (deadlineMs !== null && now >= deadlineMs) return "deadline";
        const st = readStatus();
        const cd = st && st.deadlineIso ? Date.parse(st.deadlineIso) : NaN;
        if (Number.isFinite(cd) && now >= cd) return "child-deadline";
        await sleep(5000);
      }
      return null;
    })();
    const raced = await Promise.race([llmDecide(), watcher]);
    watcherDone = true;
    stopHb();
    if (raced === "deadline" || raced === "child-deadline") {
      if (judgmentProc) { try { judgmentProc.kill("SIGKILL"); } catch { /* best effort */ } }
      glog("!", 33, `cycle=${state.cycles} ${raced === "child-deadline" ? "child deadline" : "deadline"} passed while asking parent — judgment killed, handing off to the pre-checks`);
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
      // v0.25.1: stale-STOP veto — a verdict is a point-in-time observation;
      // if the child made tool calls while the parent was deciding, the disk
      // has already invalidated it (run9: STOP on a 3-min-stale tools=0
      // settle while the child was 7 tool calls deep in its finalize).
      // Same safe default as "unknown line → OK": the disk can invalidate a
      // verdict, a verdict can't invalidate the disk.
      const sNow = readStatus();
      const tcNow = sNow ? Number(sNow.toolCalls) : NaN;
      let stopVetoed = null;
      if (d.decision === "STOP" && Number.isFinite(tcNow) && Number.isFinite(toolsAtJudgeStart) && tcNow > toolsAtJudgeStart) {
        stopVetoed = { from: toolsAtJudgeStart, to: tcNow };
        d.decision = "OK";
        glog("!", 33, `cycle=${state.cycles} STOP vetoed — child progressed while judging (toolCalls ${toolsAtJudgeStart}→${tcNow}) — stale verdict, treated as OK`);
        flog(`cycle=${state.cycles} decision=STOP-VETOED reason=${JSON.stringify(d.detail)}`);
      }
      // v0.21.0: the FULL reasoning goes to ralph-monitor.log (the permanent
      // record — format unchanged); the terminal gets a scannable tick line
      // plus the reasoning in dim type.
      if (d.text) flog(`cycle=${state.cycles} parent:\n${d.text}`);
      // a judgment whose final line was not DECISION: — treat as OK, log the anomaly
      const wasBadLine = !/^DECISION:\s*(OK|NUDGE|STOP)\b/i.test(d.raw || "");
      const reasoning = (d.text || "").replace(/\n*DECISION:[^\n]*\s*$/i, "").trimEnd();
      if (d.decision === "OK") {
        state.lastDecision = stopVetoed ? `OK (stale-STOP veto: toolCalls ${stopVetoed.from}→${stopVetoed.to})` : "OK";
        flog(`cycle=${state.cycles} decision=OK${stopVetoed ? ` (after stale-STOP veto: toolCalls ${stopVetoed.from}→${stopVetoed.to})` : ""}${wasBadLine ? " (note: final line was not DECISION:, treated as OK)" : ""}`);
        tick(state.cycles, "OK", stopVetoed ? `STOP vetoed — child progressed while judging (tools ${stopVetoed.from}→${stopVetoed.to})` : wasBadLine ? "final line was not DECISION: — treated as OK" : undefined, reasoning);
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
        flog(`cycle=${state.cycles} decision=STOP reason=${JSON.stringify(d.detail)}${Number.isFinite(toolsAtJudgeStart) ? ` (toolCalls ${toolsAtJudgeStart} at judgment start)` : ""}`);
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
