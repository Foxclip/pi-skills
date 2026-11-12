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
const { step, reentry, appendTolerant, sessionGate } = await import(pathToFileURL(path.join(S, "lib", "chain.mjs")).href);
const { allocWindowIn, readNode, activePath, ensureRootNode, registerChild } = await import(pathToFileURL(path.join(S, "lib", "node.mjs")).href);
const readJsonFile = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };

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
const R = (p, rel) => rel ? path.join(p, ".pi-supervisor/runs", rel) : path.join(p, ".pi-supervisor/runs");
function mkWindow(proj, rel, st) { // rel is under the runs root: "run-1" | "auth/run-1"
  const dir = R(proj, rel);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "TASK.md"), `# task ${rel}\ndo the work\n`);
  const base = { v: 2, at: ISO(Date.now() - 60000), guardPid: deadPid(), deadlineIso: ISO(inMin(120)) };
  fs.writeFileSync(path.join(dir, "pi-child-status.json"), JSON.stringify({ ...base, ...st }, null, 2));
  return dir;
}
function mkNode(proj, nodePath, extra = {}) { // v2: the root node.json is in the
  // project dot dir; a child path registers nested sub-projects (dir = name)
  if (nodePath === "(root)") {
    ensureRootNode(proj, { deadline: extra.deadline ?? null });
    if (extra.state) {
      const njP = path.join(proj, ".pi-supervisor", "node.json");
      const nj = readJsonFile(njP);
      nj.state = extra.state;
      fs.writeFileSync(njP, JSON.stringify(nj, null, 2));
    }
    return;
  }
  const parts = String(nodePath).split("/");
  let dir = proj;
  for (const part of parts) {
    registerChild(dir, part, part);
    dir = path.join(dir, part);
    fs.mkdirSync(path.join(dir, ".pi-supervisor"), { recursive: true });
  }
  if (extra.deadline || extra.state) {
    const nj = readJsonFile(path.join(dir, ".pi-supervisor", "node.json"))
      || { v: 2, name: nodePath, path: nodePath, parent: null, deadline: null, state: "active", children: [], createdAt: ISO(Date.now()) };
    if (extra.deadline) nj.deadline = extra.deadline;
    if (extra.state) nj.state = extra.state;
    fs.writeFileSync(path.join(dir, ".pi-supervisor", "node.json"), JSON.stringify(nj, null, 2));
  }
}
// the windows dir of a node (v2: <node-project>/.pi-supervisor/runs)
const NR = (proj, nodePath) => path.join(proj, ...String(nodePath).split("/"), ".pi-supervisor", "runs");
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
  ok("T2 child node dir + TASK.md", fs.existsSync(path.join(p, "auth", ".pi-supervisor", "node.json"))
    && fs.readFileSync(path.join(p, "auth", "TASK.md"), "utf8").includes("auth sub-project"));
  ok("T2 child TASK.md is a sub brief", fs.readFileSync(path.join(d.run_dir, "TASK.md"), "utf8").includes("auth"));
  ok("T2 parent paused(waiting:auth)", nodeState(p, "(root)") === "paused(waiting:auth)");
  ok("T2 child node active", nodeState(p, "auth") === "active");
  const act = active(path.join(p, "auth"));
  ok("T2 active.json → child window (in the sub-project)", act && act.node === "auth" && act.window === "run-1");
  ok("T2 child got deadline ≤ parent deadline", d.deadline <= ISO(inMin(31)) && d.deadline > ISO(inMin(20)), d.deadline);
  const idx2 = JSON.parse(fs.readFileSync(R(p, "INDEX.json"), "utf8"));
  ok("T2 INDEX entry paused while spawning (5.1)", idx2.runs.find((e) => e.run === "run-1")?.status === "paused", JSON.stringify(idx2));
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
  const wins = fs.readdirSync(NR(p, "shared")).filter((f) => /^run-\d+$/.test(f)).sort();
  ok("T3 one node, two windows", JSON.stringify(wins) === JSON.stringify(["run-1", "run-2"]), JSON.stringify(wins));
  ok("T3 joined brief is continuation-style", fs.readFileSync(path.join(NR(p, "shared"), "run-2", "TASK.md"), "utf8").includes("Task (the node's task file, unchanged)"));
}

// ================= T4 — sub completed → node done + parent run RE-ACTIVATED (2.3/5.1)
{
  const p = mkproj("t4-reentry");
  const nodeDl4 = ISO(inMin(120));
  mkNode(p, "(root)", { deadline: nodeDl4, state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(90)) });
  const rw = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" }); // root's spawn window
  fs.writeFileSync(path.join(rw, "chain-done.json"), JSON.stringify({ v: 1, at: ISO(Date.now() - 300000), kind: "spawned", outcome: { next: "spawned", node_path: "auth", window: "run-1" } }));
  fs.mkdirSync(path.join(NR(p, "auth"), "run-1"), { recursive: true });
  fs.writeFileSync(path.join(NR(p, "auth"), "run-1", "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(90)) }, null, 2));
  const w = path.join(NR(p, "auth"), "run-1");
  const r = await step(p, w, CFG);
  ok("T4 reentry launched", r.outcome?.next === "reentry" && r.outcome?.node_path === "(root)", JSON.stringify(r.outcome));
  ok("T4 RE-ACTIVATES the spawn window (run-1), no run-2", r.outcome?.window === "run-1" && !fs.existsSync(R(p, "run-2")), JSON.stringify(r.outcome));
  ok("T4 re-entry brief in RE-ENTRY.md", fs.existsSync(path.join(rw, "RE-ENTRY.md")) && fs.readFileSync(path.join(rw, "RE-ENTRY.md"), "utf8").includes("RE-ENTRY"));
  // run35 (2026-11-09): the reentry budget object lacked the ok field, so
  // budgetLine() rendered the "no remaining budget" fallback in RE-ENTRY.md
  // although ~100 minutes were left on the run.
  const brief4 = fs.readFileSync(path.join(rw, "RE-ENTRY.md"), "utf8");
  ok("T4 re-entry budget line shows the real budget (not the no-budget fallback)",
    !brief4.includes("no remaining budget") && /~\d+ minutes, hard deadline/.test(brief4),
    brief4.split("\n").find((l) => /minutes, hard deadline|no remaining budget/.test(l)) || "(budget line not found)");
  ok("T4 original TASK.md untouched", fs.readFileSync(path.join(rw, "TASK.md"), "utf8").includes("task run-1"));
  ok("T4 chain-done marker cleared (fresh step later)", !fs.existsSync(path.join(rw, "chain-done.json")));
  ok("T4 re-entry deadline = the run's (node's) deadline (run4 fix F1)", r.outcome?.deadline === nodeDl4, r.outcome?.deadline);
  const args4 = fs.readFileSync(path.join(rw, "launch-args.txt"), "utf8");
  ok("T4 launched into the same run dir", args4.includes(`--out-dir ${rw}`) && args4.includes(`--task-file ${path.join(rw, "RE-ENTRY.md")}`), args4);
  ok("T4 auth done", nodeState(p, "auth") === "done");
  ok("T4 root active", nodeState(p, "(root)") === "active");
  const act = active(p);
  ok("T4 active.json → re-activated window", act && act.node === "(root)" && act.window === "run-1");
}

// ============ T5 — root budget-used, node deadline NOT expired → NO continuation (3.2)
{
  const p = mkproj("t5-budget-used");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "hard-timeout", deadlineIso: ISO(Date.now() - 5000) });
  const r = await step(p, w, CFG);
  ok("T5 no continuation (3.2)", r.outcome?.next === "idle" && r.outcome?.reason === "budget-used", JSON.stringify(r.outcome));
  ok("T5 no run-2 (no launch)", !fs.existsSync(R(p, "run-2")));
  ok("T5 root paused", nodeState(p, "(root)") === "paused", nodeState(p, "(root)"));
  ok("T5 3.2 note in STATE.md", /used its budget — the run ended at its deadline \(3\.2\)/.test(fs.readFileSync(path.join(p, "STATE.md"), "utf8")), fs.readFileSync(path.join(p, "STATE.md"), "utf8").trim().split("\n").slice(-1)[0]);
  ok("T5 marker says budget-used", readMarker(w).kind === "budget-used", JSON.stringify(readMarker(w)));
}

