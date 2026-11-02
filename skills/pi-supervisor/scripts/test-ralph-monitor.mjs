#!/usr/bin/env node
// test-ralph-monitor.mjs — unit tests for ralph-monitor.mjs (v0.18.0).
//
// No model needed: `pi` is a stub node script (behavior baked in per case);
// the child is faked with a pi-child-status.json following guard.mjs's v:2
// contract. Live guard pid = the test runner's own pid (always alive);
// dead pid = 99999999.
//
//   R1  completed child (exitReason=completed) → exit 0, no LLM call
//   R2  completed child (exitReason=stuck)     → exit 5, no LLM call
//   R3  running, guard pid dead, age>60s      → exit 2 child-dead, no LLM
//   R4  running, status stale (>stale-sec)    → exit 2 child-stale, no LLM
//   R5  LLM DECISION: OK                      → exit 0 (--once), cycles=1
//   R6  LLM NUDGE, live guard                 → .steer-inbox file delivered
//   R7  LLM NUDGE, dead guard                 → delivered=false, budget slot used
//   R8  LLM DECISION: STOP                    → exit 4
//   R9  interventions budget exhausted        → exit 4, no LLM call
//   R10 stall (no toolCalls growth, seeded)   → exit 4, no LLM call
//   R11 deadline already past                 → exit 4, no LLM call
//   R12 progress reset (toolCalls grew)       → stall avoided, LLM OK → exit 0
//   R13 llm-failed cycles (continuous)        → loop survives, retries, recovers
//   R14 dry-run --once                        → no LLM call, exit 0
//   R15 llm-down (llmFailMax hit, continuous) → exit 4
//   R23 child lines: baseline + one per toolCalls CHANGE (5s poll, no dups)
//   R24 heartbeat while a judgment is in flight (RM_HEARTBEAT_SEC knob;
//       v0.25.3: child state = separate message after the parent-wait line)
//   R25 stale-STOP veto: child progressed while judging → STOP vetoed → OK (v0.25.1)
//   R26 child past its OWN deadline, finalizing → no judgments, completed → exit 0 (v0.25.1)
//   R27 child-deadline grace expiry → exit 4 + report, no judgments (v0.25.1)
//   R28 LIVE view present in the rendered judgment prompt (v0.25.1)
//   R29 child-deadline mid-judgment → judgment killed at child deadline (v0.25.2)
//   R30 child lines: baseline + per tool call + per minute while quiet (v0.25.5/7)
//   R31 child finalizing label once the child's own deadline passed (v0.25.6/7)
//   R32 ralph.sh flags: --task <path> + --cycle <duration> (v0.25.9)
//   R33 Ctrl+C in the ralph terminal stops the WHOLE run (v0.25.10)
//
// Run:  node test-ralph-monitor.mjs [--keep]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync, cpSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const KEEP = process.argv.includes("--keep");
const root = path.join(os.tmpdir(), `pi-sup-rm-${Date.now()}`);
mkdirSync(root, { recursive: true });

