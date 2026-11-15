#!/usr/bin/env node
// ralph-monitor.mjs — v0.25.15: the parent as a ralph loop.
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
//   llm/                      v0.25.15: full stdout/stderr of every `pi --print`
//                             call (cycle-N-judgment.{out,err}, final-report)
//
// Exit codes:
//   0 child completed (exitReason=completed)
//   2 child dead: guard pid gone or status stale while running
//   4 loop gave up: deadline / stall / budget / llm-down / LLM said STOP
//   5 child terminal with a failure exitReason
//   1 usage error, 130 SIGINT, 143 SIGTERM (v0.36.1: tracked LLM trees are
//   swept on every exit path — spec 7.3/7.5)
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
import { writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync, accessSync, constants, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeadline } from "./lib/deadline.mjs";
import { renderTree } from "./lib/node.mjs";
import { killChildGroup } from "./lib/kill-child.mjs";   // v0.36.1: two-sided LLM group kills

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

function usage() {
  return "usage: ralph-monitor.mjs --run-dir <dir> --pi <path> [--project-dir <d>] [--model <s>] [--provider <s>] [--session <f|id>] [--cycle-sec 1200] [--max-interventions 3] [--stuck-sec 3600] [--stale-sec 180] [--deadline <ISO|epoch|HH:MM>] [--max-hours 12] [--llm-fail-max 6] [--timeout-sec 600] [--final-timeout-sec 900] [--display-only] [--prompt-file <p>] [--log-file <p>] [--once] [--dry-run]";
}

// ---- args
const argv = process.argv.slice(2);
const num = (s) => { const n = Number(s); if (!Number.isFinite(n)) { console.error(`bad number: ${s}`); process.exit(1); } return n; };
const A = {
  runDir: null, pi: null, projectDir: null, model: null, provider: null, session: null,
  cycleSec: 1200, maxInterventions: 3, stuckSec: 3600, staleSec: 180,
  deadline: null, maxHours: 12, llmFailMax: 6, timeoutSec: 600, finalizeGraceSec: 900,
  finalTimeoutSec: 900, displayOnly: false,
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
  else if (x === "--final-timeout-sec") A.finalTimeoutSec = num(argv[++i]);
  else if (x === "--display-only") A.displayOnly = true;
  else if (x === "--prompt-file") A.promptFile = argv[++i];
  else if (x === "--log-file") A.logFile = argv[++i];
  else if (x === "--once") A.once = true;
  else if (x === "--dry-run") A.dryRun = true;
  else { console.error(usage()); process.exit(1); }
}
if (!A.runDir || !A.pi) { console.error(usage()); process.exit(1); }
// v0.35.1: the run dir this monitor was LAUNCHED on. A.runDir follows the
// slot; origRunDir never moves — followSlot uses it to tell the hand-BACK to
// our own window (re-entry re-activates the SAME run dir, legit) from a NEW
// launch (a sibling run dir in the same project's runs/ root, not a hand-off).
A.origRunDir = A.runDir;
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
// v0.35.4 (run35, 7.7): the deadline of the window this monitor was LAUNCHED
// on. followSlot re-points deadlineMs at every followed window; the hand-back
// to the launch window restores THIS value (re-entry re-activates the same
// window with the same deadline — the run owns its deadline, 1.3).
const launchDeadlineMs = deadlineMs;