// ============ T6 — sub budget-used, node deadline EXPIRED → parent run RE-ACTIVATED
{
  const p = mkproj("t6-expired");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)), state: "paused(waiting:db)" });
  mkNode(p, "db", { deadline: ISO(Date.now() - 30000) });
  mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" }); // root's spawn window
  fs.mkdirSync(path.join(NR(p, "db"), "run-1"), { recursive: true });
  fs.writeFileSync(path.join(NR(p, "db"), "run-1", "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "hard-timeout", guardPid: deadPid(), deadlineIso: ISO(Date.now() - 30000) }, null, 2));
  const w = path.join(NR(p, "db"), "run-1");
  const r = await step(p, w, CFG);
  ok("T6 deadline-expired → reentry", r.outcome?.next === "reentry" && r.outcome?.node_path === "(root)", JSON.stringify(r.outcome));
  ok("T6 db deadline-expired", nodeState(p, "db") === "deadline-expired");
  ok("T6 root RE-ACTIVATED (run-1, no run-2)", r.outcome?.window === "run-1" && !fs.existsSync(R(p, "run-2")) && nodeState(p, "(root)") === "active");
  ok("T6 re-activation brief in RE-ENTRY.md", fs.readFileSync(R(p, "run-1/RE-ENTRY.md"), "utf8").includes("RE-ENTRY"));
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

// ================= T8b — v0.30.1: a graceful Ctrl-C kill (status error /
// killed-SIGTERM) + user-stop.json marker → "stopped" (user intent wins) in
// BOTH call modes; without the marker it still classifies as blocked.
{
  const p = mkproj("t8b-userstop");
  const w = mkWindow(p, "run-1", { status: "error", exitReason: "killed-SIGTERM" });
  fs.writeFileSync(path.join(w, "user-stop.json"), JSON.stringify({ ts: ISO(Date.now()), source: "SIGINT" }));
  const r = await step(p, w, { ...CFG, repair: true }); // the S0 gate's call
  ok("T8b marker → stopped (repair)", r.kind === "stopped" && r.outcome?.next === "halted" && r.outcome?.reason === "stopped", JSON.stringify(r));
  ok("T8b root stopped", nodeState(p, "(root)") === "stopped");
  ok("T8b no launch", !fs.existsSync(R(p, "run-2")));
  const p2 = mkproj("t8b-userstop-nr");
  const w2 = mkWindow(p2, "run-1", { status: "error", exitReason: "killed-SIGTERM" });
  fs.writeFileSync(path.join(w2, "user-stop.json"), JSON.stringify({ ts: ISO(Date.now()), source: "SIGINT" }));
  const r2 = await step(p2, w2, CFG);
  ok("T8b marker → stopped (guard-driven call too)", r2.kind === "stopped" && r2.outcome?.next === "halted" && r2.outcome?.reason === "stopped", JSON.stringify(r2));
  const p3 = mkproj("t8b-no-marker");
  const w3 = mkWindow(p3, "run-1", { status: "error", exitReason: "killed-SIGTERM" });
  const r3 = await step(p3, w3, CFG);
  ok("T8b no marker → still blocked (external kill)", r3.kind === "blocked" && r3.outcome?.next === "halted", JSON.stringify(r3));
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
  ok("T10 rejected spawn escalates (halted, not silent idle)", r.outcome?.next === "halted" && /spawn request rejected/i.test(r.outcome?.reason ?? ""), JSON.stringify(r.outcome));
  ok("T10 root blocked (human attention)", nodeState(p, "(root)") === "blocked");
  ok("T10 marker says why", /rejected/i.test(String(readMarker(w).outcome?.reason ?? "")), JSON.stringify(readMarker(w).outcome));
  ok("T10 no child dir (rejection left no side effects)", !fs.existsSync(path.join(p, "ghost")));
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
  ok("T11 rejected spawn escalates (halted)", r.outcome?.next === "halted" && /deadline expired/i.test(r.outcome?.reason ?? ""), JSON.stringify(r.outcome));
  ok("T11 root blocked (human attention)", nodeState(p, "(root)") === "blocked");
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

// ============ T13 — re-activation launch failure → blocked, no new window, no half-state
{
  const p = mkproj("t13-launchfail");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)), state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(90)) });
  fs.writeFileSync(path.join(p, ".pi-supervisor/launch-fail"), "1");
  mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" }); // root's spawn window
  const cw = path.join(NR(p, "auth"), "run-1");
  fs.mkdirSync(cw, { recursive: true });
  fs.writeFileSync(path.join(cw, "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(90)) }, null, 2));
  const r = await step(p, cw, CFG);
  const m = readMarker(cw);
  ok("T13 blocked outcome", m.outcome?.next === "halted" && /launch failed/i.test(m.outcome.reason), JSON.stringify(m.outcome));
  ok("T13 root blocked", nodeState(p, "(root)") === "blocked");
  ok("T13 STATE.md names the re-activation failure", /re-activation of run-1 failed/.test(fs.readFileSync(path.join(p, "STATE.md"), "utf8")), fs.readFileSync(path.join(p, "STATE.md"), "utf8").trim().split("\n").slice(-1)[0]);
  ok("T13 no new window (the run dir stays)", !fs.existsSync(R(p, "run-2")) && fs.existsSync(R(p, "run-1")));
  const r2 = await step(p, cw, CFG);
  ok("T13 idempotent after failure", r2.skipped === "chain-done");
}

// ================= T14 — allocator: next free, never reuses, gaps preserved
{
  const p = mkproj("t14-alloc");
  fs.mkdirSync(R(p, "run-1"), { recursive: true });
  fs.mkdirSync(R(p, "run-5"), { recursive: true });
  const a = allocWindowIn(R(p));
  ok("T14 gap preserved (run-6, not run-2)", a.window === "run-6", a.window);
  const a2 = allocWindowIn(R(p));
  ok("T14 monotonic (run-7)", a2.window === "run-7", a2.window);
  const b = allocWindowIn(NR(p, "db"));
  ok("T14 fresh node starts at run-1", b.window === "run-1", b.window);
}

// ============ T15 — v0.29.2 (run34): infeasible-by-sizing spawn → rejected BEFORE side effects
// windowBudget gives 1min of work, but the 10min finalize reservation leaves none —
// the sizeDeadline rule launch.mjs applies. run34's request died at the launch, AFTER
// the node was registered; now it dies here, with nothing written.
{
  const p = mkproj("t15-sizing");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  const taskFile = path.join(T, "t15-task.md");
  fs.writeFileSync(taskFile, "sized out\n");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "tight", task: taskFile, runtime_min: 1, deadline: null, reason: "r", at: ISO(Date.now()),
  }));
  const r = await step(p, w, CFG);
  const d = JSON.parse(fs.readFileSync(path.join(w, "spawn-decision.json"), "utf8"));
  ok("T15 rejected (no work time after finalize)", d.ok === false && /leaves no work time/i.test(d.reason), JSON.stringify(d));
  ok("T15 rejected spawn escalates (halted)", r.outcome?.next === "halted" && /spawn request rejected/i.test(r.outcome?.reason ?? ""), JSON.stringify(r.outcome));
  ok("T15 no sub-project (no partial state)", !fs.existsSync(path.join(p, "tight")));
  const rnj15 = readJsonFile(path.join(p, ".pi-supervisor", "node.json"));
  ok("T15 no registry entry", !(rnj15.children || []).some((c) => c.name === "tight"), JSON.stringify(rnj15.children));
  ok("T15 root blocked (human attention)", nodeState(p, "(root)") === "blocked");
}

