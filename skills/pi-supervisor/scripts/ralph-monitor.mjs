#!/usr/bin/env node
// ralph-monitor.mjs — v0.19.5: the parent as a ralph loop.
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
  deadline: null, maxHours: 12, llmFailMax: 6, timeoutSec: 600,
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
// file: ISO-8601 UTC (machine-facing: sortable, TZ-proof, cross-artifact)
// terminal: LOCAL time `[YYYY-MM-DD HH:MM:SS.mmm]` (human-facing)
const localTs = (d) => { const p = (n, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`; };
const log = (line) => {
  appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
  process.stderr.write(`[${localTs(new Date())}] ${line}\n`);
};
process.on("SIGINT", () => { log("sigint: stopping"); saveState(); process.exit(130); });

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

// ---- deterministic pre-checks (run before any LLM call)
function preCheck(status) {
  const now = Date.now();
  if (deadlineMs !== null && now >= deadlineMs)
    return { stop: true, code: 4, reason: "deadline" };
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
  const r = await runCmd(A.pi, args, A.timeoutSec * 1000);
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
// completed/stale/deadline child is noticed within ~30s, not up to one full
// cycle later. The LLM judgment still only runs every --cycle-sec.
const POLL_SEC = 30;
let lastJudgment = 0; // 0 = judgment due immediately
(async () => {
for (;;) {
  const status = readStatus();
  const pc = preCheck(status);
  if (pc.stop) {
    log(`pre-check STOP: ${pc.reason} (cycle=${state.cycles} interventions=${state.interventions})`);
    saveState();
    process.exit(pc.code);
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
    log(`cycle=${state.cycles} dry-run: status=${status ? status.status : "absent"} toolCalls=${status ? status.toolCalls : "?"} — no LLM call`);
    saveState();
    if (A.once) process.exit(0);
  } else {
    const d = await llmDecide();
    if (!d.okExit) {
      // pi itself failed (model 400 "not running", crash, timeout): log and
      // RETRY next cycle — the loop never dies on one bad LLM call
      // (the anti-BlockGame6 behavior)
      state.llmFailStreak += 1;
      log(`cycle=${state.cycles} llm-failed (exit=${d.exitStatus} streak=${state.llmFailStreak}): ${(d.tail[d.tail.length - 1] || "").slice(0, 200)}`);
      saveState();
      if (A.once) process.exit(4);
      if (state.llmFailStreak >= A.llmFailMax) {
        log(`llm-down: ${state.llmFailStreak} consecutive failed cycles — giving up`);
        process.exit(4);
      }
    } else if (d.raw === "") {
      // pi exited 0 but printed nothing: suspicious — count as a failed cycle
      state.llmFailStreak += 1;
      log(`cycle=${state.cycles} llm-empty (streak=${state.llmFailStreak}) — no output at all`);
      saveState();
      if (A.once) process.exit(4);
      if (state.llmFailStreak >= A.llmFailMax) {
        log(`llm-down: ${state.llmFailStreak} consecutive empty cycles — giving up`);
        process.exit(4);
      }
    } else {
      state.llmFailStreak = 0;
      // the parent's full message, every cycle — terminal + ralph-monitor.log,
      // so the run dir keeps the reasoning, not just the terse decision line
      if (d.text) log(`cycle=${state.cycles} parent:\n${d.text}`);
      const wasBadLine = !/^DECISION:\s*(OK|NUDGE|STOP)\b/i.test(d.raw || "");
      if (d.decision === "OK") {
        state.lastDecision = "OK";
        log(`cycle=${state.cycles} decision=OK${wasBadLine ? " (note: final line was not DECISION:, treated as OK)" : ""}`);
      } else if (d.decision === "NUDGE") {
        state.lastDecision = `NUDGE: ${d.detail}`;
        state.interventions += 1;
        const nr = await deliverNudge(d.detail || "please continue and update STATUS.md");
        log(`cycle=${state.cycles} decision=NUDGE interventions=${state.interventions} delivered=${nr.ok}${nr.why ? " why=" + nr.why : ""} msg=${JSON.stringify(d.detail)}`);
        if (!nr.ok) {
          // delivery failed (dead guard, etc.) — the pre-checks will catch a
          // truly dead child next cycle; burn the budget slot, move on
        }
        if (state.interventions >= A.maxInterventions) {
          log(`budget exhausted (${state.interventions}/${A.maxInterventions}) — stopping loop`);
          saveState();
          process.exit(4);
        }
      } else if (d.decision === "STOP") {
        state.lastDecision = `STOP: ${d.detail}`;
        log(`cycle=${state.cycles} decision=STOP reason=${JSON.stringify(d.detail)}`);
        saveState();
        process.exit(4);
      } else {
        log(`cycle=${state.cycles} unknown-decision=${JSON.stringify(d.raw.slice(0, 120))} — treating as OK`);
        state.lastDecision = "unknown→OK";
      }
      saveState();
      if (A.once) process.exit(0);
    }
  }

  await sleep(Math.min(POLL_SEC * 1000, Math.max(5000, A.cycleSec * 1000 - (Date.now() - lastJudgment))));
}
})();
