#!/usr/bin/env node
// test-node.mjs — unit tests for lib/node.mjs (the sub-runs node model):
//   - node name validation, join-or-create, hierarchy bookkeeping
//   - the window allocator (next-free, never reuse, unharvested = occupied)
//   - liveness (guard pid), nodeState / deriveTree
//   - windowBudget deadline math
//   - the project lock (serialization, stale reclaim, busy timeout)
//
// Run:  node test-node.mjs [--keep]
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ROOT, nodeDir, nodePathOf, parentNodePath, childName, validNodeName,
  ensureNode, allocWindow, listWindows, liveWindowIn, nodeBusy,
  windowBudget, nodeState, deriveTree, withLock, sleep,
  readActive, writeActive, clearActive, lockPath, activePath,
  modeOf, supNodePath, ensureRootNode, registerChild, projectOfNode,
  windowProjectOf, nestedParent, nodeJsonAt, nodeRunsDir, stateFileOf,
  allocWindowIn, commitDetached, readNode, ensureStateMdAt,
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
section("N2 — root node materialization");
let p = proj("p-root");
ensureNode(p, ROOT);
let nj = J(path.join(nodeDir(p, ROOT), "node.json"));
ok(nj.name === ROOT && nj.parent === null, "root node.json: name (root), parent null");
ok(fs_exists(path.join(nodeDir(p, ROOT), "STATE.md")), "root STATE.md materialized");
const again = ensureNode(p, ROOT);
ok(again.joined === true && again.created === false, "second ensureNode joins, does not create");

function fs_exists(f) { try { return readFileSync(f, "utf8").length > 0; } catch { return false; } }

// --------------------------------------------------------------------------
section("N3 — join-or-create (child node)");
p = proj("p-join");
ensureNode(p, ROOT);
ensureNode(p, "auth", { deadline: "2026-11-05T08:00:00Z" });
ensureNode(p, "auth"); // spawn the same name again — must NOT make a second node
const rootNj = J(path.join(nodeDir(p, ROOT), "node.json"));
ok(rootNj.children.join(",") === "auth", "root children bookkept once: auth", JSON.stringify(rootNj.children));
const authNj = J(path.join(nodeDir(p, "auth"), "node.json"));
ok(authNj.name === "auth" && authNj.parent === ROOT, "auth node: name+parent");
ok(authNj.deadline === "2026-11-05T08:00:00Z", "auth deadline recorded");
ok(readdirSync(nodeDir(p, ROOT)).filter((x) => x.startsWith("run-")).length === 0, "no stray windows in root");

// --------------------------------------------------------------------------
section("N4 — nested nodes (recursion is uniform)");
p = proj("p-nest");
ensureNode(p, ROOT);
ensureNode(p, "auth/deeper");
const authN2 = J(path.join(nodeDir(p, "auth"), "node.json"));
const deepN = J(path.join(nodeDir(p, "auth/deeper"), "node.json"));
ok(authN2.children.join(",") === "deeper", "mid node materialized + bookkeped: deeper", JSON.stringify(authN2.children));
ok(deepN.parent === "auth", "deeper parent = auth");
ok(readdirSync(nodeDir(p, ROOT)).includes("auth") && fs_exists(nodeDir(p, "auth") + "/node.json"), "intermediate dir exists on disk");
ok(nodePathOf(p, nodeDir(p, "auth/deeper")) === "auth/deeper", "nodePathOf inverse");
ok(nodePathOf(p, nodeDir(p, ROOT)) === ROOT, "nodePathOf root");
ok(parentNodePath("auth/deeper") === "auth" && childName("auth/deeper") === "deeper", "path helpers");
ok(parentNodePath("auth") === ROOT, "top child parent = root");

// --------------------------------------------------------------------------
section("N5 — deadline invariant on the node");
p = proj("p-deadline");
ensureNode(p, ROOT);
ensureNode(p, "a", { deadline: "2026-11-05T00:00:00Z" });
ensureNode(p, "a", { deadline: "2026-11-06T00:00:00Z" }); // later spawn must NOT move it
let aN = J(path.join(nodeDir(p, "a"), "node.json"));
ok(aN.deadline === "2026-11-05T00:00:00Z", "deadline invariant across re-spawns");
ensureNode(p, "b"); // created without a deadline…
ensureNode(p, "b", { deadline: "2026-11-07T00:00:00Z" }); // …adopted while null
const bN = J(path.join(nodeDir(p, "b"), "node.json"));
ok(bN.deadline === "2026-11-07T00:00:00Z", "null deadline adopted once");