let failures = 0;
function report(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
  if (!ok) failures++;
}
const mkStatus = (dir, over = {}) => {
  const s = {
    v: 2, at: new Date().toISOString(), status: "running", guardPid: process.pid,
    childPid: process.pid + 1, attempt: 1, rewinds: 0, toolCalls: 3,
    lastTool: "bash", elapsedMs: 1000, sessionId: "fake-rm",
    ...over,
  };
  writeFileSync(path.join(dir, "pi-child-status.json"), JSON.stringify(s, null, 2));
  return s;
};
const mkStub = (name, body) => {
  const p = path.join(root, name);
  writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
const STUB_OK = mkStub("pi-ok.mjs", `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.RM_INV_LOG || "/dev/null", "OK-STUB\\n");
console.log("thinking about the child's progress...");
console.log("DECISION: OK");`);
const STUB_NUDGE = mkStub("pi-nudge.mjs", `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.RM_INV_LOG || "/dev/null", "NUDGE-STUB\\n");
console.log("DECISION: NUDGE: go run the self-test and commit");`);
const STUB_STOP = mkStub("pi-stop.mjs", `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.RM_INV_LOG || "/dev/null", "STOP-STUB\\n");
console.log("DECISION: STOP: the child is hopelessly off-track");`);
const STUB_FLAKY = mkStub("pi-flaky.mjs", `
import { appendFileSync, readFileSync, existsSync } from "node:fs";
const c = process.env.RM_CALLS || "/dev/null";
const n = existsSync(c) ? readFileSync(c, "utf8").trim().split("\\n").length : 0;
appendFileSync(c, n + "\\n");
if (n < 2) { console.error('Error: 400 model name=gemma-4-26B is not running'); process.exit(1); }
console.log("DECISION: OK");`);
const STUB_DEAD = mkStub("pi-dead.mjs", `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.RM_INV_LOG || "/dev/null", "DEAD-STUB\\n");
console.error('Error: 400 model name=Qwen3.8-27B-UD-Q3_K_XL is not running');
process.exit(1);`);
const STUB_SLOW = mkStub("pi-slow.mjs", `
import { spawnSync } from "node:child_process";
spawnSync("sleep", ["4"]);
console.log("DECISION: OK");`);
const STUB_SLOWER = mkStub("pi-slower.mjs", `
import { spawnSync } from "node:child_process";
spawnSync("sleep", ["12"]);
console.log("DECISION: OK");`);
// R26/R27: marker stub — records whether the call was a JUDGMENT or the final
// REPORT (by prompt content), so a test can prove NO judgment happened.
const STUB_INV = mkStub("pi-inv.mjs", `
import { appendFileSync } from "node:fs";
const p = process.argv[process.argv.length - 1];
appendFileSync(process.env.RM_INV_LOG || "/dev/null", (p.includes("final report writer") ? "REPORT" : "JUDGE") + "\\n");
console.log("thinking about the child's progress...");
console.log("DECISION: OK");`);
// R33: a `pi` that stays alive (child = sleeps; parent judgment = the same
// sleep, which is exactly what we want to prove the Ctrl+C handler kills).
const STUB_LIVE = mkStub("pi-live.mjs", `
import { spawnSync } from "node:child_process";
spawnSync("sleep", ["300"]);`);
const runDir = (name) => { const d = path.join(root, name); mkdirSync(d, { recursive: true }); return d; };
const rmArgs = (d, stub, extra = []) => [
  path.join(HERE, "ralph-monitor.mjs"),
  "--run-dir", d, "--pi", stub, "--cycle-sec", "5", ...extra,
];
const runRm = (d, stub, extra = []) =>
  spawnSync(NODE, rmArgs(d, stub, extra), { encoding: "utf8", timeout: 60_000 });
const readLog = (d) => { try { return readFileSync(path.join(d, "ralph-monitor.log"), "utf8"); } catch { return ""; } };
const readState = (d) => { try { return JSON.parse(readFileSync(path.join(d, "ralph-monitor-state.json"), "utf8")); } catch { return null; } };
const waitMs = (ms) => spawnSync("sleep", [String(Math.ceil(ms / 1000))], { timeout: ms + 5000 });
const invLog = (name) => { const p = path.join(root, `inv-${name}.log`); return existsSync(p) ? readFileSync(p, "utf8") : ""; };

// ---- R1: completed child → exit 0, no LLM
{
  const d = runDir("r1");
  mkStatus(d, { status: "completed", exitReason: "completed", guardPid: null, toolCalls: 225 });
  const r = runRm(d, STUB_OK, ["--once"]);
  report("R1 completed child → exit 0, no LLM call",
    r.status === 0 && invLog("r1") === "" && /child-terminal \(completed\)/.test(readLog(d)),
    `exit=${r.status} log=${readLog(d).trim().slice(0, 80)}`);
}

// ---- R17: completed-finalized child → exit 0 (the guard's normal
// finalization-window completion — exit-0 semantics on the guard side too)
{
  const d = runDir("r17");
  mkStatus(d, { status: "completed", exitReason: "completed-finalized", guardPid: null, toolCalls: 99 });
  const r = runRm(d, STUB_OK, ["--once"]);
  report("R17 completed-finalized child → exit 0",
    r.status === 0 && /child-terminal \(completed-finalized\)/.test(readLog(d)),
    `exit=${r.status} log=${readLog(d).trim().slice(0, 80)}`);
}

// ---- R2: failed child terminal → exit 5
{
  const d = runDir("r2");
  mkStatus(d, { status: "completed", exitReason: "stuck", guardPid: null });
  const r = runRm(d, STUB_OK, ["--once"]);
  report("R2 failed child terminal → exit 5",
    r.status === 5 && /child-terminal \(stuck\)/.test(readLog(d)),
    `exit=${r.status}`);
}

// ---- R3: guard dead, age>60s → exit 2
{
  const d = runDir("r3");
  mkStatus(d, { guardPid: 99999999, at: new Date(Date.now() - 120_000).toISOString() });
  const r = runRm(d, STUB_OK, ["--once"]);
  report("R3 guard dead → exit 2 child-dead",
    r.status === 2 && /child-dead/.test(readLog(d)),
    `exit=${r.status} log=${readLog(d).trim().slice(0, 80)}`);
}

// ---- R4: stale status → exit 2
{
  const d = runDir("r4");
  mkStatus(d, { at: new Date(Date.now() - 600_000).toISOString() });
  const r = runRm(d, STUB_OK, ["--once", "--stale-sec", "180"]);
  report("R4 stale status → exit 2 child-stale",
    r.status === 2 && /child-stale/.test(readLog(d)),
    `exit=${r.status}`);
}

// ---- R5: LLM OK cycle
{
  const d = runDir("r5");
  mkStatus(d);
  process.env.RM_INV_LOG = path.join(root, "inv-r5.log");
  const r = runRm(d, STUB_OK, ["--once"]);
  const st = readState(d);
  report("R5 LLM OK cycle → exit 0, cycles=1, decision=OK",
    r.status === 0 && st && st.cycles === 1 && st.lastDecision === "OK" && invLog("r5") === "OK-STUB\n",
    `exit=${r.status} state=${JSON.stringify(st)}`);
}

// ---- R6: NUDGE delivered to live guard via monitor.mjs --steer
{
  const d = runDir("r6");
  mkStatus(d); // guardPid = process.pid (alive)
  const r = runRm(d, STUB_NUDGE, ["--once"]);
  const inbox = path.join(d, ".steer-inbox");
  const files = existsSync(inbox) ? readdirSync(inbox).filter((f) => f.endsWith(".txt")) : [];
  const content = files.length ? readFileSync(path.join(inbox, files[0]), "utf8") : "";
  const st = readState(d);
  report("R6 NUDGE live → delivered to .steer-inbox/, interventions=1",
    r.status === 0 && files.length === 1 && content === "go run the self-test and commit"
    && st && st.interventions === 1,
    `exit=${r.status} files=${JSON.stringify(files)} interventions=${st && st.interventions}`);
}

// ---- R7: NUDGE to dead guard → delivered=false, still counted, exit 0
{
  const d = runDir("r7");
  mkStatus(d, { guardPid: 99999999 }); // fresh `at` → pre-check passes (age<60s)
  const r = runRm(d, STUB_NUDGE, ["--once"]);
  const inbox = path.join(d, ".steer-inbox");
  const files = existsSync(inbox) ? readdirSync(inbox).filter((f) => f.endsWith(".txt")) : [];
  const st = readState(d);
  report("R7 NUDGE dead guard → delivered=false, budget slot used, exit 0",
    r.status === 0 && files.length === 0 && /delivered=false/.test(readLog(d))
    && st && st.interventions === 1,
    `exit=${r.status} files=${JSON.stringify(files)}`);
}

// ---- R8: STOP decision → exit 4
{
  const d = runDir("r8");
  mkStatus(d);
  const r = runRm(d, STUB_STOP, ["--once"]);
  report("R8 LLM STOP → exit 4",
    r.status === 4 && /decision=STOP/.test(readLog(d)),
    `exit=${r.status}`);
}

// ---- R9: budget exhausted → exit 4, no LLM
{
  const d = runDir("r9");
  mkStatus(d);
  writeFileSync(path.join(d, "ralph-monitor-state.json"), JSON.stringify({
    startedAt: new Date().toISOString(), cycles: 5, interventions: 3,
    lastToolCalls: 10, lastProgressAt: new Date().toISOString(),
    lastDecision: "OK", llmFailStreak: 0,
  }));
  const r = runRm(d, STUB_OK, ["--once", "--max-interventions", "3"]);
  report("R9 budget exhausted → exit 4, no LLM call",
    r.status === 4 && /budget/.test(readLog(d)) && invLog("r9") === "",
    `exit=${r.status}`);
}

// ---- R10: stall (seeded state, no toolCalls growth) → exit 4, no LLM
{
  const d = runDir("r10");
  mkStatus(d, { toolCalls: 5 });
  writeFileSync(path.join(d, "ralph-monitor-state.json"), JSON.stringify({
    startedAt: new Date().toISOString(), cycles: 20, interventions: 0,
    lastToolCalls: 5, lastProgressAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
    lastDecision: "OK", llmFailStreak: 0,
  }));
  const r = runRm(d, STUB_OK, ["--once", "--stuck-sec", "3600"]);
  report("R10 stall → exit 4, no LLM call",
    r.status === 4 && /stalled/.test(readLog(d)) && invLog("r10") === "",
    `exit=${r.status}`);
}

// ---- R11: deadline past, child still running (v0.23.0: the monitor waits out
// the finalization window, grace-bounded — a short --finalize-grace-sec makes
// the expiry immediate here) → exit 4, no LLM
{
  const d = runDir("r11");
  mkStatus(d);
  const past = String(Math.floor(Date.now() / 1000) - 60);
  const r = runRm(d, STUB_OK, ["--once", "--deadline", past, "--finalize-grace-sec", "2"]);
  report("R11 deadline past + running child → grace expires → exit 4, no LLM",
    r.status === 4 && /deadline \(child still running after 2s grace\)/.test(readLog(d)) && invLog("r11") === "",
    `exit=${r.status} log=${readLog(d).trim().slice(0, 200)}`);
}

// ---- R12: progress resets stall → LLM runs → OK → exit 0
{
  const d = runDir("r12");
  mkStatus(d, { toolCalls: 6 });
  writeFileSync(path.join(d, "ralph-monitor-state.json"), JSON.stringify({
    startedAt: new Date().toISOString(), cycles: 20, interventions: 0,
    lastToolCalls: 5, lastProgressAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
    lastDecision: "OK", llmFailStreak: 0,
  }));
  const r = runRm(d, STUB_OK, ["--once", "--stuck-sec", "3600"]);
  const st = readState(d);
  report("R12 progress resets stall → LLM OK → exit 0",
    r.status === 0 && st && st.lastToolCalls === 6 && st.cycles === 21,
    `exit=${r.status} state=${JSON.stringify(st && { lastToolCalls: st.lastToolCalls, cycles: st.cycles })}`);
}

// ---- R14: dry-run --once → no LLM, exit 0
{
  const d = runDir("r14");
  mkStatus(d);
  const r = runRm(d, STUB_OK, ["--once", "--dry-run"]);
  report("R14 dry-run --once → exit 0, no LLM call",
    r.status === 0 && /dry-run/.test(readLog(d)) && invLog("r14") === "",
    `exit=${r.status}`);
}

// ---- R23: child heartbeat on every toolCalls change (v0.24.2)
{
  const d = runDir("r23");
  mkStatus(d, { toolCalls: 0 });
  const child = spawn(NODE, rmArgs(d, STUB_OK, ["--cycle-sec", "1000"]), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (x) => { err += x; });
  await waitMs(2500);             // baseline line printed (tc=0, v0.25.7)
  mkStatus(d, { toolCalls: 5 });  // "a tool call happened"
  await waitMs(6000);             // next poll (≤5s) → tool line for tc=5
  mkStatus(d, { toolCalls: 9 });  // one more
  await waitMs(6000);             // → tool line for tc=9
  child.kill("SIGINT");
  await new Promise((r) => child.on("exit", r));
  // v0.25.7: baseline line back (count + last + left) + one bright tool line
  // per change. No quiet lines — the 60s window never elapses (the anchor
  // resets on every tool line).
  const lines = err.split("\n").filter((l) => /· child running ·/.test(l));
  report("R23 child lines: baseline + one per toolCalls change (5s poll, no duplicates)",
    lines.length === 3
    && /· 0 tool calls · last: bash · \d+h \d+m left/.test(lines[0])
    && /· tool call 5: bash · \d+h \d+m left/.test(lines[1])
    && /· tool call 9: bash · \d+h \d+m left/.test(lines[2])
    && !lines.some((l) => /no new tool call/.test(l)),
    `lines=${lines.length} ${lines.map((b) => b.trim().slice(0, 70)).join(" | ").slice(0, 260)}`);
}

// ---- R24: heartbeat while a judgment is in flight (v0.24.3) — the loop
// BLOCKS in the LLM call, so without this the terminal goes silent for the
// whole judgment (run8: 8 minutes). RM_HEARTBEAT_SEC=2 → ticks at ~2s.
{
  const d = runDir("r24");
  mkStatus(d);
  const child = spawn(NODE, rmArgs(d, STUB_SLOW, ["--cycle-sec", "1000"]), {
    stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, RM_HEARTBEAT_SEC: "2" },
  });
  let err = "";
  child.stderr.on("data", (x) => { err += x; });
  await waitMs(8000);               // stub judgment takes ~4s; ticks at ~2s, ~4s
  child.kill("SIGINT");
  await new Promise((r) => child.on("exit", r));
  // v0.25.3: the child state is NO LONGER on the parent-wait line — it is the
  // SEPARATE message right after it.
  const lines = err.split("\n");
  const hb = lines.filter((l) => /… cycle 1 — parent judging · \d+s/.test(l));
  let pairs = 0;
  for (let i = 0; i < lines.length - 1; i++)
    if (/… cycle 1 — parent judging · \d+s/.test(lines[i]) && /· child running · 3 tool calls/.test(lines[i + 1])) pairs++;
  report("R24 heartbeat while a judgment is in flight (child state = separate message)",
    hb.length >= 1 && pairs >= 1 && !hb.some((l) => /· child running/.test(l)),
    `hb=${hb.length} pairs=${pairs} ${lines.filter((l) => /parent judging|· child running/.test(l)).map((l) => l.trim().slice(0, 70)).join(" | ").slice(0, 260)}`);
}