// ============ T16 — v0.29.2 (run34): launch failure on the spawn path → sub node BLOCKED
// (not active). The sub-project + registry line stay (join-able); a re-spawn under
// the same name joins the blocked node instead of duplicating it.
{
  const p = mkproj("t16-spawnlaunchfail");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  const taskFile = path.join(T, "t16-task.md");
  fs.writeFileSync(taskFile, "will not launch\n");
  // the stub launch refuses when <subproject>/.pi-supervisor/launch-fail exists
  fs.mkdirSync(path.join(p, "sick", ".pi-supervisor"), { recursive: true });
  fs.writeFileSync(path.join(p, "sick", ".pi-supervisor", "launch-fail"), "1");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "sick", task: taskFile, runtime_min: 30, deadline: null, reason: "r", at: ISO(Date.now()),
  }));
  const r = await step(p, w, CFG);
  const snj = readJsonFile(path.join(p, "sick", ".pi-supervisor", "node.json"));
  ok("T16 sub node exists (join-able)", snj && snj.name === "sick", JSON.stringify(snj));
  ok("T16 sub node state blocked (not active)", snj && snj.state === "blocked", JSON.stringify(snj));
  const rnj16 = readJsonFile(path.join(p, ".pi-supervisor", "node.json"));
  ok("T16 registry line kept", (rnj16.children || []).some((c) => c.name === "sick"), JSON.stringify(rnj16.children));
  ok("T16 outcome halted + root blocked", r.outcome?.next === "halted" && nodeState(p, "(root)") === "blocked", JSON.stringify(r.outcome));
  ok("T16 no window left behind", !fs.existsSync(path.join(p, "sick", ".pi-supervisor", "runs", "run-1")));
}

// ================= S1 — v2: spawn creates a PROJECT-LEVEL dir (plan §4)
// A fresh project has no dot-dir node.json → S0 materializes the root;
// the spawn then creates P/<name>/ as a nested sub-project (NOT under runs/).
{
  const p = mkproj("s1-v2-spawn");
  ensureRootNode(p, { deadline: ISO(inMin(120)) });
  const taskFile = path.join(T, "s1-task.md");
  fs.writeFileSync(taskFile, "implement the auth sub-project\n");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "auth", task: taskFile, runtime_min: 30, deadline: null,
    reason: "auth first", at: ISO(Date.now()),
  }));
  const r = await step(p, w, CFG);
  ok("S1 spawn honored", r.outcome?.next === "spawned" && r.outcome?.node_path === "auth", JSON.stringify(r));
  const aproj = path.join(p, "auth");
  ok("S1 child project dir at P/auth (not under runs/)", fs.existsSync(path.join(aproj, ".pi-supervisor")));
  ok("S1 child TASK.md copied to project root", fs.readFileSync(path.join(aproj, "TASK.md"), "utf8").includes("implement the auth sub-project"));
  ok("S1 child STATE.md created", fs.existsSync(path.join(aproj, "STATE.md")));
  const snj = readJsonFile(path.join(aproj, ".pi-supervisor", "node.json"));
  // parent = the parent node's path ("(root)") — plan §4.2. Live children
  // read parent != null; only the standalone demotion writes null.
  ok("S1 child node.json v2", snj && snj.v === 2 && snj.path === "auth" && snj.parent === "(root)" && snj.state === "active", JSON.stringify(snj));
  const rnj = readJsonFile(path.join(p, ".pi-supervisor", "node.json"));
  ok("S1 root registry entry", rnj && Array.isArray(rnj.children) && rnj.children.some((c) => c.name === "auth" && c.dir === "auth"), JSON.stringify(rnj));
  const win = path.join(aproj, ".pi-supervisor", "runs", "run-1");
  ok("S1 child window in the sub-project's runs dir", fs.existsSync(path.join(win, "TASK.md")));
  ok("S1 child brief carries the task", fs.readFileSync(path.join(win, "TASK.md"), "utf8").includes("implement the auth sub-project"));
  const args = fs.readFileSync(path.join(win, "launch-args.txt"), "utf8");
  ok("S1 launch got --project <subproject>", args.includes(`--project ${aproj}`), args);
  ok("S1 active.json in the sub-project", readJsonFile(path.join(aproj, ".pi-supervisor", "active.json"))?.node === "auth");
  ok("S1 root paused(waiting:auth)", nodeState(p, "(root)") === "paused(waiting:auth)", nodeState(p, "(root)"));
  ok("S1 root STATE.md (v2 location) has the spawn line", fs.readFileSync(path.join(p, "STATE.md"), "utf8").includes("child auth spawned"));
}

// ================= S2 — v2: join (existing sub-project) → continuation, no new project
{
  const p = mkproj("s2-v2-join");
  ensureRootNode(p, { deadline: ISO(inMin(120)) });
  const aproj = path.join(p, "auth");
  fs.mkdirSync(path.join(aproj, ".pi-supervisor", "runs", "run-1"), { recursive: true });
  fs.writeFileSync(path.join(aproj, "TASK.md"), "implement the auth sub-project\n");
  fs.writeFileSync(path.join(aproj, ".pi-supervisor", "node.json"), JSON.stringify({
    v: 2, name: "auth", path: "auth", parent: "(root)", deadline: ISO(inMin(120)), state: "active", children: [],
  }, null, 2));
  fs.writeFileSync(path.join(aproj, ".pi-supervisor", "runs", "run-1", "pi-child-status.json"),
    JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(120)) }));
  registerChild(p, "auth", "auth", { parentPath: "(root)" });
  const taskFile = path.join(T, "s2-task.md");
  fs.writeFileSync(taskFile, "implement the auth sub-project\n");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "auth", task: taskFile, runtime_min: 30, deadline: null, reason: "join", at: ISO(Date.now()),
  }));
  const r = await step(p, w, CFG);
  ok("S2 join honored", r.outcome?.next === "spawned" && r.outcome?.window === "run-2", JSON.stringify(r));
  ok("S2 window in the SAME sub-project's runs dir", fs.existsSync(path.join(aproj, ".pi-supervisor", "runs", "run-2", "TASK.md")));
  ok("S2 continuation-style brief", fs.readFileSync(path.join(aproj, ".pi-supervisor", "runs", "run-2", "TASK.md"), "utf8").includes("CONTINUATION"));
  ok("S2 exactly one auth project (no duplicate)", fs.readdirSync(p).filter((n) => n.startsWith("auth")).length === 1);
}