// ---- state + log
let statePath = path.join(A.runDir, "ralph-monitor-state.json");   // let: follow-the-slot re-points on handoff (v0.26.0)
let logPath = A.logFile || path.join(A.runDir, "ralph-monitor.log");
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
// v0.25.14: the monitor's own record of its exit code. ralf.sh's `wait $MON_PID`
// can LOSE the status (bash 5.2 nojobs: `wait <pid>` → 127 = "pid not a child
// of this shell") even when the monitor exited cleanly — observed 2026-11-02:
// a completed run printed `✗ done · exit 127`. ralf.sh trusts this file when
// the wait reported 127. Written on every JS exit path (process.exit, crash,
// natural end); NOT written on SIGKILL (no JS runs) — then ralf.sh keeps wait's rc.
process.on("exit", (code) => {
  try {
    if (!A.runDir || !existsSync(A.runDir)) return;
    try { killLlmGroups(`exit(code=${code ?? 0})`); } catch { /* sweep is best-effort */ }
    writeFileSync(path.join(A.runDir, "monitor-exit.json"), `${JSON.stringify({ at: new Date().toISOString(), code })}\n`);
    flog(`monitor-exit: code=${code}`);
  } catch { /* best-effort — never mask the real exit code */ }
});
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
  // 8.3.5: a verdict is a message (dot). The arrow is reserved for handoff /
  // reentry, the red cross for errors — an OK/NUDGE/STOP verdict is neither.
  const sym = `${C(2)}·${C(0)}`;
  // v0.35.20 (7.9): the verdict detail/reasoning are AGENT text (the judge's
  // turn) — displayed VERBATIM, even when they quote UTC timestamps. The
  // re-specified 7.8 local-time rule covers monitor messages only; 7.9
  // forbids manipulating agent messages in the terminal. (v0.35.14 localized
  // them — removed.)
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
// N" is the latest call's index = the total count. v0.35.9 (run63, 7.4):
// this is now the FALLBACK line — the normal path prints ONE line per
// completed call from the guard's progress log (emitToolChange), because the
// status file is a snapshot: calls inside one poll gap coalesce (run63 lost
// calls 1+2, 5 ms apart, and call 4, 2.3 s before call 5).
const childToolLine = (s) => {
  const tc = Number(s.toolCalls) || 0;
  const tool = s.lastTool ? `: ${s.lastTool}` : "";
  const left = deadlineMs !== null ? ` · ${humanLeft(deadlineMs - Date.now())} left` : "";
  tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(2)}·${C(0)} ${C(1)}worker ${childPhase(s)} · tool call ${tc}${tool}${C(0)}${C(2)}${left}${C(0)}`);
};
// v0.35.9 (run63, 7.4): the guard appends one `[tool]` line per COMPLETED
// tool call to pi-child-progress.log (append-only; each attempt starts with
// its own [start] line, and the `tools=` counter is attempt-scoped). Parse
// the current attempt's calls; null when the log is missing or has no
// [start] yet (the monitor then falls back to the snapshot line).
const progressCalls = () => {
  let txt = "";
  try { txt = readFileSync(path.join(A.runDir, "pi-child-progress.log"), "utf8"); } catch { return null; }
  const lines = txt.split("\n");
  let si = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith("[start] ")) { si = i; break; }
  if (si < 0) return null;
  const calls = [];
  for (let i = si + 1; i < lines.length; i++) {
    const m = lines[i].match(/^\[tool\] \S+ tools=(\d+) (\S+)( ERR)?/);
    if (m) calls.push({ tool: m[2], err: !!m[3] });
  }
  return { key: lines[si], count: calls.length, calls };
};
// v0.35.9: print the bright per-call lines for every completed call the
// tracker has not printed yet (usually exactly one; a burst inside one poll
// gap prints one line PER CALL — 7.4). Fallback: the snapshot line when the
// progress log is unreadable. Call on EVERY tool-count change (main loop AND
// fast tick); it does not touch seen.tc (the caller owns that).
const emitToolChange = (s) => {
  const p = progressCalls();
  if (p) {
    if (p.key !== seen.progKey) { seen.progKey = p.key; seen.progCount = 0; }  // new attempt (distill/relaunch)
    if (p.count > seen.progCount) {
      const phase = childPhase(s);
      const left = deadlineMs !== null ? ` · ${humanLeft(deadlineMs - Date.now())} left` : "";
      for (let i = seen.progCount; i < p.count; i++) {
        const c = p.calls[i];
        tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(2)}·${C(0)} ${C(1)}worker ${phase} · tool call ${i + 1}: ${c.tool}${c.err ? " ERR" : ""}${C(0)}${C(2)}${left}${C(0)}`);
      }
      seen.progCount = p.count;
      return;
    }
  }
  childToolLine(s);
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
  // 8.3.5: the worker state lines (baseline / per-call / quiet / finalizing)
  // carry the dot — they ARE messages. The ellipsis is reserved for the WAIT
  // lines (judge deciding, handoff waiting, deadline grace), which the loop
  // prints as separate lines.
  const glyph = "·";
  tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(2)}${glyph}${C(0)} ${C(bright ? 1 : 2)}worker ${childPhase(s)} · ${tc} tool call${tc === 1 ? "" : "s"}${idle}${last}${C(0)}${C(2)}${left}${C(0)}`);
};
// The first poll anchors the quiet timer to the child's own data when
// available (attach: real idle, not 0) — and v0.25.7: PRINTS the launch
// baseline line (gray, count + last + left) right after "child launched".
const QUIET_SEC = Math.max(1, Number(process.env.RM_QUIET_SEC) || 60);
let seen = { tc: null, lastToolAt: 0, lastQuiet: 0, progKey: null, progCount: 0, landed: true };
// v0.35.7 (run61, 7.4): re-anchor the child-line state to a NEW window's child
// (followSlot / handBackToLaunch). The old window's count would otherwise
// cross-contaminate the first poll: run61 attached to the sub window and
// printed a spurious bright "tool call 0" line 39 s before its first real
// call (0 ≠ the parent window's count of 5). v0.35.9: progKey/progCount are
// the per-call tracker (the guard's progress log, see emitToolChange).
// v0.35.13: landed=false marks a RE-LAND (a re-point onto a window the
// monitor was not on last poll) so beatMaybe's prime can emit the re-entry
// child's latest call instead of swallowing it (R52 flake: the re-entry
// child's "tool call 4" line only fired when the monitor happened to read
// tc=0 before the count jumped — timing-dependent).
const resetSeen = () => {
  seen.tc = null; seen.lastToolAt = 0; seen.lastQuiet = 0;
  seen.progKey = null; seen.progCount = 0;
  seen.landed = false;
};
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
    const p0 = progressCalls();             // v0.35.9: prime the per-call tracker (attach: no replay of history)
    if (p0) { seen.progKey = p0.key; seen.progCount = p0.count; }
    // v0.35.13 (R52 flake, 7.4): a RE-LAND onto a window whose child has
    // already made calls used to prime silently — the latest call's bright
    // line was lost unless the count grew again (the re-entry child's first
    // visible calls were swallowed). On a re-land with tc > 0, emit the
    // latest-call line. tc === 0 stays silent (the run61 spurious
    // "tool call 0" line). Initial attach (landed=true) is unchanged.
    if (!seen.landed && tc > 0) emitToolChange(s);
    seen.landed = true;
    return;
  }
  if (tc !== seen.tc) {                     // a tool call happened → bright
    seen.tc = tc;
    seen.lastToolAt = now;
    seen.lastQuiet = now;
    emitToolChange(s);                      // v0.35.9: one line per completed call
    return;
  }
  if (now - seen.lastQuiet >= QUIET_SEC * 1000) {   // quiet for a minute → gray
    seen.lastQuiet = now;
    childLiveLine(s, { idleMs: now - seen.lastToolAt });
  }
};
// 8.2.3: every Worker message is printed to the terminal — text verbatim
// (8.3.3: agent message text is never manipulated), thinking never, and in
// messages with tool calls the tool NAME is what shows (the per-call bright
// lines above carry the names). Source: the guard's child transcript (the raw
// session file, on disk — survives crashes, 9.1). Agent message lines have NO
// timestamp (8.3.1) and the dim dot (8.3.5). Byte offsets are tracked per
// transcript file, so a resume/distill (a NEW file) starts at 0 and an
// attach never replays history.
const workerMsgOff = new Map();
const noteWorkerActivity = () => { if (seen) seen.lastQuiet = Date.now(); };
const printWorkerMessages = () => {
  const f = path.join(A.runDir, "child-transcript.jsonl");
  let st;
  try { st = statSync(f); } catch { return; }
  const off = workerMsgOff.get(f) ?? 0;
  if (st.size <= off) return;
  try {
    const fd = openSync(f, "r");
    try {
      const len = Math.min(st.size - off, 1 << 20);
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, off);
      const s = buf.toString("utf8", 0, n);
      const end = s.lastIndexOf("\n");
      if (end < 0) return;   // partial line — wait for the rest
      const full = s.slice(0, end);
      workerMsgOff.set(f, off + Buffer.byteLength(full + "\n", "utf8"));
      for (const line of full.split("\n")) {
        if (!line) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const m = j && j.type === "message" ? j.message : null;
        if (!m || m.role !== "assistant") continue;
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const b of blocks) {
          if (!b || typeof b !== "object") continue;
          if (b.type !== "text") continue;   // thinking: never; toolCall: the name lines above
          for (const tl of String(b.text || "").split("\n")) {
            if (tl.trim() === "") continue;
            tlog(`${C(2)}· worker: ${tl}${C(0)}`);
          }
        }
      }
      if (full.trim()) noteWorkerActivity();
    } finally { closeSync(fd); }
  } catch { /* the view must never change the run */ }
};
process.on("SIGINT", () => { glog("!", 33, "sigint: stopping"); saveState(); process.exit(130); });
// v0.36.1 (spec 7.3/7.5): SIGTERM (ralph.sh stop paths, stop.mjs) — same
// contract as SIGINT with the SIGTERM code; the tracked LLM process groups are
// swept by the exit handler below, BEFORE the monitor-exit record is written.
process.on("SIGTERM", () => { glog("!", 33, "sigterm: stopping"); saveState(); process.exit(143); });

// ---- helpers
const pidAlive = (pid) => {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// v0.35.5 (run40, 7.7/6.3): a re-activated window keeps its PREVIOUS child's
// terminal status on disk until the new child's guard overwrites it (run40:
// the monitor re-pointed 8 ms after the hand-back, read the first child's
// "completed", and stopped — exiting 47 s before the re-entry child finished;
// the run-summary snapshotted status=running). A terminal status is STALE —
// it belongs to a dead child instance — when the window's current child is a
// different instance:
//   (1) the child-pgid file (the guard writes it at child start) names a
//       different pgid than status.childPgid, or
//   (2) we re-pointed here through a slot whose launch time is NEWER than the
//       status (covers the gap before the new guard writes child-pgid).
// Stale ⇒ present as "starting": the loop keeps polling (POLL_SEC cadence),
// the new guard overwrites the status within seconds, and the deadline/stale
// caps bound the wait if the re-activation never materializes.
let slotStartedAtMs = null;   // followSlot: launch time of the window we just moved to
// v0.35.11 (run79): the stale-instance marker. run79: after the hand-back
// re-point the launch window still held the SPAWN child's terminal (completed,
// childPgid = the spawn instance) until the re-entry child's guard overwrote
// it — the monitor read it, stopped, and wrote the run report 339 s BEFORE the
// re-entry child's terminal (run-summary snapshotted status=running; the
// re-entry's per-call lines were lost). The v0.35.5 checks can't see this
// gap: at re-point the child-pgid file still names the SPAWN instance (the
// pgid check matches) and handBackToLaunch has no slot time (slotStartedAtMs
// null). The marker is set on a re-point ONLY when the file on disk is the
// terminal of the very instance we last watched RUNNING in that window
// (prevInstance) — a fresh instance's terminal (the re-entry child already
// done: run35/R47, childPgid ≠ spawn pgid) never matches, and a window we
// never watched running (R47's sub) has no prevInstance entry. While the
// marker holds and the file is unchanged, a child-terminal stop is deferred
// (we poll); the re-entry child's first write (new at/pgid) clears it; if the
// file never changes the grace expires and the terminal is trusted (a blocked
// re-activation — the run ends, bounded, instead of polling to the deadline).
const STALE_MARKER_GRACE_MS = 60_000;
const prevInstance = new Map();   // runDir → childPgid last seen RUNNING there
let staleMarker = null;           // { at, tc, p, until, told } for the current window
// v0.35.19 (run110, 4.9/7.7): the identity (run_dir|started_at|guard_pid) of a
// slot the hand-back already CONSUMED. The chain's clearActiveSlots is
// best-effort — when the clear is lost, the file still points at the window we
// just handed back from; re-following it ping-pongs hand-back → hand-off
// forever (R58). A FRESH slot (new started_at/guard_pid — e.g. the chain
// re-launched the parent for re-entry) has a different signature and is
// followed as before.
let consumedSlotSig = null;
const rawStatus = () => { try { return JSON.parse(readFileSync(path.join(A.runDir, "pi-child-status.json"), "utf8")); } catch { return null; } };
const noteRunning = (s) => { if (s && s.status === "running" && Number.isFinite(Number(s.childPgid))) prevInstance.set(A.runDir, Number(s.childPgid)); };
const markStaleIfMatch = () => {   // called at the end of every successful re-point
  staleMarker = null;
  const s = rawStatus();
  if (!s || s.status === "running" || s.status === "starting") return;
  const p = Number(s.childPgid);
  if (!Number.isFinite(p)) return;
  if (prevInstance.get(A.runDir) === p) {
    staleMarker = { at: s.at, tc: s.toolCalls, p, until: Date.now() + STALE_MARKER_GRACE_MS, told: false };
    glog("…", 33, `stale terminal on file (instance ${p} — the one last watched here) — the re-entry worker will overwrite it; waiting (grace ${STALE_MARKER_GRACE_MS / 1000}s)`);
    flog(`stale-marker set: terminal of last-watched instance p=${p} at=${s.at} tc=${s.toolCalls} — polling until it changes or the grace expires`);
  }
};
// v0.36.2 (run130, 6.1/7.4): the re-entry hand-back is legitimately slow —
// the chain's re-entry step WAITS for the sub-run report pointer (up to its
// own 1200s budget) before re-activating the launch window, and that report
// is written by THIS monitor's fire-and-forget judge call (handBackToLaunch /
// the follow hook). While the re-entry step has not completed, the pre-spawn
// terminal on file is by definition not the run's end — the re-entry child
// will still overwrite it. run130: the 60s grace expired mid-hand-back, the
// monitor "trusted the terminal" and exited (rc=0), killing the in-flight
// report judge; the chain then sat out its full 1200s wait, the re-activation
// launch was refused (no work time left) and the tree HALTED with no re-entry
// and no sub-run report.
function reentryStepInFlight() {
  try {
    const d = JSON.parse(readFileSync(path.join(A.runDir, "spawn-decision.json"), "utf8"));
    if (!d || d.ok !== true || !d.run_dir) return false;
    const rd = path.resolve(d.run_dir);
    if (!existsSync(path.join(rd, "reentry-pending.json"))) return false;
    if (existsSync(path.join(rd, "chain-halt.json"))) return false;
    try {
      const c = JSON.parse(readFileSync(path.join(rd, "chain-done.json"), "utf8"));
      if (c && c.outcome) return false;   // the re-entry step completed (re-activation launched or halted)
    } catch { /* no chain-done yet — still in flight */ }
    return true;
  } catch { return false; }
}
const markerHolds = (raw) => {   // true → a child-terminal stop must be deferred (poll)
  if (!staleMarker) return false;
  if (!raw || raw.at !== staleMarker.at || Number(raw.toolCalls) !== Number(staleMarker.tc) || Number(raw.childPgid) !== staleMarker.p) {
    flog(`stale-marker cleared: the window's status changed (a new instance wrote)`);
    staleMarker = null;
    return false;
  }
  if (Date.now() >= staleMarker.until) {
    // v0.36.2 (run130): grace renewal while the hand-back is in flight — the
    // re-entry child cannot have written yet because the chain's re-entry
    // step is still waiting on the report pointer. The chain's own 1200s
    // report wait bounds the renewal; the window deadline bounds everything
    // else (ralph.sh tears the monitor down at the deadline regardless).
    if (reentryStepInFlight()) {
      staleMarker.until = Date.now() + STALE_MARKER_GRACE_MS;
      if (!staleMarker.extTold || Date.now() - staleMarker.extTold >= 60_000) {
        staleMarker.extTold = Date.now();
        glog("…", 33, "hand-back in flight — the sub-run's final report is being written; the re-entry worker starts when it lands");
      }
      flog(`stale-marker grace renewed: re-entry step in flight (chain waiting on the sub-run report pointer)`);
      return true;
    }
    flog(`stale-marker expired (grace ${STALE_MARKER_GRACE_MS / 1000}s, file unchanged — the re-entry child never wrote); trusting the terminal`);
    staleMarker = null;
    return false;
  }
  return true;
};
const currentChildPgid = () => {
  try { return Number(readFileSync(path.join(A.runDir, "child-pgid"), "utf8").trim().split("\n")[0]); }
  catch { return NaN; }   // no file yet (pre-first-launch) — not a staleness signal
};
const statusIsStale = (s) => {
  if (!s || !s.at) return false;
  if (s.status === "running" || s.status === "starting") return false;   // only a terminal status can be stale
  const writtenAt = Date.parse(s.at);
  if (!Number.isFinite(writtenAt)) return false;
  const pg = currentChildPgid();
  if (Number.isFinite(pg) && Number.isFinite(Number(s.childPgid)) && Number(s.childPgid) !== pg) return true;
  return slotStartedAtMs !== null && slotStartedAtMs > writtenAt;
};
const readStatus = () => {
  let s;
  try { s = JSON.parse(readFileSync(path.join(A.runDir, "pi-child-status.json"), "utf8")); }
  catch { return null; }
  if (s && s.childUser) lastChildUser = s.childUser;   // v0.36.1: remember for the two-sided group kills
  if (statusIsStale(s)) {
    // the window's current child is a (re-)starting instance — the on-disk
    // terminal is the previous instance's. Freshen the fields the pre-checks
    // use (at → no false child-stale; guardPid dead-check is skipped for
    // "starting"); keep deadlineIso (the run's deadline is invariant, 1.3).
    return { ...s, status: "starting", exitReason: null, toolCalls: 0, lastTool: null,
      at: new Date().toISOString(), staleReactivation: true };
  }
  return s;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// Async command runner: the event loop stays alive while the child runs, so
// SIGINT is handled promptly even mid-LLM-turn (a synchronous spawnSync would
// swallow signals arriving during the call — verified empirically in testing).
// v0.25.15: full LLM call output is persisted — <run-dir>/llm/<tag>.{out,err}.
// Before this only the LAST stderr line survived (the llm-failed log line),
// which left a startup auth failure unpinnable to its exact variant and a
// 600s-timed-out call with zero evidence of what the model was doing.
const dumpIO = (tag, stdout, stderr) => {
  if (!tag) return;
  try {
    const dir = path.join(A.runDir, "llm");
    if (!existsSync(dir)) mkdirSync(dir);
    writeFileSync(path.join(dir, `${tag}.out`), stdout || "");
    writeFileSync(path.join(dir, `${tag}.err`), stderr || "");
  } catch { /* diagnostics must never change the exit code */ }
};
// v0.36.1 (spec 7.3/7.5): every LLM process tree this monitor spawns (cycle
// judgment, final report — the pi-as-child wrapper + the child-user pi behind
// it in protected runs) is DETACHED and group-tracked. The monitor is a
// terminal child: on ANY exit path (budget/deadline/STOP = 4, SIGINT = 130,
// SIGTERM = 143, crash, process.exit(0)) the tracked groups are killed
// two-sided (owner + sudo child-user — the pichild pi is EPERM from the owner
// side, same as the worker; the kill-child.mjs pattern), so a judgment never
// outlives the monitor as an orphan (run128: the stop paths left the in-flight
// judge running until its own --print finished). The groups are persisted to
// <run-dir>/llm-groups.json so ralph.sh's EXIT trap can sweep what this
// process's own handlers cannot reach (monitor OOM-killed / SIGKILLed).
let lastChildUser = null;
const llmGroupsFile = path.join(A.runDir, "llm-groups.json");
const llmGroups = new Map(); // pgid (== leader pid, setsid) -> true
const saveLlmGroups = () => {
  try { writeFileSync(llmGroupsFile, JSON.stringify({ v: 1, at: new Date().toISOString(), groups: [...llmGroups.keys()] }) + "\n"); }
  catch { /* best effort — the file is a sweep index, not state */ }
};
const trackLlm = (p) => {
  if (!p.pid) return;
  llmGroups.set(p.pid, true);
  saveLlmGroups();
  p.once("close", () => { if (llmGroups.delete(p.pid)) saveLlmGroups(); }); // we are its parent — reap
};
const groupGone = (g) => {
  try { process.kill(-g, 0); return false; }                    // we can signal it — alive
  catch (e) { return /no such process|ESRCH/i.test(e.message); } // EPERM = foreign members still alive
};
// Kill one tracked group two-sided: TERM → 2s grace → KILL. Synchronous (safe
// inside the process "exit" handler). ESRCH-tolerant.
const killLlmGroup = (ref, tag) => {
  const g = typeof ref === "number" ? ref : (ref && ref.pid);
  if (!g) return;
  const sig = (name) => killChildGroup({ childPgid: g, childUser: lastChildUser }, name).errors
    .forEach((e) => glog("·", 37, `v0.36.1 ${tag}: group ${g} ${name}: ${e}`));
  const wait = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (groupGone(g)) return true; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); } return groupGone(g); };
  sig("SIGTERM");
  if (!wait(2000)) { sig("SIGKILL"); wait(2000); }
};
const killLlmGroups = (tag) => {
  const groups = [...llmGroups.keys()];
  if (!groups.length) return;
  glog("·", 37, `v0.36.1 ${tag}: sweeping ${groups.length} tracked LLM group(s) ${groups.join(",")}`);
  for (const g of groups) killLlmGroup(g, tag);
  llmGroups.clear();
  saveLlmGroups();
};
function runCmd(cmd, args, timeoutMs, tag) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    const finish = (extra) => { if (!done) { done = true; dumpIO(tag, stdout, stderr); resolve({ ...extra }); } };
    // v0.36.1: detached → own process group, tracked for the exit sweep; the
    // timeout is manual so the expiry kills the WHOLE tree, not the leader.
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    trackLlm(p);
    const to = setTimeout(() => killLlmGroup(p, `timeout(${tag})`), timeoutMs);
    p.stdout.on("data", (d) => { stdout += d; if (stdout.length > 16 * 1024 * 1024) killLlmGroup(p, `stdout-overflow(${tag})`); });
    p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 16 * 1024 * 1024) killLlmGroup(p, `stderr-overflow(${tag})`); });
    p.on("error", (e) => { clearTimeout(to); finish({ status: null, signal: null, stdout, stderr, error: String(e) }); });
    p.on("close", (status, signal) => { clearTimeout(to); finish({ status, signal, stdout, stderr }); });
  });
}
// v0.23.0: judgment invocations are tracked so the deadline watcher can KILL a
// judgment stuck in the model queue (run4: the judgment burned its whole
// --timeout-sec budget behind the degenerate child while the loop — pre-checks
// included — was blind for the entire wait).
let judgmentProc = null;
async function runCmdTracked(cmd, args, timeoutMs, tag) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", done = false;
    // v0.36.1: detached + group-tracked (see runCmd) — the timeout and the
    // deadline-watcher kill kill the whole tree, owner side and child-user side.
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
    judgmentProc = p;
    trackLlm(p);
    const to = setTimeout(() => killLlmGroup(p, `timeout(${tag})`), timeoutMs);
    const finish = (extra) => { if (!done) { done = true; clearTimeout(to); if (judgmentProc === p) judgmentProc = null; dumpIO(tag, stdout, stderr); resolve({ ...extra }); } };
    p.stdout.on("data", (d) => { stdout += d; if (stdout.length > 16 * 1024 * 1024) killLlmGroup(p, `stdout-overflow(${tag})`); });
    p.stderr.on("data", (d) => { stderr += d; if (stderr.length > 16 * 1024 * 1024) killLlmGroup(p, `stderr-overflow(${tag})`); });
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
      return { stop: true, code: ok0 ? 0 : 5, reason: `deadline: worker-terminal (${status.exitReason || "completed"})` };
    }
    if (s0 === "stuck" || s0 === "failed" || s0 === "aborted")
      return { stop: true, code: 4, reason: `deadline: worker-terminal (${s0})` };
    if (s0 === "running" || s0 === "starting") {
      if (now >= effDl + A.finalizeGraceSec * 1000)
        return { stop: true, code: 4, reason: `deadline (worker still running after ${A.finalizeGraceSec}s grace)` };
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
    return { stop: true, code: ok ? 0 : 5, reason: `worker-terminal (${status.exitReason || "completed"})` };
  }
  if (s === "running" || s === "starting") {
    const at = Date.parse(status.at || "");
    const age = Number.isFinite(at) ? now - at : Infinity;
    if (s === "running") {
      const gp = Number(status.guardPid);
      if (gp > 0 && !pidAlive(gp) && age > 60_000)
        return { stop: true, code: 2, reason: `worker dead (pid ${gp} gone)` };
      if (age > A.staleSec * 1000)
        return { stop: true, code: 2, reason: `worker stale (no status update for ${Math.round(age / 1000)}s)` };
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
  // run11 fix (ping9/ping10 era): a terminal child state OTHER than completed
  // before the deadline ends the window NOW — the guard has exited, nothing
  // more will happen in this window. The old code kept polling (and judging
  // a dead child) until the deadline: ping9's child died at 1 s, the monitor
  // sat out the whole 4-min window and stopped with a misleading "deadline".
  if (s === "error" || s === "stuck" || s === "failed" || s === "aborted")
    return { stop: true, code: 5, reason: `worker-terminal (${status.exitReason || s})` };
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
  if (Number.isFinite(cdl)) dl.push(`worker deadline ${s.deadlineIso} ${now >= cdl ? "PASSED — worker in finalize window" : `in ${humanLeft(cdl - now)}`}`);
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
DECISION: DISTILL: <one-line reason the context has rotted>
DECISION: STOP: <one-line reason the run cannot succeed>

Your reasoning is printed to the terminal verbatim — keep it short, and use
the plain words worker / judge / run / deadline (never implementation words
like child process, parent, guard or window).

DISTILL is for CONTEXT ROT only: the child is confidently repeating a wrong
premise, working from a refuted plan, or re-doing work it already did — the
transcript itself is now the problem. It is DESTRUCTIVE and bounded: the
child's current session is discarded and a FRESH session is relaunched with a
distilled brief (task + artifacts + remaining wall clock). Do NOT use it for
slow progress (NUDGE), a task that cannot succeed (STOP), or ordinary
stuckness (NUDGE first).

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
  const r = await runCmdTracked(A.pi, args, A.timeoutSec * 1000, `cycle-${state.cycles}-judgment`);
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
meta-commentary about this report.

Use plain spec words — worker, judge, run, deadline, sub-run — and never
implementation words (child process, parent, guard, window, session file):
the report is printed to a human watching the run.`;

async function writeFinalReport(reason, opts = {}) {
  const runDir = opts.runDir || A.runDir;
  const projectDir = opts.projectDir || A.projectDir;
  if (A.displayOnly) {
    // 8.2.7: an attach terminal never judges — but the run's Final Report
    // (written by the owning terminal's judge) is still printed at the end
    // of the run, no ask, straight from the file.
    for (const name of ["FINAL-REPORT.monitor.md", "FINAL-REPORT.md"]) {
      const f = path.join(runDir, name);
      if (existsSync(f)) {
        glog("·", 2, `report — the run's Final Report`);
        // v0.36 (8.2.6/7.9): boxed, and VERBATIM — the agent's text is never
        // manipulated (the box lines are the file lines as written).
        try {
          const lines = readFileSync(f, "utf8").trimEnd().split("\n");
          tlog(`${C(2)}┌ final report (judge)${C(0)}`);
          for (const line of lines) tlog(`${C(2)}│${C(0)} ${line}`);
          tlog(`${C(2)}└─${C(0)}`);
        } catch { /* best effort */ }
        return f;
      }
    }
    flog(`final report skipped (display-only attach, 6.1) — none on disk`);
    return null;
  }
  ask(opts.askMsg || "final report — asking the judge to write it…", true);   // v0.25.7: bright — the run's end
  const frStarted = Date.now();   // v0.25.15: duration on the end line
  flog(`final-report-start model=${A.model || "pi-default"} provider=${A.provider || "pi-default"} reason=${JSON.stringify(reason)}`);
  const projectLine = projectDir
    ? `Project directory: ${projectDir}`
    : "Project directory: unknown (check pi-child-status.json / git in the run dir)";
  const prompt = SUMMARY_PROMPT.replaceAll("<run-dir>", runDir)
    .replaceAll("<project-dir-line>", projectLine)
    .replaceAll("<end-reason>", reason);
  const args = ["--print", "--no-session"];   // fresh writer, never the judgment session
  if (A.model) args.push("--model", A.model);
  if (A.provider) args.push("--provider", A.provider);
  args.push(prompt);
  let r;
  const frDur = () => `${Math.round((Date.now() - frStarted) / 1000)}s`;
  try {
    const stopHb = heartbeat("final report — the judge is writing it");   // v0.24.3
    // v0.35.19 (run108/run110, 7.7): the final report gets its OWN budget
    // (--final-timeout-sec, default 900 = the finalize window). A slow local
    // judge model needs >600s (observed 626–696s); the shared --timeout-sec
    // killed the call mid-report and the DISCARDED text was a complete report.
    try { r = await runCmd(A.pi, args, A.finalTimeoutSec * 1000, "final-report"); } finally { stopHb(); }
  } catch (e) {
    glog("✗", 31, `final-report: FAILED (${e.message}) — skipping`);
    flog(`final-report-end dur=${frDur()} outcome=error (${e.message})`);
    return null;
  }
  const text = (r.stdout || "").trim();
  // v0.35.19 (run108/run110, 7.7): SALVAGE — the report was fully streamed to
  // stdout but the pi process hung past --final-timeout-sec and was killed
  // (all three observed cases: complete text, then a 600s+ post-output hang).
  // A salvaged report, noted as such, beats no report (7.7).
  const okExit = r.status === 0;
  if (!okExit && text.length < 40) {
    glog("✗", 31, `final-report: FAILED (exit=${r.status ?? r.signal}) — skipping`);
    flog(`final-report-end dur=${frDur()} outcome=failed exit=${r.status ?? r.signal}`);
    return null;
  }
  if (!okExit) {
    glog("!", 33, `final-report: judge process killed (exit=${r.status ?? r.signal}) — salvaging ${text.length} chars of captured stdout`);
  }
  // v0.26.4: run dirs are child-writable (spawn protocol, sub-run era) — the
  // child's OWN final report may already hold the canonical name (run30
  // re-entry, 2026-11-04: the child claimed FINAL-REPORT.md, the parent's
  // overwrite hit EACCES). If the existing file is not overwritable by this
  // process, write FINAL-REPORT.monitor.md and leave the child's file intact
  // — ralph.sh prefers this file when printing the parent box.
  let p = path.join(runDir, "FINAL-REPORT.md");
  try { accessSync(p, constants.W_OK); }
  catch (e) { if (e.code !== "ENOENT") p = path.join(runDir, "FINAL-REPORT.monitor.md"); }
  try {
    writeFileSync(p, text + "\n");
    glog("·", 2, `final-report: ${okExit ? "written" : "salvaged"} (${text.length} chars) → ${p}`);
    flog(`final-report-end dur=${frDur()} outcome=${okExit ? "written" : "salvaged"} chars=${text.length} file=${path.basename(p)}`);
    // v0.36 (8.2.6/7.9): the owning terminal prints the report it just
    // wrote, boxed and verbatim.
    tlog(`${C(2)}┌ final report (judge)${C(0)}`);
    for (const line of text.split("\n")) tlog(`${C(2)}│${C(0)} ${line}`);
    tlog(`${C(2)}└─${C(0)}`);
    return p;
  } catch (e) {
    glog("✗", 31, `final-report: write failed (${e.message})`);
    flog(`final-report-end dur=${frDur()} outcome=write-failed (${e.message})`);
    return null;
  }
}
// §6.1 (re-entry): the sub-run's Final Report. When the sub-run's worker ends
// and the chain re-activates the original run, the sub-run's judge (one fresh
// judgment-model turn — the same writer as the run's report) summarizes the
// sub-run. The monitor OWNS this write: the chain's re-entry step signals
// reentry-pending.json and then WAITS for the final-report.json pointer we
// drop here (the report is ready before the pointer resets, §6.1). The report
// is printed to the terminal (8.2.6). No marker after the grace → the chain
// HALTED (deadline spent, 5.10) — no sub-run report; the run's own report
// covers it. Idempotent: an existing pointer means the report already landed.
async function writeSubRunReport(leaveDir) {
  if (A.displayOnly) { flog(`sub-run report skipped (display-only attach, 6.1)`); return null; }
  const win = path.basename(leaveDir);
  const markerPath = path.join(leaveDir, "reentry-pending.json");
  // a durable halt (the chain step's markers) means no re-entry will come —
  // skip the report immediately instead of sitting out the full grace
  // (5.10: the deadline spent → the run ends at the launch window).
  const haltedOnDisk = () => {
    if (existsSync(path.join(leaveDir, "chain-halt.json"))) return true;
    try {
      const d = JSON.parse(readFileSync(path.join(leaveDir, "chain-done.json"), "utf8"));
      return d && d.outcome && d.outcome.next === "halted";
    } catch { return false; }
  };
  if (!existsSync(markerPath)) {
    // the chain step decides right after the terminal status is durable —
    // give it a bounded grace before concluding a halt (a durable halt
    // marker on disk ends the wait early).
    const t0 = Date.now();
    while (!existsSync(markerPath) && !haltedOnDisk() && Date.now() - t0 < 60_000) await sleep(500);
  }
  if (!existsSync(markerPath)) {
    flog(`no reentry-pending in ${win} — the chain halted (${haltedOnDisk() ? "halt marker on disk" : "grace expired"}); no sub-run report (the run's report covers it)`);
    return null;
  }
  let mj = null;
  try { mj = JSON.parse(readFileSync(markerPath, "utf8")); } catch { /* marker content optional */ }
  if (mj && mj.deadline && Date.now() >= Date.parse(mj.deadline)) {
    flog(`reentry-pending deadline (${mj.deadline}) already reached — 5.10: no sub-run report; the run ends at the launch window`);
    return null;
  }
  if (existsSync(path.join(leaveDir, "final-report.json"))) {
    flog(`final-report pointer already on disk in ${win} — not rewriting`);
    return null;
  }
  // the sub-run's project = three levels up (the window is <proj>/.pi-supervisor/runs/<win>)
  const projectDir = path.resolve(path.join(leaveDir, "..", "..", ".."));
  const p = await writeFinalReport(
    `sub-run ${win} ended (${mj && mj.reason ? mj.reason : "terminal"}) — re-entry to the original run is pending`,
    { runDir: leaveDir, projectDir, askMsg: `final report — asking the judge to summarize the sub-run (${win})…` },
  );
  if (!p) return null;
  // the pointer the chain's re-entry step waits for: {file} RELATIVE to the
  // window dir — the chain joins it onto the dir it is already waiting in.
  try {
    writeFileSync(path.join(leaveDir, "final-report.json"), JSON.stringify({ file: path.basename(p) }, null, 2) + "\n");
  } catch (e) { flog(`final-report.json pointer write failed in ${win}: ${e.message}`); }
  // 8.2.6: the Final Report, printed to the terminal when the run ends.
  glog("·", 2, `report — sub-run ${win} (the re-entry carries it to the original run)`);
  try { for (const line of readFileSync(p, "utf8").split("\n")) tlog(line); } catch { /* the file was just written */ }
  return p;
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
// v0.35.8 (run62, 7.4): the child state is re-checked on a FAST tick (default
// 5 s, RM_FAST_TICK_SEC; never slower than the label rate) so a tool call made
// during the in-flight LLM wait gets its own bright line within one poll
// interval — run62: a 143 s judgment with 60 s ticks coalesced calls 3–5 into
// a single line (only the latest count was ever shown). The dim label line and
// the quiet liveness line keep the RM_HEARTBEAT_SEC rate (default 60 s).
const FAST_TICK_SEC = Math.max(1, Math.min(HEARTBEAT_SEC, Number(process.env.RM_FAST_TICK_SEC) || 5));
const heartbeat = (label) => {
  const startedAt = Date.now();
  let lastLabelEl = 0;   // elapsed seconds at the last dim label line
  const iv = setInterval(() => {
    const now = Date.now();
    const el = Math.round((now - startedAt) / 1000);
    // v0.35.8: the label keeps the HEARTBEAT_SEC rate; the child state below
    // is checked on every fast tick.
    const labelDue = el - lastLabelEl >= HEARTBEAT_SEC;
    if (labelDue) lastLabelEl = el;
    printWorkerMessages();   // 8.2.3: the worker's messages keep flowing during the wait
    const s = readStatus();
    const left = deadlineMs !== null ? ` · ${humanLeft(deadlineMs - now)} left` : "";
    // v0.25.3: the parent's wait and the child's state are SEPARATE messages —
    // they used to share one line (… parent judging · 60s · child running · …).
    // v0.25.4: the child line only while the child is RUNNING — a terminal
    // child's state is announced once, as an EVENT, in stopLoop before the
    // STOP line; repeating it every tick read like a late event (run11:
    // "child completed" printed 60s AFTER the lines that reacted to it).
    if (labelDue) tlog(`${C(2)}[${tsLocalShort(new Date())}]${C(0)} ${C(36)}…${C(0)} ${C(2)}${label}${C(0)}${C(2)} · ${el}s${left}${C(0)}`);
    if (s && s.status === "running") {
      const tc = Number(s.toolCalls);
      const lts = s.lastToolStartedAt ? Date.parse(s.lastToolStartedAt) : NaN;
      if (seen.tc === null) {
        // first look at this child (attach mid-run): gray baseline, anchor.
        if (Number.isFinite(tc)) seen.tc = tc;
        seen.lastToolAt = Number.isFinite(lts) ? lts : Date.now();
        seen.lastQuiet = Date.now();
        childLiveLine(s, { idleMs: Number.isFinite(lts) ? Date.now() - lts : null });
      } else if (Number.isFinite(tc) && tc !== seen.tc) {
        // v0.35.7 (run61, 7.4): the main loop is BLOCKED in this LLM call —
        // beatMaybe never runs, so every tool call made during the judgment
        // lost its bright per-call line (run61: a 235 s judgment swallowed
        // calls 1–4; only gray liveness lines showed the counts climbing).
        // v0.35.9 (run63, 7.4): per-call lines from the progress log even
        // here (the snapshot merges bursts at the fast-tick rate too). Emit
        // the SAME type-A lines the poll loop emits, and advance `seen`
        // so the resumed loop does not re-emit (its count is unchanged since).
        seen.tc = tc;
        seen.lastToolAt = Number.isFinite(lts) ? lts : Date.now();
        seen.lastQuiet = Date.now();
        emitToolChange(s);
      } else if (labelDue) {
        // v0.25.7: the heartbeat child line is the SAME liveness line as the
        // per-minute quiet line (gray, count + idle + last + left) — the old
        // bright count-only line read as a different message (run13).
        // v0.35.8: still tied to the label rate (one per quiet minute) even
        // though the fast tick runs much more often.
        const anchor = Number.isFinite(lts) ? lts : (seen.lastToolAt || 0);
        childLiveLine(s, { idleMs: anchor ? now - anchor : null });
      }
    }
  }, FAST_TICK_SEC * 1000);
  iv.unref?.();
  return () => clearInterval(iv);
};
let finalWaitAnnounced = false;   // v0.24.3: announce the finalization wait once
// v0.23.0: one stop path for all pre-check stops. The parent's final report
// also runs on deadline/stuck endings — that is exactly when the user needs
// the "what happened" answer, and the child is terminal here, so the model
// slot is free for the report (a failed report never changes the exit code).
// v0.35.16 (run89): the run_dir of this window's CONSUMED spawn, or null —
// the spawn decision is ok, the spawned window is terminal, and its own
// chain step has run (chain-done.json). Before v0.35.16 the launch window
// stayed "spawn pending" FOREVER once its sub window died: the decision file
// persists, spawnPending() stayed true, and every stop cycle re-entered the
// 10 s slot poll, re-followed the dead sub window and re-wrote reports —
// run89's subrun67/run-1 (child died 1 s after launch) ping-ponged for
// 68+ minutes on a window with no chain-done.json (its guard's error path
// skipped the chain step; fixed in guard.mjs v0.35.16).
function consumedSpawnRunDir() {
  try {
    const d = JSON.parse(readFileSync(path.join(A.runDir, "spawn-decision.json"), "utf8"));
    if (!d || d.ok !== true || !d.run_dir) return null;
    const rd = path.resolve(d.run_dir);
    if (!existsSync(path.join(rd, "chain-done.json"))) return null;
    const st = JSON.parse(readFileSync(path.join(rd, "pi-child-status.json"), "utf8"));
    if (!st || ["starting", "running", "consult"].includes(st.status)) return null;
    return rd;
  } catch { return null; }
}
// run4 fix (F2): the halt context for the final report — the durable
// chain-halt.json marker first (greppable, written by the chain step), the
// chain-done.json outcome as fallback. Null when the run did not end on a
// chain halt.
function readHaltContext() {
  let halt = null;
  try {
    const h = JSON.parse(readFileSync(path.join(A.runDir, "chain-halt.json"), "utf8"));
    if (h && (h.reason || h.outcome)) halt = h;
  } catch { /* no marker */ }
  if (!halt) {
    try {
      const d = JSON.parse(readFileSync(path.join(A.runDir, "chain-done.json"), "utf8"));
      if (d && d.outcome && d.outcome.next === "halted") halt = d.outcome;
    } catch { /* no marker */ }
  }
  // v0.35.16 (run89): the RUN's report is written at the launch window — but
  // a halted SUB window's halt marker lives in the sub window's dir (the
  // chain step writes it next to its own chain-done.json). The launch window
  // carries no marker of its own; without this, the run's report would lack
  // the halt reason (the sub window's report has it, but the RUN's report is
  // what the human reads at the run's end).
  if (!halt) {
    const rd = consumedSpawnRunDir();
    if (rd) {
      try {
        const h = JSON.parse(readFileSync(path.join(rd, "chain-halt.json"), "utf8"));
        if (h && (h.reason || h.outcome)) halt = h;
      } catch { /* no marker */ }
      if (!halt) {
        try {
          const d = JSON.parse(readFileSync(path.join(rd, "chain-done.json"), "utf8"));
          if (d && d.outcome && d.outcome.next === "halted") halt = d.outcome;
        } catch { /* no marker */ }
      }
    }
  }
  if (!halt) return null;
  return { reason: halt.reason || "no reason recorded" };
}
async function stopLoop(pc, trigger = null) {
  // v0.35.11 (run79): the stale-instance marker (see markStaleIfMatch).
  // Deferred only while the on-disk file is still the last-watched instance's
  // UNCHANGED terminal; a changed file (the re-entry child wrote) or an
  // expired grace (it never came) falls through to the normal stop.
  // v0.35.12 (run81-2nd): the marker is checked against `trigger` — the SAME
  // status read that produced pc — not a fresh file read. run81-2nd: the
  // fresh read landed AFTER the re-entry guard's first write (1 ms later)
  // and cleared the marker, so the stop proceeded on the stale terminal
  // (the monitor exited 14 s before the re-entry child's true terminal).
  if (/worker-terminal/.test(pc.reason)) {
    const raw = trigger ?? rawStatus();
    if (markerHolds(raw)) {
      if (!staleMarker.told) { staleMarker.told = true; glog("…", 2, `terminal deferred: stale instance-${staleMarker.p} terminal unchanged on file — waiting for the re-entry worker to write`); }
      flog(`terminal deferred: stale child status (instance ${staleMarker.p}, at=${raw ? raw.at : "?"} unchanged) — polling`);
      // v0.35.12: pace the deferred polls — the pre-fix branch returned with
      // no sleep and tight-looped (run81-2nd: ~33 000 flog lines in 1.85 s).
      await sleep(1000);
      return;
    }
  }
  // v0.31.0 conform (6.2/6.3): the handoff slot is written by the EXITING
  // window's own guard in its final seconds (the chain step runs after the
  // status is durable), so it can land after the loop's own followSlot ran.
  // Check one more time before we leave: if the chain handed off, re-point
  // (divider + banner) and keep monitoring the new window instead of exiting
  // (run2: the terminal exited with "✓ done" while the tree kept running).
  saveState();
  // v0.25.4: event ordering — when the stop IS the child going terminal,
  // announce the child's state FIRST (same shape as the child beat line):
  // cause before reaction. (run11: the terminal state was first visible in
  // the STOP line, then re-printed by the heartbeat 60s later.)
  if (/worker-terminal/.test(pc.reason)) {
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
  // 8.3.5: a clean end (0) or the deadline (4) is a message (dot); a dead,
  // stale or failed worker (2/5) is an error (red cross).
  // v0.36 (R22/R26/R29/R40/R41): the machine line keeps the guard's own
  // wording (child-terminal + exitReason — what the guard actually wrote),
  // for the log; the DISPLAY line uses the worker's status word (a
  // completed-finalized worker is read back as "completed").
  flog(`pre-check STOP: ${pc.reason.replace("worker-terminal", "child-terminal")}`);
  const dispReason = pc.reason.replace(/\(completed-finalized\)/g, "(completed)");
  glog(pc.code === 0 || pc.code === 4 ? "·" : "✗", pc.code === 0 || pc.code === 4 ? 2 : 31,
    `stop: ${dispReason} (cycles=${state.cycles} interventions=${state.interventions})`);
  saveState();
  // v0.32.0 (5.1/7.7): the pause-vs-end decision is the child's spawn
  // request. WITH a pending spawn-request.json the run PAUSES (the chain
  // re-activates this window on hand-back) — skip the final report (7.7: the
  // report is for the run's END; run3 got one while pausing) and just follow
  // the hand-back slot. WITHOUT one, the run truly ends — write the report
  // BEFORE following the slot, so a hand-back that landed first cannot steal
  // the report (hello-sub/run-1 had no FINAL-REPORT.md: the old order
  // re-pointed first and skipped it).
  // v0.35.15 (run88, 7.7): a REJECTED spawn request is not pending — the
  // chain has already decided (spawn-decision.json ok:false), no hand-off
  // slot will ever land, and the run is ending (root halts blocked). Pre-fix
  // the stale request file sent the run-end down the pause path: the final
  // report (with the halt context) was skipped and the monitor sat through a
  // 10 s slot poll before exiting with no box and no FINAL-REPORT.md
  // (run88: status=halted, no final-report judge, no box).
  const spawnPending = () => {
    if (!existsSync(path.join(A.runDir, "spawn-request.json"))) return false;
    let d = null;
    try { d = JSON.parse(readFileSync(path.join(A.runDir, "spawn-decision.json"), "utf8")); } catch { /* no decision yet → still pending */ }
    if (d && d.ok === false) return false;   // rejected — no slot can land
    // v0.35.16 (run89): an ACCEPTED spawn is CONSUMED once the spawned window
    // is terminal and its chain step has run — the spawn lifecycle is over
    // (whatever its outcome), and the launch window's stop path must be able
    // to end the run (final report + halt context) instead of re-entering
    // the 10 s slot poll on a window that will never hand back again.
    if (consumedSpawnRunDir()) return false;
    return true;
  };
  // run11 fix: code 5 (child-terminal, non-completed) is ALSO the run's end
  // when nothing is pending — 7.7 requires the final report at every end
  // (ping9's error-stop would otherwise have exited silently).
  if (!spawnPending() && (pc.code === 0 || pc.code === 4 || pc.code === 5)) {
    // run4 fix (F2, 7.7): a chain HALT also ends the run — and it is decided
    // by the deterministic chain step (no LLM in the guard), so the final
    // report must carry the halt context from the durable marker (reason,
    // sub-run report location), not just the pre-check reason.
    const hc = readHaltContext();
    // v0.35.10 (run73, 7.4/6.2): a FOLLOWED sub window's plain child-terminal
    // is not the run's end — the chain is handing back to the launch window
    // (the re-entry child runs there) or halting. Pre-v0.35.10 this blocked the
    // loop here on the sub window's report (a parent summarize, ~3 min): the
    // hand-back line landed late and the re-entry child's per-call lines were
    // swallowed (run73: 3 calls, no lines). Re-point instead: the loop keeps
    // the re-entry monitored live and the RUN's report is written at the launch
    // window's terminal (followedSub is false there). On clean runs this
    // stopLoop is never reached — the main loop's followSlot consumes the
    // hand-back first — so only the race changes behavior.
    const followedSub = !!slotPath && path.resolve(A.runDir) !== path.resolve(A.origRunDir);
    // v0.35.19 (run110, 4.9/7.7): a FOLLOWED sub window's terminal is never
    // where the RUN's report is written — re-point to the launch window FIRST,
    // halt context or not (the launch window's stop path picks the sub window's
    // halt up via readHaltContext's consumed-spawn fallback) and writes the
    // report THERE. Pre-fix, WITH a halt context this skipped the re-point and
    // the RUN's report landed in the sub project's window dir — the "no final
    // report in a subproject" (4.9) deviation (run110: a 1600-char run110
    // report in subrun84/run-1/FINAL-REPORT.md, an extra 451s judge call).
    // The write-below stays as the fallback when no re-point is possible.
    if (followedSub) {
      // v0.36 (v0.35.10, R52/run73): a FOLLOWED sub window's plain terminal
      // is never where the RUN's report is written — re-point IMMEDIATELY,
      // no blocking sub report in this path (the pre-fix await sat ~60 s on
      // the reentry-pending grace and swallowed the re-entry's per-call
      // lines). The sub-run's report is fired fire-and-forget from the
      // re-point itself (handBackToLaunch / the main loop's follow hook) —
      // a no-op unless the chain's re-entry step is waiting on the pointer
      // (reentry-pending.json on disk).
      if (followSlot() || handBackToLaunch()) return;
    }
    // 8.2.7: display-only is handled inside writeFinalReport (it prints
    // the run's report from disk without judging).
    await writeFinalReport(hc ? `${pc.reason} — CHAIN HALT (the run is over): ${hc.reason}` : pc.reason);
  }
  // run4 fix (F4, 6.2/7.6): on the pause path (child-terminal + pending
  // spawn request) the handoff slot is written by the EXITING window's guard
  // in its chain step — it can land seconds after the status is durable.
  // Poll it boundedly (~10 s) instead of exiting while the spawn is in
  // flight (run4: the terminal exited 1.7 s before the slot landed and the
  // sub-window ran with no monitor). No slotPath → no slot can ever land.
  if (spawnPending() && slotPath) {
    for (let i = 0; i < 40; i++) {
      if (followSlot()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    // v0.35.15 (run88): a REJECT can land while we polled (the chain step
    // runs in parallel) — re-check before giving up; a fresh reject means
    // the run truly ends and still owes its final report.
    if (!spawnPending()) {
      const hc = readHaltContext();
      await writeFinalReport(hc ? `${pc.reason} — CHAIN HALT (the run is over): ${hc.reason}` : pc.reason);
    } else {
      glog("…", 33, "hand-off slot not observed after 10 s — the launch may still be in flight; a later-attaching terminal follows the tree");
    }
  }
  // the slot can also land while the final report was being written (the
  // guard's chain step runs in parallel) — one last check before we exit.
  if (followSlot()) return;   // handoff → the loop continues on the new window
  // v0.35.4 (run35, 7.7/6.4): the hand-back slot can be CONSUMED before we
  // reach it — the re-entry window runs and the chain's terminal step clears
  // the pointer while the sub window's final report is still being written
  // (run35: the report LLM call took 167 s; the re-entry child finished and
  // the chain ran idle/root-done at T+8 s; the slot-less exit then left the
  // RUN's final report unwritten — 7.7 violation, run35 had no
  // FINAL-REPORT.md). Re-point to the launch window and let the loop decide:
  // its child may still be running (keep monitoring) or be terminal (stop
  // with the run's final report). No ping-pong: after the re-point
  // A.runDir === origRunDir, so a later stopLoop falls through to exit.
  if (handBackToLaunch()) return;
  // v0.36.2 (run130, 6.1/7.4): never exit while the re-entry hand-back is in
  // flight — the run is PAUSED (the chain re-activates this window once the
  // sub-run report lands), not ended. This exit is what killed run130's
  // in-flight report judge mid-call (rc=0 at 75 s into a minutes-long local
  // judge turn); the marker-renewal above covers the marked case, this guard
  // covers the marker-less one (attach mid-hand-back, marker never set).
  if (reentryStepInFlight()) {
    flog(`stop deferred: re-entry step in flight (the run is paused, not ended) — polling`);
    await sleep(1000);
    return;
  }
  process.exit(pc.code);
}
// ---- follow-the-slot (v0.26.0, plan §5.5) ----------------------------------
// active.json is the project's active-window pointer: launch.mjs writes it at
// window start, the chain step clears it at window end. When it points at a
// DIFFERENT run dir than the one this terminal is on, the chain has handed
// off — re-point all status reads, the judgment and the live view at the new
// window, with a divider + tree banner (append-only, no redraw). The terminal
// only FOLLOWS — it never drives (several terminals may attach, all read-only;
// steering stays in ralph.sh stop/spawn). Projects without an active.json:
// no-op, so legacy runs are unchanged.
const slotPath = A.projectDir ? path.join(A.projectDir, ".pi-supervisor", "active.json") : null;
// Returns true when it RE-POINTED (a handoff was observed), false otherwise —
// the stop path uses that to keep monitoring the new window instead of exiting.
function followSlot() {
  if (!slotPath) return false;
  let p;
  try { p = JSON.parse(readFileSync(slotPath, "utf8")); } catch { return false; }
  const rd = p && p.run_dir;
  if (!rd || !existsSync(rd) || rd === A.runDir) return false;
  // v0.35.1 (TestProject2 streak, 2026-11-09): a NEW top-level launch is not a
  // hand-off. ralph.sh writes this project's active.json to the NEXT run dir
  // under the same runs/ root, and the old code followed it — so back-to-back
  // launches leaked every monitor forward: each kept monitoring every later
  // window, wrote a DUPLICATE final report at each window end (up to 9
  // concurrent report writers on one window; the local model serialized them
  // ~8 min each, FINAL-REPORT.md overwritten repeatedly), never exited, and
  // its ralph.sh parent sat in `wait $MON_PID` for up to ~105 min (the
  // terminal box + RUN-REPORT landed up to ~94 min past the run's true end).
  // Refuse a target in the launch project's runs/ root UNLESS it is our own
  // original window (the hand-back on re-entry). Sub-project hand-offs live
  // OUTSIDE that root and are followed as before.
  if (A.projectDir) {
    const root = path.resolve(path.join(A.projectDir, ".pi-supervisor", "runs"));
    const t = path.resolve(rd);
    if (t !== path.resolve(A.origRunDir) && (t === root || t.startsWith(root + path.sep))) return false;
  }
  // v0.35.19 (run110, 4.9/7.7): a STALE slot the hand-back already consumed
  // (the chain's clearActiveSlots is best-effort; a lost clear leaves the file
  // pointing at the window we just left). Re-following it ping-pongs hand-back
  // → hand-off forever without ever stopping at the launch window (R58). The
  // signature (run_dir|started_at|guard_pid) only matches the exact slot we
  // consumed — a fresh slot is followed as before.
  if (consumedSlotSig && `${rd}|${p.started_at || ""}|${p.guard_pid ?? ""}` === consumedSlotSig) {
    flog(`stale slot consumed by hand-back — not re-following ${path.basename(rd)}`);
    return false;
  }
  const from = path.basename(A.runDir);
  const to = path.basename(rd);
  A.runDir = rd;
  statePath = path.join(rd, "ralph-monitor-state.json");
  if (!A.logFile) logPath = path.join(rd, "ralph-monitor.log");
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first cycle on this window */ }
  state = state || {
    startedAt: new Date().toISOString(), cycles: 0, interventions: 0,
    lastToolCalls: -1, lastProgressAt: new Date().toISOString(),
    lastDecision: null, llmFailStreak: 0, lastJudgeToolCalls: null,
  };
  if (p.deadline) {
    const d = parseDeadline(String(p.deadline));
    if (d.ok) deadlineMs = d.ts.getTime();
  }
  // v0.35.5 (run40): the slot's launch time — a terminal status OLDER than it
  // belongs to a previous child instance of this window (see statusIsStale).
  const stAt = p.started_at ? Date.parse(p.started_at) : NaN;
  slotStartedAtMs = Number.isFinite(stAt) ? stAt : null;
  const isReentry = path.resolve(rd) === path.resolve(A.origRunDir);
  if (isReentry) {
    // 8.2.5: on reentry, only a message line (the run's report, not a
    // banner, is the event).
    glog("→", 36, `reentry: ${from} → ${to}`);
  } else {
    // 8.2.1: the handoff banner — the run being launched. Banner lines carry
    // no timestamps (8.3.1) and no symbols (8.3.5); local time only (8.3.2).
    const subProj = path.basename(path.join(rd, "..", "..", ".."));
    const dl = p.deadline ? tsLocalShort(new Date(p.deadline)) : "—";
    const cycle = A.cycleSec % 60 === 0 ? `${A.cycleSec / 60}m` : `${A.cycleSec}s`;
    glog("→", 36, `handoff: ${from} → ${to} (node ${p.node || "?"} · ${p.window || "?"})`);
    for (const line of [
      `┌ ralph — handoff (sub-run)`,
      `│ project   ${subProj}`,
      `│ run       .pi-supervisor/runs/${to}`,
      `│ deadline  ${dl}`,
      `│ worker    ${p.model || "pi-default"}`,
      `│ judge     ${A.model || "pi-default"} (cycle every ${cycle})`,
      `└─`,
    ]) tlog(`${C(2)}${line}${C(0)}`);
    // plan §5.5: the whole sub-runs layout, dim, on every handoff.
    if (A.projectDir) {
      try { for (const line of renderTree(A.projectDir).split("\n")) tlog(`${C(2)}${line}${C(0)}`); }
      catch { /* the tree banner is best-effort — never break the follow */ }
    }
  }
  resetSeen();   // v0.35.7 (run61, 7.4): new window = new child
  markStaleIfMatch();   // v0.35.11: stale-instance marker for the re-pointed window
  return true;
}
// v0.35.4 (run35, 7.7): the hand-back re-point for the SLOT-LESS case. stopLoop
// calls it after the report, when followSlot found nothing: a missing slot on a
// non-launch window means the run already ended while we were away (the chain
// cleared the pointer at its terminal step). Re-point to the launch window —
// the monitor's home per 6.4 (the terminal belongs to the run that launched
// it) — and let the loop's preCheck act on the launch window's real state.
function handBackToLaunch() {
  const target = path.resolve(A.origRunDir);
  if (path.resolve(A.runDir) === target) return false;
  if (!existsSync(target)) return false;
  // v0.35.19 (run110, 4.9/7.7): consume the slot that pointed at the window we
  // are leaving — its lifecycle ended (the chain's terminal step ran, hence
  // the hand-back). If the chain's clearActiveSlots lost the clear, the file
  // still points here; followSlot refuses this exact identity so the run's
  // stop path at the launch window actually runs instead of re-following a
  // dead window forever (R58).
  try {
    const p = JSON.parse(readFileSync(slotPath, "utf8"));
    if (p && p.run_dir && path.resolve(p.run_dir) === path.resolve(A.runDir)) {
      consumedSlotSig = `${p.run_dir}|${p.started_at || ""}|${p.guard_pid ?? ""}`;
    }
  } catch { /* no slot — nothing to consume */ }
  // v0.36 (v0.35.10, §6.1): the sub-run we are leaving owes its Final
  // Report — fire it WITHOUT blocking the loop (the re-entry child is
  // starting now; a blocking judge call would swallow its per-call lines,
  // run73). No-op unless the chain's re-entry step waits on the pointer.
  void writeSubRunReport(A.runDir);
  const from = path.basename(A.runDir);
  const to = path.basename(target);
  A.runDir = target;
  statePath = path.join(target, "ralph-monitor-state.json");
  if (!A.logFile) logPath = path.join(target, "ralph-monitor.log");
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first cycle on this window */ }
  state = state || {
    startedAt: new Date().toISOString(), cycles: 0, interventions: 0,
    lastToolCalls: -1, lastProgressAt: new Date().toISOString(),
    lastDecision: null, llmFailStreak: 0, lastJudgeToolCalls: null,
  };
  deadlineMs = launchDeadlineMs;   // the launch window's own deadline (1.3)
  slotStartedAtMs = null;          // no slot here — only the child-pgid check applies
  // 8.2.5: reentry is a message line only — no banner, no tree.
  glog("→", 36, `reentry: ${from} → ${to} (pointer reset to the launch window)`);
  flog(`reentry: ${from} → ${to} (pointer reset to the launch window)`);
  resetSeen();   // v0.35.7 (run61, 7.4): new window = new child instance
  markStaleIfMatch();   // v0.35.11: the launch window's spawn terminal may be stale
  return true;
}

(async () => {
for (;;) {
  const prevDir = A.runDir;
  const followed = followSlot();   // v0.26.0: re-point if the chain handed off to another window
  if (followed && path.resolve(prevDir) !== path.resolve(A.origRunDir)) {
    // §6.1: we are leaving a followed sub-window — its Final Report is
    // written before the pointer moves on. Fire-and-forget (v0.36): the
    // re-entry child is starting NOW — a blocking judge call would swallow
    // its per-call lines (run73). Idempotent inside.
    void writeSubRunReport(prevDir);
  }
  const status = readStatus();
  noteRunning(status);   // v0.35.11: remember the instance we are watching
  const pc = preCheck(status);
  if (pc.stop) {
    await stopLoop(pc, status);
    // v0.35.13 (run81-2nd / R52 flake): reaching here means stopLoop returned
    // WITHOUT stopping — it deferred (stale marker), re-pointed (handoff /
    // hand-back) or had the STOP refused (slot in flux). The window is being
    // re-activated by the chain; pace the re-check at 1 s. Unpaced, the cycle
    // tight-looped: R52's handoff ⇄ hand-back pair re-fired every iteration
    // (886 flog lines in 1 s while the chain's hand-back slot was in flight),
    // resetting the per-call anchors faster than they could emit.
    await sleep(1000);
    continue;
   }   // stopLoop exits the process on a real stop; only defer/re-point returns here
  // v0.24.3: the grace-bounded finalization wait (deadline passed, child still
  // finishing its turn) was the last silent stretch — announce entry once; the
  // 60s child beats keep the wait visible until it ends.
  if (pc.waiting === "child-finalizing" && !finalWaitAnnounced) {
    finalWaitAnnounced = true;
    glog("…", 36, `deadline reached — waiting for the worker to finalize (grace ${A.finalizeGraceSec}s)`);
  }
  if (status) printWorkerMessages();   // 8.2.3: every Worker message, verbatim
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
  if (A.displayOnly) {
    // v0.35.19 (6.1/7.11): attach monitors are display-only — they render the
    // view and ride the hand-offs, but never judge: the owning terminal's
    // monitor is the supervisor (6.2 tears the run down with its owner, so an
    // attach never becomes de-facto owner). No LLM call, no state advance —
    // the state file is SHARED with the owner's monitor on this window.
    flog(`display-only: judgment skipped (attach, 6.1/7.11) child=${status ? status.status : "?"}`);
    lastJudgment = nowMs;
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
    ask(`cycle ${state.cycles} — asking the judge…`);
    // v0.25.1: toolCalls baseline at judgment start — the stale-STOP veto
    // and the log audit compare against it when the verdict returns.
    const sJs = readStatus();
    const toolsAtJudgeStart = sJs ? Number(sJs.toolCalls) : NaN;
    if (Number.isFinite(toolsAtJudgeStart)) state.lastJudgeToolCalls = toolsAtJudgeStart;
    // v0.25.15: the judgment's START lands in the log file too (ask() is
    // terminal-only) — with the child's state, so a hung call can be tied to
    // what the child was doing. (run1: the 600s kill was a call queued behind
    // the child's own probe suite; that had to be inferred, not read.)
    flog(`cycle=${state.cycles} judgment-start model=${A.model || "pi-default"} provider=${A.provider || "pi-default"} timeout-sec=${A.timeoutSec} child status=${sJs ? sJs.status : "?"} toolCalls=${Number.isFinite(toolsAtJudgeStart) ? toolsAtJudgeStart : "?"}${sJs && sJs.lastTool ? ` last=${sJs.lastTool}` : ""}`);
    const stopHb = heartbeat(`cycle ${state.cycles} — the judge is deciding`);   // v0.24.3
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
    const jdur = Math.round((Date.now() - nowMs) / 1000);
    if (raced === "deadline" || raced === "child-deadline") {
      flog(`cycle=${state.cycles} judgment-end dur=${jdur}s outcome=killed-by-${raced} io=llm/cycle-${state.cycles}-judgment.{out,err}`);
      if (judgmentProc) { try { killLlmGroup(judgmentProc, "deadline-watcher"); } catch { /* best effort */ } }
      glog("!", 33, `cycle=${state.cycles} ${raced === "child-deadline" ? "worker deadline" : "deadline"} passed while the judge was deciding — the judgment was killed; the pre-checks take over`);
      saveState();
      continue;
    }
    const d = raced;
    flog(`cycle=${state.cycles} judgment-end dur=${jdur}s exit=${d.exitStatus} io=llm/cycle-${state.cycles}-judgment.{out,err}`);
    if (!d.okExit) {
      // pi itself failed (model 400 "not running", crash, timeout): log and
      // RETRY next cycle — the loop never dies on one bad LLM call
      // (the anti-BlockGame6 behavior)
      state.llmFailStreak += 1;
      glog("!", 33, `cycle=${state.cycles} judge failed (exit=${d.exitStatus} streak=${state.llmFailStreak}): ${(d.tail[d.tail.length - 1] || "").slice(0, 200)}`);
      saveState();
      if (A.once) process.exit(4);
      if (state.llmFailStreak >= A.llmFailMax) {
        glog("✗", 31, `judge down: ${state.llmFailStreak} consecutive failed cycles — giving up`);
        process.exit(4);
      }
    } else if (d.raw === "") {
      // pi exited 0 but printed nothing: suspicious — count as a failed cycle
      state.llmFailStreak += 1;
      glog("!", 33, `cycle=${state.cycles} llm-empty (streak=${state.llmFailStreak}) — no output at all`);
      saveState();
      if (A.once) process.exit(4);
      if (state.llmFailStreak >= A.llmFailMax) {
        glog("✗", 31, `judge down: ${state.llmFailStreak} consecutive empty cycles — giving up`);
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
      // v0.30.0: the stale-verdict veto covers DISTILL too — it is destructive
      // (the session is discarded), so the same "the disk can invalidate a
      // verdict" rule applies: progress while judging invalidates the snapshot.
      if ((d.decision === "STOP" || d.decision === "DISTILL") && Number.isFinite(tcNow) && Number.isFinite(toolsAtJudgeStart) && tcNow > toolsAtJudgeStart) {
        const vetoKind = d.decision;
        stopVetoed = { from: toolsAtJudgeStart, to: tcNow };
        d.decision = "OK";
        glog("!", 33, `cycle=${state.cycles} ${vetoKind} vetoed — the worker progressed while judging (toolCalls ${toolsAtJudgeStart}→${tcNow}) — stale verdict, treated as OK`);
        flog(`cycle=${state.cycles} decision=${vetoKind}-VETOED reason=${JSON.stringify(d.detail)}`);
      }
      // v0.21.0: the FULL reasoning goes to ralph-monitor.log (the permanent
      // record — format unchanged); the terminal gets a scannable tick line
      // plus the reasoning in dim type.
      if (d.text) flog(`cycle=${state.cycles} parent:\n${d.text}`);
      // a judgment whose final line was not DECISION: — treat as OK, log the anomaly
      const wasBadLine = !/^DECISION:\s*(OK|NUDGE|DISTILL|STOP)\b/i.test(d.raw || "");
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
        if (!nr.ok) flog(`cycle=${state.cycles} intervention could not be delivered (${nr.why || "unknown"})`);
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
      } else if (d.decision === "DISTILL") {
        // v0.30.0 P5a: context-rot judgment — the monitor's actuator is a
        // request file in the LIVE run dir; the child's guard consumes it and
        // distills + relaunches a fresh session (remaining wall clock). The
        // file is per-window (each window has its own run dir), so a stale
        // request can never land in a new window's dir.
        state.lastDecision = `DISTILL: ${d.detail}`;
        state.interventions += 1;
        const reqPath = path.join(A.runDir, "parent-distill.json");
        let distillResult = "requested";
        try {
          if (existsSync(reqPath)) {
            distillResult = "pending (request already on disk — leaving it)";
          } else {
            writeFileSync(reqPath, JSON.stringify({
              v: 1,
              at: new Date().toISOString(),
              reason: (d.detail || "no reason given").slice(0, 500),
              source: "parent-judgment",
              cycle: state.cycles,
            }, null, 2));
          }
        } catch (e) {
          distillResult = `write failed: ${e.message}`;
        }
        flog(`cycle=${state.cycles} decision=DISTILL interventions=${state.interventions} ${distillResult} reason=${JSON.stringify(d.detail)}`);
        tick(state.cycles, "DISTILL", d.detail, reasoning);
        tlog(`${C(2)}    ${distillResult === "requested" ? "distill request → " + reqPath : distillResult}${C(0)}`);
        if (state.interventions >= A.maxInterventions) {
          glog("✗", 31, `budget exhausted (${state.interventions}/${A.maxInterventions}) — stopping loop`);
          await writeFinalReport(`parent distill: intervention budget exhausted (${state.interventions}/${A.maxInterventions})`);
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