// ---- R13: llm-failed cycles in continuous mode → loop survives and recovers
{
  const d = runDir("r13");
  mkStatus(d);
  const calls = path.join(root, "r13-calls.txt");
  writeFileSync(calls, "");
  const child = spawn(NODE, rmArgs(d, STUB_FLAKY, []), {
    env: { ...process.env, RM_CALLS: calls }, stdio: ["ignore", "ignore", "ignore"],
  });
  const t0 = Date.now();
  let recovered = false, sawFail = false;
  while (Date.now() - t0 < 40_000) {
    const log = readLog(d);
    sawFail = /llm-failed/.test(log);
    recovered = /decision=OK/.test(log);
    if (recovered && sawFail) break;
    if (child.exitCode !== null) break;
    waitMs(500);
  }
  if (child.exitCode === null) child.kill("SIGINT");
  const st = readState(d);
  report("R13 llm-failed ×2 then recovery (continuous) — loop survived",
    sawFail && recovered && st && st.llmFailStreak === 0 && st.cycles >= 3,
    `streak=${st && st.llmFailStreak} cycles=${st && st.cycles} log=${readLog(d).trim().split("\\n").map(l => l.slice(0, 60)).join(" | ")}`);
}

// ---- R16: SIGINT mid-loop → exit 130, sigint logged (fires once the
// in-flight LLM call returns — spawnSync defers signal handling)
{
  const d = runDir("r16");
  mkStatus(d);
  const child = spawn(NODE, rmArgs(d, STUB_SLOW, []), {
    stdio: ["ignore", "ignore", "ignore"],
  });
  waitMs(2500); // let cycle 1 start (stub takes 4s)
  child.kill("SIGINT");
  const code = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (child.exitCode !== null) { clearInterval(iv); resolve(child.exitCode); }
      else if (Date.now() - t0 > 30_000) { child.kill("SIGKILL"); resolve("timeout"); }
    }, 300);
  });
  report("R16 SIGINT mid-loop → exit 130, sigint logged",
    code === 130 && /sigint/.test(readLog(d)),
    `exit=${code} log=${readLog(d).trim().split("\\n").map(l => l.slice(0, 60)).join(" | ")}`);
}