// ================= S3 — v2: move-out → commit detached + child-moved halt on the parent
// The defensive re-entry guard (plan §6): the parent is paused(waiting:X) and X's
// project dir is gone (moved) — commit the line as detached, halt, never relaunch.
{
  const p = mkproj("s3-v2-moved");
  ensureRootNode(p, { deadline: ISO(inMin(120)) });
  const aproj = path.join(p, "auth");
  fs.mkdirSync(path.join(aproj, ".pi-supervisor", "runs"), { recursive: true });
  fs.writeFileSync(path.join(aproj, ".pi-supervisor", "node.json"), JSON.stringify({
    v: 2, name: "auth", path: "auth", parent: "(root)", deadline: ISO(inMin(120)), state: "active", children: [],
  }, null, 2));
  registerChild(p, "auth", "auth", { parentPath: "(root)" });
  const rnj3 = path.join(p, ".pi-supervisor", "node.json");
  const rnj3o = readJsonFile(rnj3); rnj3o.state = "paused(waiting:auth)"; fs.writeFileSync(rnj3, JSON.stringify(rnj3o, null, 2));
  const win = path.join(p, ".pi-supervisor", "runs", "run-1");
  fs.mkdirSync(win, { recursive: true });
  fs.rmSync(aproj, { recursive: true, force: true }); // the sub-project is moved away
  let outcome = null;
  await reentry("(root)", p, "auth", win, CFG, () => {}, "done", (o) => { outcome = o; });
  ok("S3 child-moved halt", outcome && outcome.next === "halted" && /detached/i.test(outcome.reason), JSON.stringify(outcome));
  const rnj = readJsonFile(path.join(p, ".pi-supervisor", "node.json"));
  const entry = rnj?.children?.find((c) => c.name === "auth");
  ok("S3 entry committed as detached (iso stamped)", entry && typeof entry.detached === "string" && entry.detached.length > 0, JSON.stringify(entry));
  ok("S3 parent node blocked", nodeState(p, "(root)") === "blocked", nodeState(p, "(root)"));
}

// ================= T-RB — v0.35.19 (run110, 3.2/7.8): the re-entry halt reason
// must be TRUE. A budget that CANNOT BE SIZED (remaining < finalize reservation,
// deadline still in the FUTURE) must not claim the deadline "was reached".
{
  const p = mkproj("t-rb-nobudget");
  ensureRootNode(p, { deadline: ISO(inMin(4)) });   // 4 min left < finalizeMin 5 → un-sizable, deadline NOT yet reached
  const aproj = path.join(p, "auth");
  fs.mkdirSync(path.join(aproj, ".pi-supervisor", "runs", "run-1"), { recursive: true });
  fs.writeFileSync(path.join(aproj, ".pi-supervisor", "node.json"), JSON.stringify({
    v: 2, name: "auth", path: "auth", parent: "(root)", deadline: ISO(inMin(4)), state: "active", children: [],
  }, null, 2));
  fs.writeFileSync(path.join(aproj, ".pi-supervisor", "runs", "run-1", "pi-child-status.json"),
    JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(4)) }));
  registerChild(p, "auth", "auth", { parentPath: "(root)" });
  const win = path.join(p, ".pi-supervisor", "runs", "run-1");
  fs.mkdirSync(win, { recursive: true });
  let outcome = null;
  await reentry("(root)", p, "auth", win, CFG, () => {}, "done", (o) => { outcome = o; });
  ok("T-RB un-sizable budget (deadline still in the FUTURE) → halt with the true reason",
    outcome && outcome.next === "halted" && /cannot hold a re-entry window/.test(outcome.reason || "") && !/was reached/.test(outcome.reason || ""), outcome?.reason);
}
// ================= T-RB2 — the deadline-past branch keeps its (accurate) wording
{
  const p = mkproj("t-rb-past");
  ensureRootNode(p, { deadline: ISO(inMin(-5)) });  // 5 min PAST the deadline
  const aproj = path.join(p, "auth");
  fs.mkdirSync(path.join(aproj, ".pi-supervisor", "runs", "run-1"), { recursive: true });
  fs.writeFileSync(path.join(aproj, ".pi-supervisor", "node.json"), JSON.stringify({
    v: 2, name: "auth", path: "auth", parent: "(root)", deadline: ISO(inMin(-5)), state: "active", children: [],
  }, null, 2));
  fs.writeFileSync(path.join(aproj, ".pi-supervisor", "runs", "run-1", "pi-child-status.json"),
    JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(-5)) }));
  registerChild(p, "auth", "auth", { parentPath: "(root)" });
  const win = path.join(p, ".pi-supervisor", "runs", "run-1");
  fs.mkdirSync(win, { recursive: true });
  let outcome = null;
  await reentry("(root)", p, "auth", win, CFG, () => {}, "done", (o) => { outcome = o; });
  ok("T-RB2 past deadline → halt says the deadline was reached (3.2)",
    outcome && outcome.next === "halted" && /deadline \(.*\) was reached \(3\.2\)/.test(outcome.reason || ""), outcome?.reason);
}
// ================= S4 — v2: standalone completion after move (no re-entry, idle, parent demoted to null)
// The whole sub-tree is moved away; a window inside it completes. The registry
// cannot resolve it → standalone: the project decides its own root, and its
// nested node is demoted parent:null (one-time).
{
  const p = mkproj("s4-v2-standalone");
  ensureRootNode(p, { deadline: ISO(inMin(120)) });
  const aproj = path.join(p, "auth");
  fs.mkdirSync(path.join(aproj, ".pi-supervisor", "runs"), { recursive: true });
  fs.writeFileSync(path.join(aproj, ".pi-supervisor", "node.json"), JSON.stringify({
    v: 2, name: "auth", path: "auth", parent: "(root)", deadline: ISO(inMin(120)), state: "active", children: [],
  }, null, 2));
  registerChild(p, "auth", "auth", { parentPath: "(root)" });
  // nested sub-project db inside auth (parent: "auth" — not yet null)
  const dproj = path.join(aproj, "db");
  fs.mkdirSync(path.join(dproj, ".pi-supervisor", "runs", "run-1"), { recursive: true });
  fs.writeFileSync(path.join(dproj, ".pi-supervisor", "node.json"), JSON.stringify({
    v: 2, name: "db", path: "auth/db", parent: "auth", deadline: ISO(inMin(120)), state: "active", children: [],
  }, null, 2));
  const win = path.join(dproj, ".pi-supervisor", "runs", "run-1");
  fs.writeFileSync(path.join(win, "pi-child-status.json"), JSON.stringify({
    v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(120)),
  }));
  fs.writeFileSync(path.join(win, "TASK.md"), "do db\n");
  fs.mkdirSync(path.join(T, "moved"), { recursive: true });
  fs.renameSync(aproj, path.join(T, "moved", "auth")); // the whole line moves out
  const r = await step(p, path.join(T, "moved", "auth", "db", ".pi-supervisor", "runs", "run-1"), CFG);
  ok("S4 standalone idle (no re-entry)", r.outcome?.next === "idle" && /standalone/.test(r.outcome?.reason || ""), JSON.stringify(r));
  const snj = readJsonFile(path.join(T, "moved", "auth", "db", ".pi-supervisor", "node.json"));
  ok("S4 nested node demoted parent:null", snj && snj.parent === null, JSON.stringify(snj));
  // demotion is scoped to the window's project — the moved ancestor keeps its
  // (now stale) parent until ITS OWN window completes standalone
  ok("S4 ancestor node.json untouched (still parent (root))", readJsonFile(path.join(T, "moved", "auth", ".pi-supervisor", "node.json"))?.parent === "(root)");
  ok("S4 demotion logged in the project STATE.md", fs.readFileSync(path.join(T, "moved", "auth", "db", "STATE.md"), "utf8").includes("STANDALONE"));
  ok("S4 root tree untouched (still registered)", readJsonFile(path.join(p, ".pi-supervisor", "node.json"))?.children?.some((c) => c.name === "auth"));
}

