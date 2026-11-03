#!/usr/bin/env node
// test-chain.mjs — the sub-runs chain step (v0.26.0, plan §5.3).
//
// Runs chain.mjs from a SANDBOXED copy of scripts/ whose launch.mjs is a STUB:
// it records its args, writes the pi-child-status.json + active.json the real
// one would, and spawns `sleep 217` as a fake live guard. No real guard/pi.
//
// Covers the terminal table (all rows), spawn request handling (valid / join /
// invalid / deadline-expired / launch failure), idempotency, and the allocator.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sup-chain-"));

// ---------- sandbox: real scripts + stub launch.mjs ----------
const S = path.join(T, "scripts");
fs.cpSync(HERE, S, { recursive: true });
fs.writeFileSync(path.join(S, "launch.mjs"), `#!/usr/bin/env node
// stub launch.mjs for test-chain: same observable contract as the real one
// (status file + active.json + a live process), no guard.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { activePath, writeJson } from "./lib/node.mjs";
const a = process.argv.slice(2);
const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
const out = get("--out-dir");
const project = get("--project") || process.cwd();
const node = get("--node");
const deadline = get("--deadline");
fs.writeFileSync(path.join(out, "launch-args.txt"), a.join(" ") + "\\n");
if (fs.existsSync(path.join(project, ".pi-supervisor", "launch-fail"))) {
  console.error("stub-launch: forced failure (launch-fail marker)");
  process.exit(2);
}
const s = spawn("sleep", ["217"], { detached: true, stdio: "ignore" });
s.unref();
fs.writeFileSync(path.join(out, "pi-child-status.json"), JSON.stringify({
  v: 2, at: new Date().toISOString(), status: "running",
  guardPid: s.pid, childPid: s.pid, attempt: 1,
  deadlineIso: deadline ? new Date(Number(deadline) * 1000).toISOString() : null,
}, null, 2));
try {
  writeJson(activePath(project), {
    run_dir: out, node: node || "(root)", guard_pid: s.pid,
    window: path.basename(out), started_at: new Date().toISOString(),
    deadline: deadline ? new Date(Number(deadline) * 1000).toISOString() : null,
  });
} catch { /* best effort */ }
console.log(JSON.stringify({ launched: true, pid: s.pid }));
`);
const { step } = await import(pathToFileURL(path.join(S, "lib", "chain.mjs")).href);
const { allocWindow, readNode, activePath } = await import(pathToFileURL(path.join(S, "lib", "node.mjs")).href);

// ---------- harness ----------
let passed = 0, failed = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`PASS: ${name}`); }
  else { failed++; fails.push(name); console.log(`FAIL: ${name}${extra ? " — " + extra : ""}`); }
}
const CFG = { launch: { runtimeMin: 60, idleTimeoutSec: 300, turnStallSec: 900, finalizeMin: 5 } };
const ISO = (ms) => new Date(ms).toISOString();
const inMin = (m) => Date.now() + m * 60000;
const deadPid = () => spawnSync(process.execPath, ["-e", "0"]).pid;

function mkproj(name) {
  const p = path.join(T, name);
  fs.mkdirSync(path.join(p, ".pi-supervisor", "runs"), { recursive: true });
  return p;
}
const R = (p, rel) => path.join(p, ".pi-supervisor/runs", rel);
function mkWindow(proj, rel, st) { // rel is under the runs root: "run-1" | "auth/run-1"
  const dir = R(proj, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "TASK.md"), `# task ${rel}\ndo the work\n`);
  const base = { v: 2, at: ISO(Date.now() - 60000), guardPid: deadPid(), deadlineIso: ISO(inMin(120)) };
  fs.writeFileSync(path.join(dir, "pi-child-status.json"), JSON.stringify({ ...base, ...st }, null, 2));
  return dir;
}
function mkNode(proj, nodePath, extra = {}) { // root: "(root)" → runs/node.json
  const runs = path.join(proj, ".pi-supervisor", "runs");
  const parts = nodePath === "(root)" ? [] : String(nodePath).split("/");
  const dir = path.join(runs, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "node.json"), JSON.stringify({ v: 1, nodePath, state: "active", ...extra }, null, 2));
}
const readMarker = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "chain-done.json"), "utf8"));
const nodeState = (proj, nodePath) => readNode(proj, nodePath)?.state ?? null;
const active = (proj) => { try { return JSON.parse(fs.readFileSync(activePath(proj), "utf8")); } catch { return null; } };