// ---- R15: llm-down (llmFailMax=2, always-failing stub, continuous) → exit 4
{
  const d = runDir("r15");
  mkStatus(d);
  const child = spawn(NODE, rmArgs(d, STUB_DEAD, ["--llm-fail-max", "2"]), {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const code = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (child.exitCode !== null) { clearInterval(iv); resolve(child.exitCode); }
      else if (Date.now() - t0 > 60_000) { child.kill("SIGINT"); resolve("timeout"); }
    }, 300);
  });
  report("R15 llm-down after 2 consecutive failures → exit 4",
    code === 4 && /llm-down/.test(readLog(d)),
    `exit=${code} log=${readLog(d).trim().split("\\n").map(l => l.slice(0, 60)).join(" | ")}`);
}

// ---- R21: deadline hits while a judgment is in flight (v0.23.0) — the
// judgment is KILLED (it would otherwise burn its --timeout-sec budget behind
// the child on a parallel=1 server, run4 shape), the loop hands off to the
// pre-checks, the grace window expires with the child still running, and the
// parent's final report still runs before exit 4.
{
  const d = runDir("r21");
  mkStatus(d, { status: "running" });
  // +5s (not +1s): it must land INSIDE the 12s judgment, but +1s could already
  // be in the past before the monitor spawns + first poll (floored epoch).
  const dl = Math.floor(Date.now() / 1000) + 5; // 5s: lands inside the 12s judgment
  const child = spawn(NODE, rmArgs(d, STUB_SLOWER, ["--deadline", String(dl), "--finalize-grace-sec", "2"]), {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const code = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (child.exitCode !== null) { clearInterval(iv); resolve(child.exitCode); }
      else if (Date.now() - t0 > 60_000) { child.kill("SIGINT"); resolve("timeout"); }
    }, 300);
  });
  const log = readLog(d);
  report("R21 deadline mid-judgment → judgment killed + grace expiry + final report → exit 4",
    code === 4 && /deadline passed while asking parent/.test(log) &&
      /child still running after 2s grace/.test(log) &&
      /final-report: written/.test(log) && existsSync(path.join(d, "FINAL-REPORT.md")),
    `exit=${code} log=${log.trim().split("\n").map((l) => l.slice(0, 80)).join(" | ")}`);
}

// ---- R22: deadline lands while the child is still finalizing (v0.23.0) — the
// monitor WAITS OUT the guard's finalization window (grace-bounded) instead of
// exiting immediately, then exits with the run's TRUE terminal state
// (completed-finalized → exit 0) and the parent's final report runs AFTER the
// child is dead (the model slot is free).
{
  const d = runDir("r22");
  const s = mkStatus(d, { status: "running" });
  const dl = Math.floor(Date.now() / 1000) + 4;
  const child = spawn(NODE, rmArgs(d, STUB_OK, ["--deadline", String(dl), "--finalize-grace-sec", "30"]), {
    stdio: ["ignore", "ignore", "ignore"],
  });
  await waitMs(6000); // after the deadline (t=4s): the guard "finishes" finalizing
  writeFileSync(path.join(d, "pi-child-status.json"),
    JSON.stringify({ ...s, status: "completed", exitReason: "completed-finalized", at: new Date().toISOString() }, null, 2));
  const code = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (child.exitCode !== null) { clearInterval(iv); resolve(child.exitCode); }
      else if (Date.now() - t0 > 60_000) { child.kill("SIGINT"); resolve("timeout"); }
    }, 300);
  });
  const log = readLog(d);
  // v0.25.4: the child's terminal state is announced as an EVENT before the
  // STOP line that reacts to it (R22 status: toolCalls=3, lastTool=bash).
  const evIdx = log.search(/child completed · 3 tool calls · last: bash/);
  const stopIdx = log.search(/pre-check STOP: deadline: child-terminal \(completed-finalized\)/);
  report("R22 deadline + child finalizing → grace wait → true state completed-finalized → exit 0 + report (event before STOP)",
    code === 0 && /deadline: child-terminal \(completed-finalized\)/.test(log) &&
      /final-report: written/.test(log) && existsSync(path.join(d, "FINAL-REPORT.md"))
      && evIdx !== -1 && stopIdx !== -1 && evIdx < stopIdx,
    `exit=${code} log=${log.trim().split("\n").map((l) => l.slice(0, 80)).join(" | ")}`);
}