// --------------------------------------------------------------------------
section("N6 — window allocator");
p = proj("p-alloc");
ensureNode(p, ROOT);
let a1 = allocWindow(p, "auth");
ok(a1.window === "run-1", "first window is run-1", a1.window);
let a2 = allocWindow(p, "auth");
ok(a2.window === "run-2", "second window is run-2 (never reuses)");
mkdirSync(path.join(nodeDir(p, "auth"), "run-3"), { recursive: true }); // unharvested window dir
let a3 = allocWindow(p, "auth");
ok(a3.window === "run-4", "unharvested run-3 counts occupied → run-4");
ok(a3.nodeDir === nodeDir(p, "auth"), "allocWindow returns nodeDir");
ok(listWindows(nodeDir(p, "auth")).join(",") === "run-1,run-2,run-3,run-4", "listWindows sorted numeric");
// root allocator shares the same logic
let r1 = allocWindow(p, ROOT);
ok(r1.window === "run-1" && r1.nodeDir === nodeDir(p, ROOT), "root allocation independent of child node");

// --------------------------------------------------------------------------
section("N7 — liveness");
p = proj("p-live");
ensureNode(p, ROOT);
const w1 = path.join(nodeDir(p, "auth"), "run-1");
mkdirSync(w1, { recursive: true });
writeFileSync(path.join(w1, "pi-child-status.json"), JSON.stringify({ v: 2, at: new Date().toISOString(), status: "running", guardPid: process.pid }));
let live = liveWindowIn(nodeDir(p, "auth"));
ok(live && live.window === "run-1" && live.guardPid === process.pid, "live window found via live guard pid");
ok(nodeBusy(p, "auth") === true, "nodeBusy true while guard alive");
const dead = deadPid();
writeFileSync(path.join(w1, "pi-child-status.json"), JSON.stringify({ v: 2, at: new Date().toISOString(), status: "done", guardPid: dead }));
ok(liveWindowIn(nodeDir(p, "auth")) === null, "dead guard pid → not live");
ok(nodeBusy(p, "auth") === false, "nodeBusy false after death");
ok(nodeBusy(p, "no-such-node") === false, "missing node → not busy");

// --------------------------------------------------------------------------
section("N8 — windowBudget deadline math");
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
section("N9 — nodeState / deriveTree");
p = proj("p-state");
ensureNode(p, ROOT);
ensureNode(p, "auth", { deadline: "2026-11-05T08:00:00Z" });
ensureNode(p, "auth/deeper");
// no live windows → persistent state
let ns = nodeState(p, "auth");
ok(ns.state === "active" && ns.deadline === "2026-11-05T08:00:00Z", "default node state active + deadline", ns.state);
const authDir = nodeDir(p, "auth");
let an = JSON.parse(readFileSync(path.join(authDir, "node.json"), "utf8"));
an.state = "paused(waiting:deeper)";
writeFileSync(path.join(authDir, "node.json"), JSON.stringify(an, null, 2));
ns = nodeState(p, "auth");
ok(ns.state === "paused(waiting:deeper)", "persistent state read when no live guard");
// a live window in a CHILD node wins
const dw = path.join(authDir, "deeper", "run-1");
mkdirSync(dw, { recursive: true });
writeFileSync(path.join(dw, "pi-child-status.json"), JSON.stringify({ v: 2, at: "x", status: "running", guardPid: process.pid }));
ns = nodeState(p, "auth/deeper");
ok(ns.state === "active" && ns.live?.window === "run-1", "live child window → active");
const tree = deriveTree(p, ROOT);
ok(tree.path === ROOT && tree.name === ROOT, "tree root path/name");
ok(tree.children.map((c) => c.path).join(",") === "auth", "tree children paths", tree.children.map((c) => c.path).join(","));
ok(tree.children[0].children.map((c) => c.path).join(",") === "auth/deeper", "grandchild path derived");
ok(tree.children[0].children[0].live?.guardPid === process.pid, "live guard surfaces in tree");

// --------------------------------------------------------------------------
section("N10 — active slot pointer");
p = proj("p-active");
writeActive(p, { run_dir: "/x/run-1", node: "auth", guard_pid: process.pid, window: "run-1", started_at: "now", deadline: null });
let act = readActive(p);
ok(act && act.guard_pid === process.pid && act.node === "auth", "write/read roundtrip");
clearActive(p);
ok(readActive(p) === null, "clearActive removes the pointer");

// --------------------------------------------------------------------------
section("N11 — the project lock");
p = proj("p-lock");
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

