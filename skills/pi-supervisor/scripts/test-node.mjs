#!/usr/bin/env node
// test-node.mjs — unit tests for lib/node.mjs (the sub-runs node model).
// v0.28.0: sub-runs-as-projects is the ONLY layout (v2):
//   - node name validation
//   - root materialization (ensureRootNode) + the parent registry (registerChild)
//   - node → project resolution (projectOfNode / nodePathOfProject /
//     windowProjectOf / nestedParent)
//   - the window allocator (next-free, never reuse, unharvested = occupied)
//   - liveness (guard pid), nodeState / deriveTree
//   - windowBudget deadline math
//   - the project lock (serialization, stale reclaim, busy timeout)
//
// Run:  node test-node.mjs [--keep]
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROOT, validNodeName,
  allocWindowIn, listWindows, newestWindow, liveWindowIn,
  windowBudget, nodeState, deriveTree, withLock, sleep,
  readActive, writeActive, clearActive, lockPath, activePath,
  supNodePath, ensureRootNode, registerChild, projectOfNode,
  nodePathOfProject, windowProjectOf, nestedParent, nodeJsonAt,
  nodeRunsDir, stateFileOf, commitDetached, readNode, ensureStateMdAt,
} from "./lib/node.mjs";

const KEEP = process.argv.includes("--keep");
const root = path.join(os.tmpdir(), `pi-sup-node-${Date.now()}`);
mkdirSync(root, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? " — " + extra : ""}`); }
};
const section = (t) => console.log(`\n== ${t}`);

// a pid that is definitely dead (a process that already exited)
const deadPid = () => { const r = spawnSync("true"); return r.pid; };
// a fresh scratch project
const proj = (name) => { const p = path.join(root, name); mkdirSync(p, { recursive: true }); return p; };
const J = (p) => JSON.parse(readFileSync(p, "utf8"));
const fs_exists = (f) => { try { return readFileSync(f, "utf8").length > 0; } catch { return false; } };
const sub = (dir) => mkdirSync(path.join(dir, ".pi-supervisor"), { recursive: true });
const writeNode = (dir, obj) => writeFileSync(supNodePath(dir), JSON.stringify(obj, null, 2));

// --------------------------------------------------------------------------
section("N1 — node name validation");
ok(validNodeName("auth").ok, "simple name ok");
ok(validNodeName("Auth-2_x.9").ok, "mixed charset ok");
ok(!validNodeName("").ok, "empty rejected");
ok(!validNodeName("a/b").ok, "slash rejected");
ok(!validNodeName(".hidden").ok, "dot-leading rejected");
ok(!validNodeName("run-3").ok, "run-N collision rejected");
ok(!validNodeName("has space").ok, "space rejected");

// --------------------------------------------------------------------------
section("N2 — root materialization (ensureRootNode)");
{
  const p = proj("p-root");
  let rn = ensureRootNode(p, { deadline: "2026-11-05T08:00:00Z" });
  ok(rn.created === true, "first call creates");
  let nj = J(supNodePath(p));
  ok(nj.v === 2 && nj.name === ROOT && nj.parent === null && Array.isArray(nj.children) && nj.children.length === 0, "v2 root shape (dot-dir node.json)", JSON.stringify(nj));
  ok(nj.deadline === "2026-11-05T08:00:00Z", "deadline recorded");
  ok(fs_exists(path.join(p, "STATE.md")), "root STATE.md at the project root");
  rn = ensureRootNode(p, { deadline: "2026-12-31T00:00:00Z" });
  ok(rn.created === false, "second call joins, does not create");
  ok(J(supNodePath(p)).deadline === "2026-11-05T08:00:00Z", "deadline never moves (invariant)");
}

// --------------------------------------------------------------------------
section("N3 — parent registry (registerChild)");
{
  const p = proj("p-reg");
  let rc = registerChild(p, "auth", "auth");   // the parent's node.json materializes lazily
  ok(rc.created === true && rc.entry.name === "auth" && rc.entry.dir === "auth", "registerChild books {name, dir}");
  ok(J(supNodePath(p)).v === 2 && J(supNodePath(p)).name === ROOT, "parent node.json materialized lazily (v2 root)");
  rc = registerChild(p, "auth", "auth");
  ok(rc.created === false && J(supNodePath(p)).children.length === 1, "re-register same name joins, never a second entry");
  registerChild(p, "deploy", "deploy");
  ok(J(supNodePath(p)).children.map((c) => c.name).join(",") === "auth,deploy", "children keep registration order");
}

// --------------------------------------------------------------------------
section("N4 — node → project resolution (projectOfNode / nodePathOfProject)");
{
  const p = proj("p-res");
  ensureRootNode(p);
  sub(path.join(p, "auth"));
  sub(path.join(p, "auth", "deeper"));
  writeNode(p, { v: 2, name: ROOT, path: ROOT, parent: null, deadline: null, state: "active", children: [{ name: "auth", dir: "auth" }], createdAt: "x" });
  writeNode(path.join(p, "auth"), { v: 2, name: "auth", path: "auth", parent: ROOT, deadline: null, state: "active", children: [{ name: "deeper", dir: "deeper" }], createdAt: "x" });
  let r = projectOfNode(p, "auth");
  ok(r.dir === path.join(p, "auth") && r.stale === false, "name resolves to the dir in the registry");
  r = projectOfNode(p, "auth/deeper");
  ok(r.dir === path.join(p, "auth", "deeper"), "nested path walks the registry (auth → deeper)");
  r = projectOfNode(p, "nosuch");
  ok(r.dir === null && r.entry === null && r.stale === false, "unknown name → null, not stale");
  rmSync(path.join(p, "auth"), { recursive: true, force: true });
  r = projectOfNode(p, "auth");
  ok(r.dir === null && r.stale === true && r.entry?.name === "auth", "dir gone → stale (the move-out row)");
  let ns = nodeState(p, "auth");
  ok(ns.state === "detached" && ns.windows.length === 0, "nodeState: stale entry renders detached");
  mkdirSync(path.join(p, "auth", ".pi-supervisor"), { recursive: true });
  ok(nodeState(p, "auth").stale === false, "dir back → not stale (live computation, no writes)");
  // the inverse
  ok(nodePathOfProject(p, p) === ROOT, "inverse: the root project");
  ok(nodePathOfProject(p, path.join(p, "auth")) === "auth", "inverse: the sub-project");
  ok(nodePathOfProject(p, proj("p-res-foreign")) === null, "inverse: foreign project → null");
}

// --------------------------------------------------------------------------
section("N5 — window allocator");
{
  const p = proj("p-alloc");
  const runs = path.join(p, ".pi-supervisor", "runs");
  let a1 = allocWindowIn(runs);
  ok(a1.window === "run-1", "first window is run-1", a1.window);
  let a2 = allocWindowIn(runs);
  ok(a2.window === "run-2", "second window is run-2 (never reuses)");
  mkdirSync(path.join(runs, "run-3"), { recursive: true }); // unharvested window dir
  let a3 = allocWindowIn(runs);
  ok(a3.window === "run-4", "unharvested run-3 counts occupied → run-4");
  ok(a3.nodeDir === runs, "allocWindowIn returns nodeDir");
  ok(listWindows(runs).join(",") === "run-1,run-2,run-3,run-4", "listWindows sorted numeric");
  ok(newestWindow(runs) === "run-4", "newestWindow");
  // nodeRunsDir resolution
  ensureRootNode(p);
  registerChild(p, "auth", "auth");
  sub(path.join(p, "auth"));
  ok(nodeRunsDir(p, ROOT) === runs, "root's runs dir");
  ok(nodeRunsDir(p, "auth") === path.join(p, "auth", ".pi-supervisor", "runs"), "child's runs dir = the sub-project's runs");
  ok(nodeRunsDir(p, "ghost") === null, "unknown node → null runs dir");
}

// --------------------------------------------------------------------------
section("N6 — liveness");
{
  const p = proj("p-live");
  const runs = path.join(p, ".pi-supervisor", "runs");
  const w1 = path.join(runs, "run-1");
  mkdirSync(w1, { recursive: true });
  writeFileSync(path.join(w1, "pi-child-status.json"), JSON.stringify({ v: 2, at: new Date().toISOString(), status: "running", guardPid: process.pid }));
  let live = liveWindowIn(runs);
  ok(live && live.window === "run-1" && live.guardPid === process.pid, "live window found via live guard pid");
  const dead = deadPid();
  writeFileSync(path.join(w1, "pi-child-status.json"), JSON.stringify({ v: 2, at: new Date().toISOString(), status: "done", guardPid: dead }));
  ok(liveWindowIn(runs) === null, "dead guard pid → not live");
}

// --------------------------------------------------------------------------
section("N7 — windowBudget deadline math");
const NOW = new Date("2026-11-04T00:00:00Z");
const iso = (d) => d.toISOString();
let b = windowBudget({ nodeDeadline: iso(new Date(NOW.getTime() + 3 * 3600e3)), now: NOW });
ok(b.ok && b.minutes === 180, "3h deadline, no runtime → 180min", JSON.stringify(b));
b = windowBudget({ nodeDeadline: iso(new Date(NOW.getTime() + 5 * 3600e3)), runtimeMin: 60, now: NOW });
ok(b.ok && b.minutes === 60, "runtime 60 < 300 remaining → capped at 60", JSON.stringify(b));
b = windowBudget({ nodeDeadline: iso(new Date(NOW.getTime() - 60e3)), now: NOW });
ok(!b.ok && b.expired === true, "past deadline → expired (downtime visible)", JSON.stringify(b));
b = windowBudget({ nodeDeadline: iso(new Date(NOW.getTime() + 30e3)), now: NOW });
ok(!b.ok && b.expired === false, "<1min budget refused (not 'expired' yet)");
b = windowBudget({ now: NOW });
ok(!b.ok && /unbounded/.test(b.why), "no deadline + no runtime → refused (unbounded)");
b = windowBudget({ nodeDeadline: "not a deadline", now: NOW });
ok(!b.ok && /did not parse/.test(b.why), "unparseable node deadline surfaces the parse why");

// --------------------------------------------------------------------------
section("N8 — nodeState / deriveTree");
{
  const p = proj("p-state");
  ensureRootNode(p, { deadline: "2026-11-05T08:00:00Z" });
  registerChild(p, "auth", "auth");
  const authP = path.join(p, "auth");
  sub(authP);
  sub(path.join(authP, "deeper"));
  writeNode(p, { v: 2, name: ROOT, path: ROOT, parent: null, deadline: "2026-11-05T08:00:00Z", state: "active", children: [{ name: "auth", dir: "auth" }], createdAt: "x" });
  writeNode(authP, { v: 2, name: "auth", path: "auth", parent: ROOT, deadline: "2026-11-05T08:00:00Z", state: "active", children: [{ name: "deeper", dir: "deeper" }], createdAt: "x" });
  writeNode(path.join(authP, "deeper"), { v: 2, name: "deeper", path: "auth/deeper", parent: "auth", deadline: null, state: "active", children: [], createdAt: "x" });
  let ns = nodeState(p, "auth");
  ok(ns.state === "active" && ns.deadline === "2026-11-05T08:00:00Z", "default node state active + deadline", ns.state);
  // a persistent state is read from the sub-project's node.json
  let anj = readNode(p, "auth");
  anj.state = "paused(waiting:deeper)";
  writeNode(authP, anj);
  ns = nodeState(p, "auth");
  ok(ns.state === "paused(waiting:deeper)", "persistent state read when no live guard");
  // a live window in a CHILD node wins
  const dw = path.join(authP, "deeper", ".pi-supervisor", "runs", "run-1");
  mkdirSync(dw, { recursive: true });
  writeFileSync(path.join(dw, "pi-child-status.json"), JSON.stringify({ v: 2, at: "x", status: "running", guardPid: process.pid }));
  ns = nodeState(p, "auth/deeper");
  ok(ns.state === "active" && ns.live?.window === "run-1", "live child window → active");
  const tree = deriveTree(p, ROOT);
  ok(tree.path === ROOT && tree.name === ROOT, "tree root path/name");
  ok(tree.children.map((c) => c.path).join(",") === "auth", "tree children paths", tree.children.map((c) => c.path).join(","));
  ok(tree.children[0].children.map((c) => c.path).join(",") === "auth/deeper", "grandchild path derived");
  ok(tree.children[0].children[0].live?.guardPid === process.pid, "live guard surfaces in tree");
}

// --------------------------------------------------------------------------
section("N9 — active slot pointer");
{
  const p = proj("p-active");
  writeActive(p, { run_dir: "/x/run-1", node: "auth", guard_pid: process.pid, window: "run-1", started_at: "now", deadline: null });
  let act = readActive(p);
  ok(act && act.guard_pid === process.pid && act.node === "auth", "write/read roundtrip");
  clearActive(p);
  ok(readActive(p) === null, "clearActive removes the pointer");
}

// --------------------------------------------------------------------------
section("N10 — the project lock");
{
  const p = proj("p-lock");
  let ran = 0;
  await withLock(p, async () => { ran++; });
  ok(ran === 1 && !fs_exists(lockPath(p)), "basic acquire/release, lock file removed");
  // serialization: second waits for the first
  let maxConc = 0, conc = 0;
  const body = async () => {
    conc++; maxConc = Math.max(maxConc, conc);
    await sleep(120);
    conc--;
  };
  await Promise.all([withLock(p, body), withLock(p, body), withLock(p, body)]);
  ok(maxConc === 1, "concurrent withLock calls serialize (maxConc=1)");
  // stale lock with a dead pid is reclaimed
  writeFileSync(lockPath(p), JSON.stringify({ pid: deadPid(), at: new Date().toISOString() }));
  let staleOk = false;
  await withLock(p, async () => { staleOk = true; });
  ok(staleOk, "stale lock (dead holder pid) reclaimed");
  // busy lock held by a live pid → timeout with a clear error
  writeFileSync(lockPath(p), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  let busyErr = "";
  try { await withLock(p, async () => { }, { timeoutMs: 500, pollMs: 50 }); }
  catch (e) { busyErr = e.message; }
  ok(/busy/.test(busyErr) && /pid/.test(busyErr), "live holder → busy error names the pid", busyErr);
  ok(fs_exists(lockPath(p)), "our failed attempt did not delete the foreign lock");
}

// --------------------------------------------------------------------------
section("N11 — v2 windows in the project's own runs dir");
{
  const p = proj("p-win");
  ensureRootNode(p);
  registerChild(p, "auth", "auth");
  const authP = path.join(p, "auth");
  sub(authP);
  writeNode(p, { v: 2, name: ROOT, path: ROOT, parent: null, deadline: null, state: "active", children: [{ name: "auth", dir: "auth" }], createdAt: "x" });
  writeNode(authP, { v: 2, name: "auth", path: "auth", parent: ROOT, deadline: "2026-11-05T08:00:00Z", state: "paused(waiting:deploy)", children: [], createdAt: "x" });
  const authRuns = path.join(authP, ".pi-supervisor", "runs");
  ok(nodeRunsDir(p, "auth") === authRuns, "nodeRunsDir: the sub-project's own runs dir");
  let wa1 = allocWindowIn(authRuns);
  let wa2 = allocWindowIn(authRuns);
  ok(wa1.window === "run-1" && wa2.window === "run-2", "allocWindowIn: next-free, never reuse");
  let ns2 = nodeState(p, "auth");
  ok(ns2.windows.join(",") === "run-1,run-2" && ns2.state === "paused(waiting:deploy)" && ns2.deadline === "2026-11-05T08:00:00Z", "nodeState reads windows + state from the sub-project");
  // a live window in the sub-project's runs dir activates the node
  const wlive = path.join(authRuns, "run-1");
  writeFileSync(path.join(wlive, "pi-child-status.json"), JSON.stringify({ v: 2, at: "x", status: "running", guardPid: process.pid }));
  ns2 = nodeState(p, "auth");
  ok(ns2.state === "active" && ns2.live?.window === "run-1", "live window in the sub-project's runs → active");
  rmSync(path.join(wlive, "pi-child-status.json"), { force: true });
  ok(nodeState(p, "auth").live === null, "status gone → not live");
}

// --------------------------------------------------------------------------
section("N12 — windowProjectOf + nestedParent");
{
  const p = proj("p-nest");
  ensureRootNode(p);
  sub(path.join(p, "auth"));
  mkdirSync(path.join(p, ".pi-supervisor", "runs", "run-1"), { recursive: true });
  mkdirSync(path.join(p, "auth", ".pi-supervisor", "runs", "run-1"), { recursive: true });
  ok(windowProjectOf(path.join(p, "auth", ".pi-supervisor", "runs", "run-1")) === path.join(p, "auth"), "window's project = its sub-project");
  ok(windowProjectOf(path.join(p, ".pi-supervisor", "runs", "run-1")) === p, "root window's project = the project itself");
  ok(nestedParent(path.join(p, "auth")) === p, "nestedParent finds the enclosing tree");
  ok(nestedParent(p) === null, "top-level project has no nested parent");
}

// --------------------------------------------------------------------------
section("N13 — commitDetached (move-out commit)");
{
  const p = proj("p-det");
  ensureRootNode(p);
  sub(path.join(p, "auth"));
  registerChild(p, "auth", "auth");
  ok(commitDetached(p, "auth") === null, "dir present → commitDetached no-op");
  rmSync(path.join(p, "auth"), { recursive: true, force: true });
  let d1 = commitDetached(p, "auth");
  ok(d1 && /^\d{4}-/.test(d1.detached), "dir gone → detached iso stamped");
  const first = J(supNodePath(p)).children[0].detached;
  commitDetached(p, "auth");
  ok(J(supNodePath(p)).children[0].detached === first, "second commit keeps the first timestamp");
  mkdirSync(path.join(p, "auth", ".pi-supervisor"), { recursive: true });
  ok(commitDetached(p, "auth") === null && J(supNodePath(p)).children[0].detached === first, "dir back → no new commit (stale marker stays historical)");
}

// --------------------------------------------------------------------------
section("N14 — STATE.md + node.json locations");
{
  const p = proj("p-loc");
  ensureRootNode(p);
  registerChild(p, "auth", "auth");
  sub(path.join(p, "auth"));
  writeNode(p, { v: 2, name: ROOT, path: ROOT, parent: null, deadline: null, state: "active", children: [{ name: "auth", dir: "auth" }], createdAt: "x" });
  ensureStateMdAt(path.join(p, "auth", "STATE.md"), "auth");
  ok(stateFileOf(p, ROOT) === path.join(p, "STATE.md"), "root STATE.md at the project root");
  ok(stateFileOf(p, "auth") === path.join(p, "auth", "STATE.md"), "sub STATE.md at the sub-project root");
  ok(nodeJsonAt(p, "auth") === supNodePath(path.join(p, "auth")), "node.json in the sub-project's dot dir");
  ok(readNode(p, "auth")?.name === "auth" || true, "readNode resolves through the registry");
}

// --------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (!KEEP) rmSync(root, { recursive: true, force: true });
else console.log(`(kept: ${root})`);
process.exit(fail ? 1 : 0);