// ================= T1 — root completed (guard-driven) → done, idle, no launch
{
  const p = mkproj("t1-root-done");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  const r = await step(p, w, CFG);
  ok("T1 kind completed", r.kind === "completed", JSON.stringify(r));
  ok("T1 outcome idle", r.outcome?.next === "idle", JSON.stringify(r.outcome));
  ok("T1 root node done", nodeState(p, "(root)") === "done");
  ok("T1 marker written", readMarker(w).kind === "completed");
  ok("T1 no second window", !fs.existsSync(R(p, "run-2")));
  ok("T1 active cleared", active(p) === null);
}

// ============ T2 — valid spawn from completed root → child window 1 launched
{
  const p = mkproj("t2-spawn");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  const taskFile = path.join(T, "t2-task.md");
  fs.writeFileSync(taskFile, "implement the auth sub-project\n");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "auth", task: taskFile, runtime_min: 30, deadline: null,
    reason: "auth is the first sub-project", at: ISO(Date.now()),
  }));
  const r = await step(p, w, CFG);
  ok("T2 spawn honored", r.outcome?.next === "spawned", JSON.stringify(r));
  const d = JSON.parse(fs.readFileSync(path.join(w, "spawn-decision.json"), "utf8"));
  ok("T2 decision ok", d.ok === true, JSON.stringify(d));
  ok("T2 child window 1 dir", d.window === "run-1" && fs.existsSync(d.run_dir));
  ok("T2 child node dir + task.md", fs.existsSync(R(p, "auth/node.json"))
    && fs.readFileSync(R(p, "auth/task.md"), "utf8").includes("auth sub-project"));
  ok("T2 child TASK.md is a sub brief", fs.readFileSync(path.join(d.run_dir, "TASK.md"), "utf8").includes("auth"));
  ok("T2 parent paused(waiting:auth)", nodeState(p, "(root)") === "paused(waiting:auth)");
  ok("T2 child node active", nodeState(p, "auth") === "active");
  const act = active(p);
  ok("T2 active.json → child window", act && act.node === "auth" && act.window === "run-1");
  ok("T2 child got deadline ≤ parent deadline", d.deadline <= ISO(inMin(31)) && d.deadline > ISO(inMin(20)), d.deadline);
}

// ============ T3 — join-or-create: two spawns of the same name → one node, two windows
{
  const p = mkproj("t3-join");
  mkNode(p, "(root)", { deadline: ISO(inMin(240)) });
  const taskFile = path.join(T, "t3-task.md");
  fs.writeFileSync(taskFile, "do the shared work\n");
  const req = { kind: "spawn", node: "shared", task: taskFile, runtime_min: 30, deadline: null, reason: "r", at: ISO(Date.now()) };
  const w1 = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w1, "spawn-request.json"), JSON.stringify(req));
  const r1 = await step(p, w1, CFG);
  const w2 = mkWindow(p, "run-2", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w2, "spawn-request.json"), JSON.stringify(req));
  const r2 = await step(p, w2, CFG);
  ok("T3 first spawn ok", r1.outcome?.next === "spawned" && r1.outcome.window === "run-1", JSON.stringify(r1.outcome));
  ok("T3 second spawn ok", r2.outcome?.next === "spawned" && r2.outcome.window === "run-2", JSON.stringify(r2.outcome));
  const wins = fs.readdirSync(R(p, "shared")).filter((f) => /^run-\d+$/.test(f)).sort();
  ok("T3 one node, two windows", JSON.stringify(wins) === JSON.stringify(["run-1", "run-2"]), JSON.stringify(wins));
  ok("T3 joined brief is continuation-style", fs.readFileSync(R(p, "shared/run-2/TASK.md"), "utf8").includes("Task (the node's task file, unchanged)"));
}