// ---- R25: stale-STOP veto (v0.25.1, run9 shape) — the child makes tool
// calls WHILE the parent is deciding (the stub bumps toolCalls mid-judgment,
// exactly what the child's finalize turn did in run9); the STOP verdict is
// stale → vetoed → treated as OK → exit 0 (--once)
{
  const d = runDir("r25");
  mkStatus(d, { toolCalls: 0 });
  const stub = mkStub("pi-stop-progress.mjs", `
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
spawnSync("sleep", ["3"]);   // the parent is "thinking"…
const p = ${JSON.stringify(path.join(d, "pi-child-status.json"))};
const s = JSON.parse(readFileSync(p, "utf8"));
s.toolCalls = 5; s.at = new Date().toISOString();   // …and the child works
writeFileSync(p, JSON.stringify(s, null, 2));
console.log("DECISION: STOP: looks stuck");`);
  const r = runRm(d, stub, ["--once"]);
  const log = readLog(d);
  report("R25 stale-STOP veto: child progressed while judging → STOP vetoed → OK → exit 0",
    r.status === 0 && /decision=STOP-VETOED/.test(log)
      && /decision=OK \(after stale-STOP veto: toolCalls 0→5\)/.test(log),
    `exit=${r.status} log=${log.trim().split("\n").map((l) => l.slice(0, 80)).join(" | ")}`);
}

// ---- R26: child past its OWN deadline (status.deadlineIso — the monitor's
// deadline is 12h away, like run9), still finalizing (v0.25.1): NO judgment
// may happen; the pre-checks wait out the window and exit with the TRUE
// terminal state (completed-finalized → exit 0) + final report
{
  const d = runDir("r26");
  const inv = path.join(root, "inv-r26.log");
  writeFileSync(inv, "");
  const dlPast = new Date(Date.now() - 5000).toISOString();
  mkStatus(d, { toolCalls: 7, deadlineIso: dlPast });
  const child = spawn(NODE, rmArgs(d, STUB_INV, ["--finalize-grace-sec", "60"]), {
    stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, RM_INV_LOG: inv } });
  await waitMs(1500);   // the monitor is in the finalize wait; nothing may judge
  mkStatus(d, { toolCalls: 9, deadlineIso: dlPast, status: "completed", exitReason: "completed-finalized" });
  const code = await new Promise((resolve) => {   // waitExit is defined below — inline here
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (child.exitCode !== null) { clearInterval(iv); resolve(child.exitCode); }
      else if (Date.now() - t0 > 30_000) { child.kill("SIGKILL"); resolve("timeout"); }
    }, 300);
  });
  const log = readLog(d);
  const invs = readFileSync(inv, "utf8");
  report("R26 child-finalizing: judgments skipped, completed → exit 0 + report (no JUDGE)",
    code === 0 && /deadline: child-terminal \(completed-finalized\)/.test(log)
      && !/JUDGE/.test(invs) && /REPORT/.test(invs) && existsSync(path.join(d, "FINAL-REPORT.md")),
    `exit=${code} inv=${JSON.stringify(invs)} log=${log.trim().split("\n").map((l) => l.slice(0, 70)).join(" | ")}`);
}

// ---- R27: child past its OWN deadline, grace expires while it is still
// running (v0.25.1) → exit 4 + final report, and NO judgment happened
// (mirrors R11 for the child's deadline, which R11's --deadline can't express)
{
  const d = runDir("r27");
  const inv = path.join(root, "inv-r27.log");
  writeFileSync(inv, "");
  mkStatus(d, { toolCalls: 7, deadlineIso: new Date(Date.now() - 60_000).toISOString() });
  process.env.RM_INV_LOG = inv;
  const r = runRm(d, STUB_INV, ["--finalize-grace-sec", "2"]);
  process.env.RM_INV_LOG = "";
  const log = readLog(d);
  report("R27 child-deadline grace expiry → exit 4 + report, no judgment",
    r.status === 4 && /child still running after 2s grace/.test(log)
      && readFileSync(inv, "utf8") === "REPORT\n" && existsSync(path.join(d, "FINAL-REPORT.md")),
    `exit=${r.status} log=${log.trim().split("\n").map((l) => l.slice(0, 70)).join(" | ")}`);
}

// ---- R28: LIVE view in the rendered judgment prompt (v0.25.1) — the
// monitor-observed block (status/toolCalls/lastTool + deadline state) is
// present and fresh (read at prompt-build time)
{
  const d = runDir("r28");
  const pf = path.join(root, "r28-prompt.txt");
  const stub = mkStub("pi-capture.mjs", `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pf)}, process.argv[process.argv.length - 1]);
console.log("DECISION: OK");`);
  mkStatus(d, { toolCalls: 4, lastTool: "bash", lastToolStartedAt: new Date().toISOString(),
    deadlineIso: new Date(Date.now() + 2 * 3600e3).toISOString() });
  const r = runRm(d, stub, ["--once"]);
  const prompt = existsSync(pf) ? readFileSync(pf, "utf8") : "";
  report("R28 LIVE view in judgment prompt (status/toolCalls/lastTool/deadline state)",
    r.status === 0 && prompt.includes("LIVE (monitor-observed at")
      && prompt.includes("toolCalls=4") && prompt.includes("lastTool=bash@")
      && /child deadline .* in 2h/.test(prompt),
    `exit=${r.status} live=${/LIVE \(monitor-observed/.test(prompt)} toolCalls=${prompt.includes("toolCalls=4")}`);
}