// ================= S5 — v2: stale-entry spawn rejection (detached line is not re-created)
{
  const p = mkproj("s5-v2-stale");
  ensureRootNode(p, { deadline: ISO(inMin(120)) });
  const rnjPath = path.join(p, ".pi-supervisor", "node.json");
  const rnj = readJsonFile(rnjPath);
  rnj.children = [{ name: "auth", dir: "auth", parentPath: "(root)" }];
  fs.writeFileSync(rnjPath, JSON.stringify(rnj, null, 2)); // entry without the project dir
  const taskFile = path.join(T, "s5-task.md");
  fs.writeFileSync(taskFile, "implement the auth sub-project\n");
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "auth", task: taskFile, runtime_min: 30, deadline: null, reason: "should be rejected", at: ISO(Date.now()),
  }));
  const r = await step(p, w, CFG);
  const d = readJsonFile(path.join(w, "spawn-decision.json"));
  ok("S5 spawn rejected (detached)", d && d.ok === false && /detached/i.test(d.reason), JSON.stringify(d));
  ok("S5 project NOT re-created", !fs.existsSync(path.join(p, "auth")));
  const entry = readJsonFile(rnjPath)?.children?.find((c) => c.name === "auth");
  ok("S5 entry now stamped detached", entry && typeof entry.detached === "string", JSON.stringify(entry));
  ok("S5 escalated (halted/blocked, not silent idle)", r.outcome?.next === "halted" && /rejected/i.test(r.outcome?.reason ?? "") && nodeState(p, "(root)") === "blocked", JSON.stringify(r.outcome));
}

// ================= S8 — v2: nested spawn chain (root → auth → db) and the re-entry climbs one level
{
  const p = mkproj("s8-v2-nested");
  ensureRootNode(p, { deadline: ISO(inMin(120)) });
  const taskFile = path.join(T, "s8-task.md");
  fs.writeFileSync(taskFile, "implement the auth sub-project\n");
  const w1 = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(w1, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "auth", task: taskFile, runtime_min: 30, deadline: null, reason: "auth", at: ISO(Date.now()),
  }));
  const r1 = await step(p, w1, CFG);
  ok("S8 root spawned auth", r1.outcome?.next === "spawned" && r1.outcome?.node_path === "auth", JSON.stringify(r1));
  const aproj = path.join(p, "auth");
  const awin = path.join(aproj, ".pi-supervisor", "runs", "run-1");
  // auth completes and spawns db (the NESTED spawn — db is created inside the auth project)
  const taskDb = path.join(T, "s8-task-db.md");
  fs.writeFileSync(taskDb, "implement the db sub-project\n");
  fs.writeFileSync(path.join(awin, "pi-child-status.json"), JSON.stringify({
    v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(120)),
  }));
  fs.writeFileSync(path.join(awin, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "db", task: taskDb, runtime_min: 30, deadline: null, reason: "db under auth", at: ISO(Date.now()),
  }));
  const r2 = await step(p, awin, CFG);
  ok("S8 auth spawned db", r2.outcome?.next === "spawned" && r2.outcome?.node_path === "auth/db", JSON.stringify(r2));
  const dproj = path.join(aproj, "db");
  ok("S8 db project nested inside the auth project", fs.existsSync(path.join(dproj, ".pi-supervisor", "node.json")));
  const dnj = readJsonFile(path.join(dproj, ".pi-supervisor", "node.json"));
  ok("S8 db node.json path+parent", dnj?.path === "auth/db" && dnj?.parent === "auth", JSON.stringify(dnj));
  ok("S8 auth paused(waiting:db)", nodeState(p, "auth") === "paused(waiting:db)", nodeState(p, "auth"));
  ok("S8 root still paused(waiting:auth)", nodeState(p, "(root)") === "paused(waiting:auth)", nodeState(p, "(root)"));
  const dwin = path.join(dproj, ".pi-supervisor", "runs", "run-1");
  fs.writeFileSync(path.join(dwin, "pi-child-status.json"), JSON.stringify({
    v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(120)),
  }));
  const r3 = await step(p, dwin, CFG);
  ok("S8 db done → re-entry of auth (not root)", r3.outcome?.next === "reentry" && r3.outcome?.node_path === "auth", JSON.stringify(r3));
  ok("S8 re-activates the AUTH project's spawn window (run-1)", r3.outcome?.window === "run-1" && fs.existsSync(path.join(awin, "RE-ENTRY.md")), JSON.stringify(r3.outcome));
  ok("S8 no new auth window (no run-2)", !fs.existsSync(path.join(aproj, ".pi-supervisor", "runs", "run-2")));
  ok("S8 root run-2 NOT created (re-entry went one level)", !fs.existsSync(path.join(p, ".pi-supervisor", "runs", "run-2")));
  ok("S8 consumed spawn request cleared (no double spawn)", !fs.existsSync(path.join(awin, "spawn-request.json")));
  ok("S8 db node done", readJsonFile(path.join(dproj, ".pi-supervisor", "node.json"))?.state === "done");
  ok("S8 auth active after re-entry", nodeState(p, "auth") === "active", nodeState(p, "auth"));
  ok("S8 root still paused(waiting:auth)", nodeState(p, "(root)") === "paused(waiting:auth)", nodeState(p, "(root)"));
}

// ================= S9 — run4 fix (F3, V5): the spawn receipt flags sub-runtime
// vs the PARENT WINDOW's remaining. run4: sub deadline was 14.3 min past the
// parent window's hard stop; the receipt said nothing. Early-finish sub-runs
// are legal, so it's a WARN line, not a rejection.
{
  const p = mkproj("s9-f3-receipt");
  ensureRootNode(p, { deadline: ISO(inMin(60)) });
  const taskFile = path.join(T, "s9-task.md");
  fs.writeFileSync(taskFile, "implement the f3 sub-project\n");
  // synthetic parent window: 11 m 54 s remaining
  const w = mkWindow(p, "run-1", {
    status: "completed", exitReason: "completed-finalized",
    deadlineIso: new Date(Date.now() + 11 * 60000 + 54000).toISOString(),
  });
  fs.writeFileSync(path.join(w, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "f3a", task: taskFile, runtime_min: 15, deadline: null, reason: "f3 warn", at: ISO(Date.now()),
  }));
  const r = await step(p, w, CFG);
  const d = readJsonFile(path.join(w, "spawn-decision.json"));
  ok("S9 spawn with runtime 15 > window remaining 11m54s → launched", r.outcome?.next === "spawned" && d?.ok === true, JSON.stringify(r));
  ok("S9 receipt carries the WARN line (sub out-runs the parent window)",
    typeof d?.warn === "string" && d.warn.startsWith("WARN: sub runtime exceeds the parent window's remaining") && /11m 5\ds/.test(d.warn),
    JSON.stringify(d?.warn ?? d));
  // same shape, smaller runtime → no WARN. (The plan's illustrative value was
  // --runtime 5, but 5min cannot pass the sizing gate in this harness: CFG
  // reserves 5min for finalization, so runtime 5 "leaves no work time". 8m is
  // the smallest feasible runtime and is still < 11m54s remaining.)
  const p2 = mkproj("s9-f3-nowarn");
  ensureRootNode(p2, { deadline: ISO(inMin(60)) });
  const w2 = mkWindow(p2, "run-1", {
    status: "completed", exitReason: "completed-finalized",
    deadlineIso: new Date(Date.now() + 11 * 60000 + 54000).toISOString(),
  });
  fs.writeFileSync(path.join(w2, "spawn-request.json"), JSON.stringify({
    kind: "spawn", node: "f3b", task: taskFile, runtime_min: 8, deadline: null, reason: "f3 no warn", at: ISO(Date.now()),
  }));
  const r2 = await step(p2, w2, CFG);
  const d2 = readJsonFile(path.join(w2, "spawn-decision.json"));
  ok("S9 spawn with runtime 8 < window remaining → launched, no WARN", r2.outcome?.next === "spawned" && d2?.ok === true && !("warn" in (d2 || {})), JSON.stringify(d2));
}