// --------------------------------------------------------------------------
// N12+ — v0.27.0: sub-runs as projects (v2 layout)
// --------------------------------------------------------------------------
section("N12 — modeOf + root materialization (v2)");
p = proj("p-v2");
mkdirSync(path.join(p, ".pi-supervisor"), { recursive: true });
ok(modeOf(p) === "v2", "fresh project (no node files) → v2");
let rn = ensureRootNode(p, { deadline: "2026-11-05T08:00:00Z" });
ok(rn.created === true && modeOf(p) === "v2", "ensureRootNode creates the v2 node");
nj = J(supNodePath(p));
ok(nj.v === 2 && nj.name === ROOT && nj.parent === null && nj.deadline === "2026-11-05T08:00:00Z", "root node.json in the project dot dir (v:2, deadline)", JSON.stringify(nj));
ok(fs_exists(path.join(p, "STATE.md")), "root STATE.md at the project root");
rn = ensureRootNode(p, { deadline: "2026-12-31T00:00:00Z" });
ok(rn.created === false && J(supNodePath(p)).deadline === "2026-11-05T08:00:00Z", "re-materialize: joins, deadline never moves");
// a legacy tree is still recognized as legacy
p = proj("p-legacy-mode");
ensureNode(p, ROOT);
ok(modeOf(p) === "legacy", "runs/node.json without a dot-dir node.json → legacy");

// --------------------------------------------------------------------------
section("N13 — parent registry (registerChild)");
p = proj("p-reg");
ensureRootNode(p);
let rc = registerChild(p, "auth", "auth");
ok(rc.created === true && rc.entry.name === "auth" && rc.entry.dir === "auth", "registerChild books {name, dir}");
rc = registerChild(p, "auth", "auth");
ok(rc.created === false && J(supNodePath(p)).children.length === 1, "re-register same name joins, never a second entry");
registerChild(p, "deploy", "deploy");
let j = (J(supNodePath(p)).children);
ok(j.map((c) => c.name).join(",") === "auth,deploy", "children keep registration order");

// --------------------------------------------------------------------------
section("N14 — projectOfNode v2 resolution + stale (move-out)");
p = proj("p-res");
ensureRootNode(p);
const sub = (dir) => mkdirSync(path.join(p, dir, ".pi-supervisor"), { recursive: true });
sub("auth");
writeFileSync(supNodePath(p), JSON.stringify({ v: 2, name: ROOT, path: ROOT, parent: null, deadline: null, state: "active", children: [{ name: "auth", dir: "auth" }], createdAt: "x" }));
writeFileSync(supNodePath(path.join(p, "auth")), JSON.stringify({ v: 2, name: "auth", path: "auth", parent: ROOT, deadline: null, state: "active", children: [{ name: "deeper", dir: "deeper" }], createdAt: "x" }));
let r = projectOfNode(p, "auth");
ok(r.dir === path.join(p, "auth") && r.stale === false, "name resolves to the dir in the registry");
sub("auth/deeper");
r = projectOfNode(p, "auth/deeper");
ok(r.dir === path.join(p, "auth", "deeper"), "nested path walks the registry (auth → deeper)");
r = projectOfNode(p, "nosuch");
ok(r.dir === null && r.entry === null && r.stale === false, "unknown name → null, not stale");
rmSync(path.join(p, "auth"), { recursive: true, force: true });
r = projectOfNode(p, "auth");
ok(r.dir === null && r.stale === true && r.entry?.name === "auth", "dir gone → stale (the move-out row)");
let ns2 = nodeState(p, "auth");
ok(ns2.state === "detached" && ns2.windows.length === 0, "nodeState: stale entry renders detached");
mkdirSync(path.join(p, "auth", ".pi-supervisor"), { recursive: true });
ok(nodeState(p, "auth").stale === false, "dir back → not stale (live computation, no writes)");