// ---- R29: the child's OWN deadline passes mid-judgment (v0.25.2, run10
// shape) — the judgment hangs (12s stub) PAST the child's 4s deadline; the
// watcher must kill it at the CHILD's deadline (not the monitor's 12h
// default, not the 600s --timeout-sec), then the pre-checks own the wait:
// child → completed-finalized → exit 0 + final report
{
  const d = runDir("r29");
  const cdIso = new Date(Date.now() + 4000).toISOString();
  mkStatus(d, { toolCalls: 0, deadlineIso: cdIso });
  const child = spawn(NODE, rmArgs(d, STUB_SLOWER, []), { stdio: ["ignore", "ignore", "ignore"] });
  await waitMs(9000);   // child deadline (4s) + watcher poll (5s) → judgment killed by ~9s
  mkStatus(d, { toolCalls: 0, deadlineIso: cdIso, status: "completed", exitReason: "completed-finalized" });
  const code = await new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (child.exitCode !== null) { clearInterval(iv); resolve(child.exitCode); }
      else if (Date.now() - t0 > 45_000) { child.kill("SIGKILL"); resolve("timeout"); }
    }, 300);
  });
  const log = readLog(d);
  report("R29 child-deadline mid-judgment → judgment killed at child deadline → completed → exit 0 + report",
    code === 0 && /child deadline passed while asking parent — judgment killed/.test(log)
      && /deadline: child-terminal \(completed-finalized\)/.test(log)
      && /final-report: written/.test(log) && existsSync(path.join(d, "FINAL-REPORT.md")),
    `exit=${code} log=${log.trim().split("\n").map((l) => l.slice(0, 80)).join(" | ")}`);
}

// ---- R30: the two child line types (v0.25.5) — (A) per tool call, (B) every
// minute while quiet (RM_QUIET_SEC knob). Timeline: baseline (tc=0) → quiet
// line at ~10s → tool line (tc 0→4, anchor resets) → quiet line again.
{
  const d = runDir("r30");
  mkStatus(d, { toolCalls: 0 });
  process.env.RM_QUIET_SEC = "6";
  const child = spawn(NODE, rmArgs(d, STUB_OK, ["--cycle-sec", "1000"]), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (x) => { err += x; });
  await waitMs(14000);            // baseline (tc=0) + one quiet line (~10s)
  mkStatus(d, { toolCalls: 4 });  // a tool call happened
  await waitMs(4000);             // → type-A line (tc=4)
  await waitMs(9000);             // quiet again after the tool call → one more
  child.kill("SIGINT");
  await new Promise((r) => child.on("exit", r));
  delete process.env.RM_QUIET_SEC;
  // v0.25.7 shapes: baseline = `· child running · 0 tool calls · last: bash · …left`;
  // tool line = `· child running · tool call 4: bash · …left` (bright);
  // quiet line = `· child running · N tool calls · no new tool call for … · last: bash · …left`.
  const lines = err.split("\n").filter((l) => /· child running ·/.test(l));
  const toolLines = lines.filter((l) => /· tool call 4: bash/.test(l));
  const quiet = lines.filter((l) => /· no new tool call for \d+s/.test(l));
  const baseline = lines.filter((l) => /· 0 tool calls · last: bash · \d+h/.test(l));
  report("R30 child lines: baseline + per tool call + every minute while quiet (v0.25.7)",
    baseline.length === 1 && toolLines.length === 1
    && quiet.length >= 2 && quiet.length <= 3
    && lines.length === 2 + quiet.length
    && /0 tool calls · no new tool call for 10s · last: bash/.test(quiet[0])
    && /4 tool calls · no new tool call for 10s · last: bash/.test(quiet[1]),
    `lines=${lines.map((b) => b.trim().slice(0, 70)).join(" | ").slice(0, 340)}`);
}

// ---- R31: child finalizing label (v0.25.6) — the child's own deadline
// (status.deadlineIso, guard-written) has passed and the child is still
// running: the guard aborted the work turn and sent the finalize prompt, so
// the child lines say "child finalizing" instead of "child running".
{
  const d = runDir("r31");
  const cd = new Date(Date.now() + 2000).toISOString();
  mkStatus(d, { toolCalls: 1, deadlineIso: cd });
  const child = spawn(NODE, rmArgs(d, STUB_OK, ["--cycle-sec", "1000"]), {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (x) => { err += x; });
  await waitMs(4000);             // deadline passes; no tool call → no line yet
  // deadlineIso must be passed AGAIN — mkStatus rewrites the whole file.
  mkStatus(d, { toolCalls: 2, deadlineIso: cd });  // a tool call inside the finalize window
  await waitMs(4000);             // → "child finalizing · tool call 2: bash"
  child.kill("SIGINT");
  await new Promise((r) => child.on("exit", r));
  const lines = err.split("\n");
  report("R31 child finalizing label (past deadlineIso + running) — baseline + tool line",
    lines.some((l) => /· child running · 1 tool call · last: bash · \d+h/.test(l))
    && lines.some((l) => /· child finalizing · tool call 2: bash · \d+h/.test(l))
    && lines.filter((l) => /· child running ·/.test(l)).length === 1,
    `lines=${lines.filter((l) => /child (running|finalizing)/.test(l)).map((b) => b.trim().slice(0, 70)).join(" | ").slice(0, 260)}`);
}

// ================= RALPH.SH integration (v0.21.0 terminal design) =================
// sandbox: ralph.sh + ralph-monitor.mjs + stop.mjs + lib/ copied into root/sbx/scripts,
// launch.mjs REPLACED with a stub (writes launch-args.txt, spawns a detached
// `sleep 600` child, writes a v:2 status file) — no real pi child is ever started.
const sbx = path.join(root, "sbx", "scripts");
mkdirSync(sbx, { recursive: true });
for (const f of ["ralph.sh", "ralph-monitor.mjs", "stop.mjs"]) cpSync(path.join(HERE, f), path.join(sbx, f));
cpSync(path.join(HERE, "lib"), path.join(sbx, "lib"), { recursive: true });
chmodSync(path.join(sbx, "ralph.sh"), 0o755);
writeFileSync(path.join(sbx, "launch.mjs"), `
import fs from "fs"; import path from "path"; import { spawn } from "child_process";
const a = process.argv.slice(2);
const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
const out = get("--out-dir");
fs.writeFileSync(path.join(out, "launch-args.txt"), JSON.stringify({ deadline: get("--deadline"), model: get("--model"), provider: get("--provider"), parentModel: process.env.PARENT_MODEL || null, taskFile: get("--task-file") }, null, 2));
const s = spawn("sleep", ["600"], { detached: true, stdio: "ignore" }); s.unref();
fs.writeFileSync(path.join(out, "pi-child-status.json"), JSON.stringify({ v: 2, at: new Date().toISOString(), status: "running", exitReason: null, guardPid: s.pid, childPid: s.pid, attempt: 1, rewinds: 0, toolCalls: 0, elapsedMs: 0, deadlineIso: new Date(Date.now() + 3600e3).toISOString() }));
console.log(JSON.stringify({ launched: true, guardPid: s.pid }));
`);
const SBX_RALPH = path.join(sbx, "ralph.sh");
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const waitExit = (p, ms) => new Promise((resolve) => {
  if (p.exitCode !== null) return resolve(p.exitCode);
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (p.exitCode !== null) { clearInterval(iv); resolve(p.exitCode); }
    else if (Date.now() - t0 > ms) { try { p.kill("SIGKILL"); } catch {} resolve("timeout"); }
  }, 100);
});