// ============ T17 — v0.30.0 P1: EACCES-tolerant append (run37 ownership lockout)
// A STATE.md the child's own pi process wrote is pichild-owned; a plain append
// fails EACCES and the chain lost its bookkeeping. appendTolerant reclaims the
// file via rename + rewrite (needs dir write, not file write).
{
  const p = mkproj("t17-eacc");
  const f1 = path.join(p, "plain.log");
  fs.writeFileSync(f1, "old\n");
  appendTolerant(f1, "new\n");
  ok("T17 direct append works", fs.readFileSync(f1, "utf8") === "old\nnew\n");

  // owner read-only file — the test-side shape of a pichild-owned file:
  // appendFileSync fails EACCES, the rename path must still land the line
  const f2 = path.join(p, "STATE.md");
  fs.writeFileSync(f2, "child content\n");
  fs.chmodSync(f2, 0o444);
  let threw = null;
  try { appendTolerant(f2, "chain line\n"); } catch (e) { threw = e; }
  ok("T17 read-only file: no throw", threw === null, String(threw));
  const c2 = fs.readFileSync(f2, "utf8");
  ok("T17 read-only file: old+new content", c2 === "child content\nchain line\n", JSON.stringify(c2));
  ok("T17 read-only file: backup reclaimed", fs.existsSync(f2) && fs.readdirSync(p).every((f) => !String(f).startsWith("STATE.md.bak-")));

  // integration: step() appends node bookkeeping to a 0444 STATE.md
  const w = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  const stf = path.join(p, "STATE.md");
  fs.writeFileSync(stf, "root state\n");
  fs.chmodSync(stf, 0o444);
  const r = await step(p, w, CFG);
  ok("T17 step completed despite 0444 STATE.md", r.outcome?.next === "idle", JSON.stringify(r.outcome));
  ok("T17 step appended to 0444 STATE.md", /completed/i.test(fs.readFileSync(stf, "utf8")), JSON.stringify(fs.readFileSync(stf, "utf8").slice(-200)));
  fs.chmodSync(stf, 0o644); // let the summary cleanup run clean
}

// ============ T18 — v0.32.0 (3.2): budget used → NO continuation (resumable session or not)
{
  const p = mkproj("t18-budget-used");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  const sess = path.join(T, "sess-t18.jsonl");
  fs.writeFileSync(sess, JSON.stringify({ t: 1 }) + "\n");
  mkWindow(p, "run-1", { status: "completed", exitReason: "hard-timeout", deadlineIso: ISO(Date.now() - 5000), sessionFile: sess, sessionId: "t18" });
  const r = await step(p, R(p, "run-1"), CFG);
  ok("T18 no continuation (3.2)", r.outcome?.next === "idle" && r.outcome?.reason === "budget-used", JSON.stringify(r.outcome));
  ok("T18 no run-2 (no launch at all)", !fs.existsSync(R(p, "run-2")));
  ok("T18 root paused", nodeState(p, "(root)") === "paused", nodeState(p, "(root)"));
  ok("T18 3.2 note in STATE.md", /used its budget — the run ended at its deadline \(3\.2\)/.test(fs.readFileSync(path.join(p, "STATE.md"), "utf8")));
}

// ============ T19 — v0.32.0 (3.2): budget used over the resume gate → still no continuation
{
  const p = mkproj("t19-budget-used");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)) });
  const sess = path.join(T, "sess-t19.jsonl");
  fs.writeFileSync(sess, "x".repeat(3_500_000)); // > 3MB default threshold
  mkWindow(p, "run-1", { status: "completed", exitReason: "hard-timeout", deadlineIso: ISO(Date.now() - 5000), sessionFile: sess });
  const r = await step(p, R(p, "run-1"), CFG);
  ok("T19 no continuation (3.2)", r.outcome?.next === "idle" && r.outcome?.reason === "budget-used", JSON.stringify(r.outcome));
  ok("T19 no run-2 (no launch at all)", !fs.existsSync(R(p, "run-2")));
  ok("T19 root paused", nodeState(p, "(root)") === "paused", nodeState(p, "(root)"));
}