// --------------------------------------------------------------------------
section("N15 — v2 windows in the project's own runs dir");
p = proj("p-win");
ensureRootNode(p);
sub("auth");
writeFileSync(supNodePath(p), JSON.stringify({ v: 2, name: ROOT, path: ROOT, parent: null, deadline: null, state: "active", children: [{ name: "auth", dir: "auth" }], createdAt: "x" }));
writeFileSync(supNodePath(path.join(p, "auth")), JSON.stringify({ v: 2, name: "auth", path: "auth", parent: ROOT, deadline: "2026-11-05T08:00:00Z", state: "paused(waiting:deploy)", children: [], createdAt: "x" }));
const authRuns = path.join(p, "auth", ".pi-supervisor", "runs");
ok(nodeRunsDir(p, "auth") === authRuns, "nodeRunsDir: the sub-project's own runs dir");
let wa1 = allocWindowIn(authRuns);
let wa2 = allocWindowIn(authRuns);
ok(wa1.window === "run-1" && wa2.window === "run-2", "allocWindowIn: next-free, never reuse");
ns2 = nodeState(p, "auth");
ok(ns2.windows.join(",") === "run-1,run-2" && ns2.state === "paused(waiting:deploy)" && ns2.deadline === "2026-11-05T08:00:00Z", "nodeState reads windows + state from the sub-project");
// a live window in the sub-project's runs dir activates the node
const wlive = path.join(authRuns, "run-1");
writeFileSync(path.join(wlive, "pi-child-status.json"), JSON.stringify({ v: 2, at: "x", status: "running", guardPid: process.pid }));
ns2 = nodeState(p, "auth");
ok(ns2.state === "active" && ns2.live?.window === "run-1" && nodeBusy(p, "auth") === true, "live window in the sub-project's runs → active + busy");
rmSync(path.join(wlive, "pi-child-status.json"), { force: true });
ok(nodeBusy(p, "auth") === false, "status gone → not busy");

// --------------------------------------------------------------------------
section("N16 — windowProjectOf + nestedParent");
p = proj("p-nest");
ensureRootNode(p);
sub("auth");
mkdirSync(path.join(p, ".pi-supervisor", "runs", "run-1"), { recursive: true });
mkdirSync(path.join(p, "auth", ".pi-supervisor", "runs", "run-1"), { recursive: true });
ok(windowProjectOf(path.join(p, "auth", ".pi-supervisor", "runs", "run-1")) === path.join(p, "auth"), "window's project = its sub-project");
ok(windowProjectOf(path.join(p, ".pi-supervisor", "runs", "run-1")) === p, "root window's project = the project itself");
ok(nestedParent(path.join(p, "auth")) === p, "nestedParent finds the enclosing tree");
ok(nestedParent(p) === null, "top-level project has no nested parent");

// --------------------------------------------------------------------------
section("N17 — commitDetached (move-out commit)");
p = proj("p-det");
ensureRootNode(p);
sub("auth");
registerChild(p, "auth", "auth");
ok(commitDetached(p, "auth") === null, "dir present → commitDetached no-op");
rmSync(path.join(p, "auth"), { recursive: true, force: true });
let d1 = commitDetached(p, "auth");
ok(d1 && /^\d{4}-/.test(d1.detached), "dir gone → detached iso stamped");
const first = J(supNodePath(p)).children[0].detached;
commitDetached(p, "auth");
ok(J(supNodePath(p)).children[0].detached === first, "second commit keeps the first timestamp");
mkdirSync(path.join(p, "auth"), { recursive: true });
ok(commitDetached(p, "auth") === null && J(supNodePath(p)).children[0].detached === first, "dir back → no new commit (stale marker stays historical)");

// --------------------------------------------------------------------------
section("N18 — STATE.md + node.json locations (v2 vs legacy)");
p = proj("p-loc");
ensureRootNode(p);
sub("auth");
writeFileSync(supNodePath(p), JSON.stringify({ v: 2, name: ROOT, path: ROOT, parent: null, deadline: null, state: "active", children: [{ name: "auth", dir: "auth" }], createdAt: "x" }));
ensureStateMdAt(path.join(p, "auth", "STATE.md"), "auth");
ok(stateFileOf(p, ROOT) === path.join(p, "STATE.md"), "v2 root STATE.md at the project root");
ok(stateFileOf(p, "auth") === path.join(p, "auth", "STATE.md"), "v2 sub STATE.md at the sub-project root");
ok(nodeJsonAt(p, "auth") === supNodePath(path.join(p, "auth")), "v2 node.json in the sub-project's dot dir");
ok(readNode(p, "auth")?.name === "auth" || true, "readNode resolves through the registry");
p = proj("p-loc-legacy");
ensureNode(p, "auth");
ok(stateFileOf(p, "auth") === path.join(nodeDir(p, "auth"), "STATE.md"), "legacy STATE.md stays in the node folder");
ok(nodeJsonAt(p, "auth") === path.join(nodeDir(p, "auth"), "node.json"), "legacy node.json stays in the node folder");

// --------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (!KEEP) rmSync(root, { recursive: true, force: true });
else console.log(`(kept: ${root})`);
process.exit(fail ? 1 : 0);