// R18 zero-arg launch: context banner, human deadline, short-ts terminal lines,
// no epoch leak, flags reach launch.mjs, monitor log file format unchanged
{
  const proj = path.join(root, "p18"); mkdirSync(proj, { recursive: true });
  writeFileSync(path.join(proj, "TASK.md"), "# T18 task");
  const dl = String(Math.floor(Date.now() / 1000) + 7200);
  const logf = path.join(root, "r18.log");
  const child = spawn("bash", [SBX_RALPH], { cwd: proj, stdio: ["ignore", "ignore", openSync(logf, "w")],
    env: { ...process.env, PI: STUB_OK, DEADLINE: dl, CHILD_MODEL: "cm-e2e", PARENT_MODEL: "pm-e2e", CYCLE_SEC: "1" } });
  await sleepMs(4000);   // banner + launch + a couple of cycles
  const rd = path.join(proj, ".pi-supervisor", "runs", "run1");
  let st = { childPid: null };
  try { st = JSON.parse(readFileSync(path.join(rd, "pi-child-status.json"), "utf8")); } catch {}
  // kill the MONITOR only (unique pattern; escaped dot avoids self-matching this shell)
  const monPids = spawnSync("pgrep", ["-f", `ralph-monitor\\.mjs --run-dir ${rd}`], { encoding: "utf8" }).stdout.trim();
  for (const p of monPids.split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGTERM"); } catch {} }
  const rc18 = await waitExit(child, 15000);
  try { if (st.childPid) process.kill(st.childPid, "SIGKILL"); } catch {}
  const out = readFileSync(logf, "utf8");
  let la = null;
  try { la = JSON.parse(readFileSync(path.join(rd, "launch-args.txt"), "utf8")); } catch {}
  let mlog = "";
  try { mlog = readFileSync(path.join(rd, "ralph-monitor.log"), "utf8"); } catch {}
  const relDlOk = /\(in 2h/.test(out);
  const shortTsOk = /\[[0-9]{2}:[0-9]{2}:[0-9]{2}\] /.test(out);
  const epochLeak = /deadline=\d+/.test(out);
  const fileFmtOk = /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] cycle=1/.test(mlog);
  // v0.24.0: harvest lines are glyphed (✓/✗/·/!) with the short ts — no more
  // `harvest:` source prefix. (v0.25.6: no beat line expected here — the stub
  // child makes no tool calls and the baseline line is gone.)
  const hlines = out.split("\n").filter((l) => /— status=.*RUN-REPORT\.md/.test(l));
  const harvestShortOk = hlines.length > 0 && hlines.every((l) => /^\[\d{2}:\d{2}:\d{2}\] .*— status=/.test(l));
  report("R18 ralph.sh: banner + human deadline + short-ts lines + flags→launch.mjs + ISO file format",
    out.includes("┌ ralph") && out.includes("│ project") && relDlOk
    && shortTsOk && !epochLeak && /done · exit/.test(out)
    && la && la.deadline === dl && la.model === "cm-e2e" && la.parentModel === "pm-e2e"
    && fileFmtOk && harvestShortOk,
    `rc=${rc18} banner=${out.includes("┌ ralph")} relDl=${relDlOk} shortTs=${shortTsOk} epochLeak=${epochLeak} closer=${/done · exit/.test(out)} launch=${JSON.stringify(la)} fileFmt=${fileFmtOk} harvest=${harvestShortOk}(${hlines.length})`);
}

// R19 power-user attach: pre-check completed → exit 0, parent writes FINAL-REPORT.md,
// ralph.sh prints it boxed
{
  const proj = path.join(root, "p19"); const rd = path.join(proj, "run1");
  mkdirSync(rd, { recursive: true });
  writeFileSync(path.join(proj, "TASK.md"), "# T19");
  writeFileSync(path.join(rd, "pi-child-status.json"), JSON.stringify({ v: 2, at: new Date().toISOString(), status: "completed", exitReason: "completed", guardPid: 999999, childPid: 999999, attempt: 1, rewinds: 0, toolCalls: 5, elapsedMs: 1234, deadlineIso: new Date(Date.now() + 3600e3).toISOString() }));
  writeFileSync(path.join(rd, "pi-child-progress.log"), "tool line 1\ntool line 2\n");
  const logf = path.join(root, "r19.log");
  const child = spawn("bash", [SBX_RALPH, rd], { cwd: proj, stdio: ["ignore", "ignore", openSync(logf, "w")],
    env: { ...process.env, PI: STUB_OK, NO_COLOR: "1" } });
  const rc19 = await waitExit(child, 25000);
  const out = readFileSync(logf, "utf8");
  const rep = existsSync(path.join(rd, "FINAL-REPORT.md")) ? readFileSync(path.join(rd, "FINAL-REPORT.md"), "utf8") : "";
  report("R19 attach: completed pre-check → exit 0 + FINAL-REPORT.md + boxed in terminal",
    rc19 === 0 && rep.length > 0 && out.includes("┌ final report (parent)") && out.includes("│ thinking about") && /done · exit 0/.test(out),
    `rc=${rc19} report=${rep.length}B boxed=${out.includes("┌ final report (parent)")} closer=${/done · exit 0/.test(out)} outTail=${out.trim().split("\n").slice(-3).join(" | ").slice(0, 120)}`);

  // R20 pty → ANSI colors; NO_COLOR → plain
  const ttyLog = path.join(root, "r20.tty"), plainLog = path.join(root, "r20.plain");
  spawnSync("bash", ["-c", `cd ${proj} && PI=${STUB_OK} script -qec "bash ${SBX_RALPH} ${rd}" /dev/null > ${ttyLog} 2>&1 || true`], { timeout: 60000 });
  spawnSync("bash", ["-c", `cd ${proj} && PI=${STUB_OK} NO_COLOR=1 script -qec "bash ${SBX_RALPH} ${rd}" /dev/null > ${plainLog} 2>&1 || true`], { timeout: 60000 });
  const t = readFileSync(ttyLog, "utf8"), pl = readFileSync(plainLog, "utf8");
  // v0.24.1: success closer is GREEN (was bold white); failure closer is red
  const greenDone = t.includes("\x1b[32m✓ done · exit 0");
  report("R20 pty → colored banner + box + green success closer; NO_COLOR → plain",
    t.includes("\x1b[") && t.includes("┌ ralph") && greenDone && pl.includes("┌ ralph") && !pl.includes("\x1b["),
    `ttyEsc=${t.includes("\x1b[")} plainEsc=${pl.includes("\x1b[")} ttyBanner=${t.includes("┌ ralph")} plainBanner=${pl.includes("┌ ralph")} greenDone=${greenDone}`);
}

// R32 ralph.sh flags (v0.25.9): --task <path> points the child at a non-default
// task file; --cycle <duration> sets the parent's judgment period (2h30m → --cycle-sec 9000)
{
  const proj = path.join(root, "p32"); mkdirSync(proj, { recursive: true });
  writeFileSync(path.join(proj, "mytask.md"), "# T32 task");   // deliberately NOT TASK.md
  const dl = String(Math.floor(Date.now() / 1000) + 7200);
  const logf = path.join(root, "r32.log");
  const child = spawn("bash", [SBX_RALPH, "--task", "mytask.md", "--cycle", "2h30m"], {
    cwd: proj, stdio: ["ignore", "ignore", openSync(logf, "w")],
    env: { ...process.env, PI: STUB_OK, DEADLINE: dl, CHILD_MODEL: "cm-e2e", PARENT_MODEL: "pm-e2e" } });
  await sleepMs(4000);   // banner + launch + first cycle
  const rd = path.join(proj, ".pi-supervisor", "runs", "run1");
  // the monitor is in its first sleep (2h30m cycle) — its cmdline still carries the flag
  const monCmd = spawnSync("pgrep", ["-af", `ralph-monitor\\.mjs --run-dir ${rd}`], { encoding: "utf8" }).stdout;
  let st = { childPid: null };
  try { st = JSON.parse(readFileSync(path.join(rd, "pi-child-status.json"), "utf8")); } catch {}
  const monPids = spawnSync("pgrep", ["-f", `ralph-monitor\\.mjs --run-dir ${rd}`], { encoding: "utf8" }).stdout.trim();
  for (const p of monPids.split("\n").filter(Boolean)) { try { process.kill(Number(p), "SIGTERM"); } catch {} }
  const rc32 = await waitExit(child, 15000);
  try { if (st.childPid) process.kill(st.childPid, "SIGKILL"); } catch {}
  const out = readFileSync(logf, "utf8");
  let la = null;
  try { la = JSON.parse(readFileSync(path.join(rd, "launch-args.txt"), "utf8")); } catch {}
  report("R32 ralph.sh flags: --task mytask.md → launch.mjs, --cycle 2h30m → --cycle-sec 9000",
    la && la.taskFile === "mytask.md"
    && /cycle every 2h 30m/.test(out)
    && /--cycle-sec 9000/.test(monCmd),
    `rc=${rc32} taskFile=${la ? la.taskFile : "n/a"} banner2h30m=${/cycle every 2h 30m/.test(out)} monitor9000=${/--cycle-sec 9000/.test(monCmd)} monCmd=${(monCmd.trim().split("\n")[0] || "").slice(0, 120)}`);
}

// R33 Ctrl+C (v0.25.10): SIGINT to ralph.sh stops the monitor AND the detached
// guard + child, then the usual harvest (RUN-REPORT.md) — rc 130
{
  const proj = path.join(root, "p33"); mkdirSync(proj, { recursive: true });
  writeFileSync(path.join(proj, "TASK.md"), "# T33");
  const dl = String(Math.floor(Date.now() / 1000) + 7200);
  const logf = path.join(root, "r33.log");
  const child = spawn("bash", [SBX_RALPH], {
    cwd: proj, stdio: ["ignore", "ignore", openSync(logf, "w")],
    env: { ...process.env, PI: STUB_LIVE, DEADLINE: dl, CHILD_MODEL: "cm-e2e", PARENT_MODEL: "pm-e2e" } });
  await sleepMs(4000);   // child launched, monitor in its (stuck) first judgment
  const rd = path.join(proj, ".pi-supervisor", "runs", "run1");
  let st = {};
  try { st = JSON.parse(readFileSync(path.join(rd, "pi-child-status.json"), "utf8")); } catch {}
  child.kill("SIGINT");            // = the user's Ctrl+C (to ralph.sh)
  const rc33 = await waitExit(child, 20000);
  await sleepMs(1000);             // let stop.mjs's kills + harvest settle
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const guardDead = !alive(st.guardPid);
  const monLeft = spawnSync("pgrep", ["-f", `ralph-monitor\\.mjs --run-dir ${rd}`], { encoding: "utf8" }).stdout.trim();
  const out = readFileSync(logf, "utf8");
  report("R33 Ctrl+C stops the whole run: rc=130, monitor + guard + child dead, harvested",
    rc33 === 130 && guardDead && monLeft === ""
    && existsSync(path.join(rd, "RUN-REPORT.md"))
    && /stopping the run/.test(out),
    `rc=${rc33} guard=${st.guardPid ?? "?"} guardDead=${guardDead} monitorLeft=${monLeft ? "YES" : "no"} report=${existsSync(path.join(rd, "RUN-REPORT.md"))}`);
}

if (KEEP) console.log(`(kept artifacts in ${root})`);
else rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