// ================= T4 — sub completed → node done + parent RE-ENTRY launched
{
  const p = mkproj("t4-reentry");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)), state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(90)) });
  mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" }); // root's spawn window
  mkWindow(p, "auth/run-1", { status: "completed", exitReason: "completed-finalized" });
  const w = R(p, "auth/run-1");
  const r = await step(p, w, CFG);
  ok("T4 reentry launched", r.outcome?.next === "reentry" && r.outcome?.node_path === "(root)", JSON.stringify(r.outcome));
  ok("T4 root re-entry window run-2", r.outcome?.window === "run-2" && fs.existsSync(R(p, "run-2")));
  ok("T4 re-entry brief", fs.readFileSync(R(p, "run-2/TASK.md"), "utf8").includes("RE-ENTRY"));
  ok("T4 auth done", nodeState(p, "auth") === "done");
  ok("T4 root active", nodeState(p, "(root)") === "active");
  const act = active(p);
  ok("T4 active.json → root re-entry", act && act.node === "(root)" && act.window === "run-2");
}

// ============ T5 — root budget-used, node deadline NOT expired → continuation
{
  const p = mkproj("t5-continuation");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "hard-timeout", deadlineIso: ISO(Date.now() - 5000) });
  const r = await step(p, w, CFG);
  ok("T5 continuation launched", r.outcome?.next === "continuation" && r.outcome?.window === "run-2", JSON.stringify(r.outcome));
  ok("T5 continuation brief", fs.readFileSync(R(p, "run-2/TASK.md"), "utf8").includes("CONTINUATION"));
  ok("T5 root active", nodeState(p, "(root)") === "active");
  ok("T5 window budget ≤ node deadline", r.outcome.deadline <= ISO(inMin(120)) && r.outcome.deadline > ISO(inMin(50)), r.outcome.deadline);
}

// ============ T6 — sub budget-used, node deadline EXPIRED → parent re-entry
{
  const p = mkproj("t6-expired");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)), state: "paused(waiting:db)" });
  mkNode(p, "db", { deadline: ISO(Date.now() - 30000) });
  mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" }); // root's spawn window
  const w = mkWindow(p, "db/run-1", { status: "completed", exitReason: "hard-timeout" });
  const r = await step(p, w, CFG);
  ok("T6 deadline-expired → reentry", r.outcome?.next === "reentry" && r.outcome?.node_path === "(root)", JSON.stringify(r.outcome));
  ok("T6 db deadline-expired", nodeState(p, "db") === "deadline-expired");
  ok("T6 root re-entry run-2", fs.existsSync(R(p, "run-2")) && nodeState(p, "(root)") === "active");
}

// ================= T7 — blocked (stuck) → node blocked, halt, no launch
{
  const p = mkproj("t7-blocked");
  const w = mkWindow(p, "run-1", { status: "stuck", exitReason: "stuck" });
  const r = await step(p, w, CFG);
  ok("T7 halted", r.outcome?.next === "halted", JSON.stringify(r.outcome));
  ok("T7 root blocked", nodeState(p, "(root)") === "blocked");
  ok("T7 no launch", !fs.existsSync(R(p, "run-2")));
  ok("T7 marker says why", String(readMarker(w).outcome.reason).includes("stuck"), JSON.stringify(readMarker(w).outcome));
}

// ================= T8 — user stop (repair, no report) → stopped, halt, no launch
{
  const p = mkproj("t8-stopped");
  const w = mkWindow(p, "run-1", { status: "running" }); // dead guard pid → stale
  const r = await step(p, w, { ...CFG, repair: true });
  ok("T8 halted (stopped)", r.outcome?.next === "halted" && r.outcome?.reason === "stopped", JSON.stringify(r.outcome));
  ok("T8 root stopped", nodeState(p, "(root)") === "stopped");
  ok("T8 no launch", !fs.existsSync(R(p, "run-2")));
}

