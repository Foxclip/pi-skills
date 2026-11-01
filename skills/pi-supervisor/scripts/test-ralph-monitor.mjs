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
//
// Run:  node test-ralph-monitor.mjs [--keep]
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, chmodSync } from "node:fs";
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

// ---- R11: deadline past → exit 4, no LLM
{
  const d = runDir("r11");
  mkStatus(d);
  const past = String(Math.floor(Date.now() / 1000) - 60);
  const r = runRm(d, STUB_OK, ["--once", "--deadline", past]);
  report("R11 deadline past → exit 4, no LLM call",
    r.status === 4 && /deadline/.test(readLog(d)) && invLog("r11") === "",
    `exit=${r.status}`);
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

if (KEEP) console.log(`(kept artifacts in ${root})`);
else rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