// ============ T20 — v0.30.0 P3: re-entry RESUMES the parent's pre-spawn session
{
  const p = mkproj("t20-reentry-resume");
  const nodeDl20 = ISO(inMin(120));
  mkNode(p, "(root)", { deadline: nodeDl20, state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(90)) });
  const sess = path.join(T, "sess-t20.jsonl");
  fs.writeFileSync(sess, JSON.stringify({ t: 2 }) + "\n");
  const rw = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized", sessionFile: sess });
  fs.writeFileSync(path.join(rw, "spawn-decision.json"), JSON.stringify({ ok: true, node_path: "auth", window: "run-1" }));
  fs.mkdirSync(path.join(NR(p, "auth"), "run-1"), { recursive: true });
  fs.writeFileSync(path.join(NR(p, "auth"), "run-1", "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(90)) }, null, 2));
  const r = await step(p, path.join(NR(p, "auth"), "run-1"), CFG);
  ok("T20 reentry launched (re-activation)", r.outcome?.next === "reentry" && r.outcome?.node_path === "(root)", JSON.stringify(r.outcome));
  ok("T20 RE-ACTIVATES the spawn window (run-1), no run-2", r.outcome?.window === "run-1" && !fs.existsSync(R(p, "run-2")), JSON.stringify(r.outcome));
  ok("T20 re-entry deadline = the run's (node's) deadline (run4 fix F1)", r.outcome?.deadline === nodeDl20, r.outcome?.deadline);
  const args = fs.readFileSync(path.join(rw, "launch-args.txt"), "utf8");
  ok("T20 --session = parent's pre-spawn session", args.includes(`--session ${sess}`), args);
  ok("T20 launched into the same run dir", args.includes(`--out-dir ${rw}`) && args.includes(`--task-file ${path.join(rw, "RE-ENTRY.md")}`), args);
  ok("T20 original TASK.md untouched", fs.readFileSync(path.join(rw, "TASK.md"), "utf8").includes("task run-1"));
  const brief = fs.readFileSync(path.join(rw, "RE-ENTRY.md"), "utf8");
  ok("T20 resume brief: full context, no bookkeeping-only rule", brief.includes("RE-ENTRY (resume)") && brief.includes("RESUMES your own session") && !brief.includes("BOOKKEEPING"), brief.slice(0, 220));
  ok("T20 child report + spawn decision still embedded", brief.includes("Child's final report") && brief.includes('"node_path": "auth"'), brief.slice(0, 120));
  ok("T20 outcome flags resume", r.outcome?.resumed === true, JSON.stringify(r.outcome));
  const act20 = active(p);
  ok("T20 active.json → re-activated window", act20 && act20.node === "(root)" && act20.window === "run-1");
  ok("T20 STATE.md line says resumed", /resumed session/.test(fs.readFileSync(path.join(p, "STATE.md"), "utf8")), fs.readFileSync(path.join(p, "STATE.md"), "utf8").trim().split("\n").slice(-1)[0]);
  ok("T20 root node deadline unchanged", readNode(p, "(root)")?.deadline === nodeDl20);
}

// ============ T21 — v0.30.0 P3: re-entry FRESH (no session recorded)
{
  const p = mkproj("t21-reentry-fresh");
  const nodeDl21 = ISO(inMin(120));
  mkNode(p, "(root)", { deadline: nodeDl21, state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(90)) });
  const rw21 = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" }); // no sessionFile
  fs.mkdirSync(path.join(NR(p, "auth"), "run-1"), { recursive: true });
  fs.writeFileSync(path.join(NR(p, "auth"), "run-1", "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(90)) }, null, 2));
  const r = await step(p, path.join(NR(p, "auth"), "run-1"), CFG);
  ok("T21 reentry launched (re-activation)", r.outcome?.next === "reentry" && r.outcome?.window === "run-1", JSON.stringify(r.outcome));
  ok("T21 no run-2", !fs.existsSync(R(p, "run-2")));
  ok("T21 re-entry deadline = the run's (node's) deadline (run4 fix F1)", r.outcome?.deadline === nodeDl21, r.outcome?.deadline);
  const args = fs.readFileSync(R(p, "run-1/launch-args.txt"), "utf8");
  ok("T21 NO --session (nothing to resume)", !args.includes("--session"), args);
  const brief = fs.readFileSync(R(p, "run-1/RE-ENTRY.md"), "utf8");
  ok("T21 bookkeeping brief stands", brief.includes("RE-ENTRY") && brief.includes("BOOKKEEPING"), brief.slice(0, 160));
  ok("T21 outcome flags fresh", r.outcome?.resumed === false, JSON.stringify(r.outcome));
}

// ============ T22 — v0.30.0 P2: sessionGate unit cases
{
  const p = mkproj("t22-gate");
  const small = path.join(T, "sess-t22.jsonl");
  fs.writeFileSync(small, "x".repeat(1000));
  const big = path.join(T, "sess-t22-big.jsonl");
  fs.writeFileSync(big, "x".repeat(4 * 1048576));
  const g0 = sessionGate(path.join(p, "none"), CFG);
  ok("T22 no status → fresh", g0.resume === false && /no session recorded/.test(g0.why), JSON.stringify(g0));
  const w1 = mkWindow(p, "run-1", { sessionFile: small, sessionId: "id1" });
  const g1 = sessionGate(w1, CFG);
  ok("T22 small sessionFile → resume (path preferred over ID)", g1.resume === true && g1.ref === small, JSON.stringify(g1));
  mkWindow(p, "run-2", { sessionFile: big });
  const g2 = sessionGate(path.join(p, ".pi-supervisor", "runs", "run-2"), CFG);
  ok("T22 over threshold → fresh", g2.resume === false && /threshold/.test(g2.why), JSON.stringify(g2));
  mkWindow(p, "run-3", { sessionId: "bare-id" });
  const g3 = sessionGate(path.join(p, ".pi-supervisor", "runs", "run-3"), CFG);
  ok("T22 bare sessionId (unsizable) → fresh", g3.resume === false && /not a file path/.test(g3.why), JSON.stringify(g3));
  mkWindow(p, "run-4", { sessionFile: path.join(p, "gone.jsonl") });
  const g4 = sessionGate(path.join(p, ".pi-supervisor", "runs", "run-4"), CFG);
  ok("T22 unreadable session → fresh", g4.resume === false && /unreadable/.test(g4.why), JSON.stringify(g4));
  mkWindow(p, "run-5", { sessionFile: small });
  const g5 = sessionGate(path.join(p, ".pi-supervisor", "runs", "run-5"), { launch: { ...CFG.launch, overflowThresholdMb: 1 } });
  ok("T22 threshold configurable (1MB → small file now passes)", g5.resume === true, JSON.stringify(g5));
}

// ============ T23 — v0.31.0 conformity (5.1): human-root spelling (run<N>)
// A human root launch allocates `run<N>` (no hyphen, ralph.sh S0), not the
// chain's `run-N`. The re-entry lookups must still find that window's spawn
// decision + session (the run2 defect: fresh session, null decision).
{
  const p = mkproj("t23-root-spelling");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)), state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(90)) });
  const sess = path.join(T, "sess-t23.jsonl");
  fs.writeFileSync(sess, JSON.stringify({ t: 2 }) + "\n");
  const rw = mkWindow(p, "run1", { status: "completed", exitReason: "completed-finalized", sessionFile: sess });
  fs.writeFileSync(path.join(rw, "spawn-decision.json"), JSON.stringify({ ok: true, node_path: "auth", window: "run1" }));
  fs.mkdirSync(path.join(NR(p, "auth"), "run-1"), { recursive: true });
  fs.writeFileSync(path.join(NR(p, "auth"), "run-1", "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(90)) }, null, 2));
  const r = await step(p, path.join(NR(p, "auth"), "run-1"), CFG);
  ok("T23 reentry launched (parent is a run<N> dir)", r.outcome?.next === "reentry" && r.outcome?.node_path === "(root)", JSON.stringify(r.outcome));
  ok("T23 re-activates the run<N> dir, no run-2", r.outcome?.window === "run1" && !fs.existsSync(R(p, "run-2")), JSON.stringify(r.outcome));
  const args = fs.readFileSync(R(p, "run1/launch-args.txt"), "utf8");
  ok("T23 --session = parent's pre-spawn session", args.includes(`--session ${sess}`), args);
  const brief = fs.readFileSync(R(p, "run1/RE-ENTRY.md"), "utf8");
  ok("T23 non-null spawn decision embedded (5.1 observable)", brief.includes("RE-ENTRY (resume)") && brief.includes('"node_path": "auth"'), brief.slice(0, 220));
  ok("T23 outcome flags resume", r.outcome?.resumed === true, JSON.stringify(r.outcome));
}

// ============ T24 — run4 replay (run4 fix F1) at run4's EXACT values: hand-back
// with window-remaining 10 m 52 s and node-remaining 21.7 min. The old gate sized
// the re-entry against the window: floor(10.87)−10 (finalize) = 0 min → HALT
// ("52 s short of the window's deadline") — while the run's (node's) deadline was
// still 21.7 min out. D1-a: the re-entry is part of the run, so its budget is the
// run's deadline, never the window's hard stop → re-activation LAUNCHES.
{
  const p = mkproj("t24-reentry-run4-replay");
  const nodeDl24 = ISO(inMin(21.7));
  mkNode(p, "(root)", { deadline: nodeDl24, state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(21.7)) });
  mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized", deadlineIso: ISO(inMin(10.87)) }); // run4's window: 10 m 52 s of hard stop left at hand-back
  fs.writeFileSync(path.join(p, ".pi-supervisor", "runs", "run-1", "spawn-decision.json"), JSON.stringify({ ok: true, node_path: "auth", window: "run-1" }));
  const aw = path.join(NR(p, "auth"), "run-1");
  fs.mkdirSync(aw, { recursive: true });
  fs.writeFileSync(path.join(aw, "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(21.7)) }, null, 2));
  const r = await step(p, aw, CFG);
  ok("T24 (run4 replay) re-entry LAUNCHED — the run's deadline is alive (F1)", r.outcome?.next === "reentry" && r.outcome?.node_path === "(root)", JSON.stringify(r.outcome));
  ok("T24 re-activates run-1 (no run-2)", r.outcome?.window === "run-1" && !fs.existsSync(R(p, "run-2")), JSON.stringify(r.outcome));
  ok("T24 deadline = the run's (node's) deadline", r.outcome?.deadline === nodeDl24, r.outcome?.deadline);
  ok("T24 root active (not blocked)", nodeState(p, "(root)") === "active", nodeState(p, "(root)"));
  ok("T24 no halt marker (the run continued)", !fs.existsSync(path.join(aw, "chain-halt.json")));
}

// ============ T24b — the RUN's (node's) deadline is genuinely spent → halt (3.2):
// node blocked, halt marker (F2), INDEX halted (F5)
{
  const p = mkproj("t24b-run-deadline-spent");
  mkNode(p, "(root)", { deadline: ISO(Date.now() - 120000), state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(90)) });
  mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(p, ".pi-supervisor", "runs", "run-1", "spawn-decision.json"), JSON.stringify({ ok: true, node_path: "auth", window: "run-1" }));
  const aw = path.join(NR(p, "auth"), "run-1");
  fs.mkdirSync(aw, { recursive: true });
  fs.writeFileSync(path.join(aw, "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(90)) }, null, 2));
  const r = await step(p, aw, CFG);
  ok("T24b halt (the run's deadline was reached, 3.2)", r.outcome?.next === "halted", JSON.stringify(r.outcome));
  ok("T24b reason names the run's deadline and 3.2", /run's deadline/.test(r.outcome?.reason || "") && /was reached \(3\.2\)/.test(r.outcome?.reason || ""), r.outcome?.reason);
  // v0.35.17 (7.8): the reason is printed to the terminal — no ISO-8601 in it.
  ok("T24b reason carries no ISO timestamp (7.8)", !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(r.outcome?.reason || ""), r.outcome?.reason);
  ok("T24b root blocked", nodeState(p, "(root)") === "blocked");
  ok("T24b no launch (no run-2)", !fs.existsSync(R(p, "run-2")));
  ok("T24b halt marker written (F2)", fs.existsSync(path.join(aw, "chain-halt.json")));
  const hm = JSON.parse(fs.readFileSync(path.join(aw, "chain-halt.json"), "utf8"));
  ok("T24b marker carries the window's node + reason", hm.node === "auth" && /was reached \(3\.2\)/.test(hm.reason || ""), JSON.stringify(hm));
  const idx24b = JSON.parse(fs.readFileSync(R(p, "INDEX.json"), "utf8"));
  ok("T24b INDEX run-1 entry says halted (F5)", idx24b.runs.find((e) => e.run === "run-1")?.status === "halted", JSON.stringify(idx24b));
}

// ============ T25 — re-activation over the resume gate → fresh session, same run (5.3)
{
  const p = mkproj("t25-reentry-distill");
  const nodeDl25 = ISO(inMin(120));
  mkNode(p, "(root)", { deadline: nodeDl25, state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(90)) });
  const sess = path.join(T, "sess-t25.jsonl");
  fs.writeFileSync(sess, "x".repeat(3_500_000)); // > 3MB default threshold
  const rw = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized", sessionFile: sess });
  fs.writeFileSync(path.join(rw, "spawn-decision.json"), JSON.stringify({ ok: true, node_path: "auth", window: "run-1" }));
  const aw = path.join(NR(p, "auth"), "run-1");
  fs.mkdirSync(aw, { recursive: true });
  fs.writeFileSync(path.join(aw, "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(90)) }, null, 2));
  const r = await step(p, aw, CFG);
  ok("T25 re-entry still re-activates run-1", r.outcome?.window === "run-1" && !fs.existsSync(R(p, "run-2")), JSON.stringify(r.outcome));
  const args = fs.readFileSync(path.join(rw, "launch-args.txt"), "utf8");
  ok("T25 NO --session over the gate (5.3)", !args.includes("--session"), args);
  ok("T25 fresh allocation within the run's deadline (5.3, run4 fix F1)", r.outcome?.deadline === nodeDl25, r.outcome?.deadline);
  const brief = fs.readFileSync(path.join(rw, "RE-ENTRY.md"), "utf8");
  ok("T25 fresh bookkeeping brief", brief.includes("RE-ENTRY") && brief.includes("BOOKKEEPING"), brief.slice(0, 160));
  ok("T25 outcome flags fresh", r.outcome?.resumed === false, JSON.stringify(r.outcome));
  ok("T25 gate reason in STATE.md", /threshold/.test(fs.readFileSync(path.join(p, "STATE.md"), "utf8")));
}

// ============ T26 — the re-activated window gets a FRESH step at its final end
{
  const p = mkproj("t26-reentry-resteps");
  mkNode(p, "(root)", { deadline: ISO(inMin(120)), state: "paused(waiting:auth)" });
  mkNode(p, "auth", { deadline: ISO(inMin(90)) });
  const rw = mkWindow(p, "run-1", { status: "completed", exitReason: "completed-finalized" });
  fs.writeFileSync(path.join(rw, "spawn-decision.json"), JSON.stringify({ ok: true, node_path: "auth", window: "run-1" }));
  fs.writeFileSync(path.join(rw, "chain-done.json"), JSON.stringify({ v: 1, at: ISO(Date.now() - 300000), kind: "spawned", outcome: { next: "spawned", node_path: "auth", window: "run-1" } }));
  const aw = path.join(NR(p, "auth"), "run-1");
  fs.mkdirSync(aw, { recursive: true });
  fs.writeFileSync(path.join(aw, "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 60000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(90)) }, null, 2));
  const r1 = await step(p, aw, CFG);
  ok("T26 re-activation ran", r1.outcome?.next === "reentry" && r1.outcome?.window === "run-1", JSON.stringify(r1.outcome));
  // the re-activated window now terminates (completed) — a FRESH step must run
  // (NOT skipped: the chain-done marker was cleared on re-activation)
  fs.writeFileSync(path.join(rw, "pi-child-status.json"), JSON.stringify({ v: 2, at: ISO(Date.now() - 30000), status: "completed", exitReason: "completed-finalized", guardPid: deadPid(), deadlineIso: ISO(inMin(120)) }, null, 2));
  const r2 = await step(p, rw, CFG);
  ok("T26 final step is FRESH (marker cleared)", !r2.skipped && r2.kind === "completed", JSON.stringify(r2));
  ok("T26 run ends idle/done", r2.outcome?.next === "idle" && r2.outcome?.reason === "root-done", JSON.stringify(r2.outcome));
  ok("T26 root done", nodeState(p, "(root)") === "done");
  ok("T26 active cleared", active(p) === null);
}

// ---------- summary ----------
console.log(`\n=== ${passed} passed, ${failed} failed (sandbox: ${T}) ===`);
if (failed) { console.log("failed:", fails.join(" | ")); process.exit(1); }
// cleanup: kill the fake guards
spawnSync("pkill", ["-f", "sleep 217"], { stdio: "ignore" });
process.exit(0);