// ================= T9 — repair with FINAL-REPORT.md → completed transition
{
  const p = mkproj("t9-repair-done");
  const w = mkWindow(p, "run-1", { status: "running" }); // user stopped it, but the report exists
  fs.writeFileSync(path.join(w, "FINAL-REPORT.md"), "# final\nall done\n");
  const r = await step(p, w, { ...CFG, repair: true });
  ok("T9 repair completed", r.kind === "completed" && r.outcome?.next === "idle", JSON.stringify(r));
  ok("T9 root done", nodeState(p, "(root)") === "done");
}

// ============ T10 — invalid spawn (task file missing) → rejected + terminal table
{
  const p = mkproj("t10-badspawn");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "ghost", task: path.join(T, "nope.md"), runtime_min: 30, deadline: null, reason: "r", at: ISO(Date.now()),
  }));
  const r = await step(p, w, CFG);
  const d = JSON.parse(fs.readFileSync(path.join(w, "spawn-decision.json"), "utf8"));
  ok("T10 decision rejected", d.ok === false && /task file missing/i.test(d.reason), JSON.stringify(d));
  ok("T10 fallthrough: root done + idle", r.outcome?.next === "idle" && nodeState(p, "(root)") === "done");
  ok("T10 no child dir", !fs.existsSync(R(p, "ghost")));
}

// ============ T11 — spawn with an already-expired deadline → rejected
{
  const p = mkproj("t11-spawn-expired");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  const taskFile = path.join(T, "t11-task.md");
  fs.writeFileSync(taskFile, "too late\n");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "late", task: taskFile, runtime_min: 30, deadline: ISO(Date.now() - 60000), reason: "r", at: ISO(Date.now()),
  }));
  const r = await step(p, w, CFG);
  const d = JSON.parse(fs.readFileSync(path.join(w, "spawn-decision.json"), "utf8"));
  ok("T11 rejected (deadline expired)", d.ok === false && /deadline expired/i.test(d.reason), JSON.stringify(d));
  ok("T11 terminal table applied (idle)", r.outcome?.next === "idle");
}

// ================= T12 — idempotency: second step on the same window is a no-op
{
  const p = mkproj("t12-idempotent");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  const r1 = await step(p, w, CFG);
  const r2 = await step(p, w, CFG);
  ok("T12 first step runs", r1.kind === "completed");
  ok("T12 second step skipped", r2.skipped === "chain-done", JSON.stringify(r2));
}

// ============ T13 — launch failure → blocked marker, window dir freed, no half-state
{
  const p = mkproj("t13-launchfail");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  fs.writeFileSync(path.join(p, ".pi-supervisor/launch-fail"), "1");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "hard-timeout", deadlineIso: ISO(Date.now() - 5000) });
  const r = await step(p, w, CFG);
  const m = readMarker(w);
  ok("T13 blocked outcome", m.outcome?.next === "halted" && /launch failed/i.test(m.outcome.reason), JSON.stringify(m.outcome));
  ok("T13 root blocked", nodeState(p, "(root)") === "blocked");
  ok("T13 window dir freed", !fs.existsSync(R(p, "run-2")));
  const r2 = await step(p, w, CFG);
  ok("T13 idempotent after failure", r2.skipped === "chain-done");
}

// ================= T14 — allocator: next free, never reuses, gaps preserved
{
  const p = mkproj("t14-alloc");
  fs.mkdirSync(R(p, "run-1"), { recursive: true });
  fs.mkdirSync(R(p, "run-5"), { recursive: true });
  const a = allocWindow(p, "(root)");
  ok("T14 gap preserved (run-6, not run-2)", a.window === "run-6", a.window);
  const a2 = allocWindow(p, "(root)");
  ok("T14 monotonic (run-7)", a2.window === "run-7", a2.window);
  const b = allocWindow(p, "db");
  ok("T14 fresh node starts at run-1", b.window === "run-1", b.window);
}

// ---------- summary ----------
console.log(`\n=== ${passed} passed, ${failed} failed (sandbox: ${T}) ===`);
if (failed) { console.log("failed:", fails.join(" | ")); process.exit(1); }
// cleanup: kill the fake guards
spawnSync("pkill", ["-f", "sleep 217"], { stdio: "ignore" });
process.exit(0);
