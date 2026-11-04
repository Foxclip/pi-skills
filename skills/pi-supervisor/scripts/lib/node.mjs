// lib/node.mjs — the sub-runs node model (v0.27.0 — sub-runs as projects).
//
// v2 layout: a node is a PROJECT. The root node is the project itself; a
// child node is a subfolder that is a project in its own right:
//   <project>/
//     TASK.md  STATE.md
//     .pi-supervisor/
//       node.json              ← this node's identity (v: 2) — travels with it
//       active.json  .lock
//       runs/  run-1/ run-2/   ← this project's own windows
//     auth/                    ← child node (a sub-project — registered in this
//       …                      ← node.json's children: [{name, dir}])
//
// Legacy v0.26 trees keep the old layout (runs/<path>/node.json, the root
// node = the runs/ folder). The mode is decided per project root (modeOf):
// runs/node.json present and no .pi-supervisor/node.json → legacy; a fresh
// project (neither) is v2. New spawns never create legacy nodes.
//
// Rules (plan §2):
//   - node = project identity. Join-or-create: a name that exists under the
//     same parent IS that node — spawning it re-enters the node (a new
//     window), never a second node.
//   - the queue unit is the node; run-N is a WINDOW within a node.
//   - hierarchy is bookkeeping on disk; scheduling is flat (one active window
//     project-wide, tracked in .pi-supervisor/active.json).
//   - the node's deadline is INVARIANT across its windows; a window's budget
//     is min(runtime, nodeDeadline − now).
//
// Allocation (ensureNode / allocWindow / withLock) must run under the project
// lock (withLock). The pure readers (nodeState, deriveTree, liveWindowIn) do
// not require the lock — they only read.

import fs from "fs";
import path from "path";
import { pathToFileURL } from "node:url";
import { parseDeadline } from "./deadline.mjs";

export const ROOT = "(root)";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- layout paths ----------------------------------------------------
export function supRoot(projectDir) { return path.join(projectDir, ".pi-supervisor"); }
export function runsRoot(projectDir) { return path.join(supRoot(projectDir), "runs"); }
export function activePath(projectDir) { return path.join(supRoot(projectDir), "active.json"); }
export function lockPath(projectDir) { return path.join(supRoot(projectDir), ".lock"); }

// nodePath: "(root)" | "auth" | "auth/deeper" (forward-slash, relative to runs/)
export function nodeDir(projectDir, nodePath) {
  if (!nodePath || nodePath === ROOT) return runsRoot(projectDir);
  const parts = String(nodePath).split("/").filter((p) => p.length && p !== "." && p !== "..");
  if (!parts.length) return runsRoot(projectDir);
  return path.join(runsRoot(projectDir), ...parts);
}

// Inverse of nodeDir — null when the dir is outside the run tree.
export function nodePathOf(projectDir, dir) {
  const root = runsRoot(projectDir);
  const d = path.resolve(dir);
  if (d === root) return ROOT;
  const rel = path.relative(root, d);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

export function parentNodePath(nodePath) {
  if (!nodePath || nodePath === ROOT) return null;
  const parts = String(nodePath).split("/").filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") : ROOT;
}

export function childName(nodePath) {
  const parts = String(nodePath || "").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// ---------- v0.27.0 layout — sub-runs as projects ---------------------------
// The v2 node file lives in the node's OWN project dot dir (root and
// sub-projects alike) and travels with the folder. The parent's registry
// (children: [{name, dir}]) maps a node name → dir relative to the parent
// project. A node's windows are always <project>/.pi-supervisor/runs/run-N
// (legacy: inside the node folder under runs/).

export function supNodePath(projectDir) { return path.join(supRoot(projectDir), "node.json"); }

// "v2" | "legacy" — decided per project root (plan §2): the v2 node file wins,
// then a legacy runs/node.json marks a v0.26 tree, and a fresh project is v2.
export function modeOf(projectDir) {
  if (fs.existsSync(supNodePath(projectDir))) return "v2";
  if (fs.existsSync(path.join(runsRoot(projectDir), "node.json"))) return "legacy";
  return "v2";
}

/**
 * Resolve a node to its project dir.
 *   v2: registry walk from rootProject (the root node → rootProject itself).
 *   legacy: the old nodeDir derivation.
 * Returns { dir, entry, stale, mode }. dir is null when the node is unknown
 * (no registry entry) or STALE (entry exists, its dir is gone — a move-out).
 */
export function projectOfNode(rootProject, nodePath) {
  const full = !nodePath || nodePath === ROOT ? ROOT : nodePath;
  const mode = modeOf(rootProject);
  // legacy: the root node IS the runs/ folder itself; v2: the project dir.
  if (full === ROOT) {
    return mode === "legacy"
      ? { dir: nodeDir(rootProject, ROOT), entry: null, stale: false, mode }
      : { dir: rootProject, entry: null, stale: false, mode };
  }
  if (mode === "legacy") {
    const d = nodeDir(rootProject, full);
    return { dir: fs.existsSync(d) ? d : null, entry: null, stale: false, mode };
  }
  let dir = rootProject;
  let entry = null;
  for (const part of full.split("/").filter(Boolean)) {
    const nj = readJson(supNodePath(dir)) || {};
    entry = (Array.isArray(nj.children) ? nj.children : []).find((c) => c && c.name === part) || null;
    if (!entry) return { dir: null, entry: null, stale: false, mode };
    dir = path.join(dir, String(entry.dir));
  }
  const exists = fs.existsSync(dir);
  return { dir: exists ? dir : null, entry, stale: !exists, mode };
}

// Inverse of projectOfNode (v2): which node path resolves to projectDir.
//   "(root)" when projectDir IS the root project; a node path like "auth" /
//   "auth/ssl" when found in the registry; null when projectDir is not part
//   of this tree (moved away, never registered, or foreign).
export function nodePathOfProject(rootProject, projectDir) {
  const target = path.resolve(projectDir);
  if (path.resolve(rootProject) === target) return ROOT;
  if (modeOf(rootProject) === "legacy") return null;
  const queue = [[rootProject, ROOT]];
  let guard = 0;
  while (queue.length && guard++ < 10000) {
    const [cur, curPath] = queue.shift();
    const nj = readJson(supNodePath(cur)) || {};
    for (const e of (Array.isArray(nj.children) ? nj.children : [])) {
      if (!e || !e.name) continue;
      const p = curPath === ROOT ? String(e.name) : `${curPath}/${e.name}`;
      const d = path.join(cur, String(e.dir));
      if (path.resolve(d) === target) return p;
      queue.push([d, p]);
    }
  }
  return null;
}

// The nearest ancestor of windowDir (self first) that contains .pi-supervisor
// — the window's own project (v2: <project>/.pi-supervisor/runs/run-N).
export function windowProjectOf(windowDir) {
  let d = path.resolve(windowDir);
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(d, ".pi-supervisor"))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return null;
}

// The nearest ANCESTOR of projectDir (self excluded) containing .pi-supervisor
// — non-null means the project is nested inside another tree, so its windows
// are launched by that tree's chain step, not by a direct ralph (plan §5).
export function nestedParent(projectDir) {
  let d = path.dirname(path.resolve(projectDir));
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(d, ".pi-supervisor"))) return d;
    const p = path.dirname(d);
    if (p === d) break;
    d = p;
  }
  return null;
}

// ---------- mode-aware node file locations ----------------------------------
// The node's node.json — v2: in the node's project dot dir; legacy: in the
// node folder under runs/. null when the node resolves to nothing.
export function nodeJsonAt(rootProject, nodePath) {
  const { dir, mode } = projectOfNode(rootProject, nodePath);
  if (mode === "legacy") return nodeJsonPath(nodeDir(rootProject, nodePath));
  return dir ? supNodePath(dir) : null;
}

// The window home within the node — v2: <project>/.pi-supervisor/runs;
// legacy: the node folder itself.
export function nodeRunsDir(rootProject, nodePath) {
  const { dir, mode } = projectOfNode(rootProject, nodePath);
  if (mode === "legacy") return nodeDir(rootProject, nodePath);
  return dir ? path.join(supRoot(dir), "runs") : null;
}

// STATE.md — v2: the project root (uniform for root and sub-projects);
// legacy: the node folder.
export function stateFileOf(rootProject, nodePath) {
  const { dir, mode } = projectOfNode(rootProject, nodePath);
  if (mode === "legacy") return path.join(nodeDir(rootProject, nodePath), "STATE.md");
  return dir ? path.join(dir, "STATE.md") : null;
}

// ---------- names -----------------------------------------------------------
export function validNodeName(name) {
  if (typeof name !== "string" || !name) return { ok: false, why: "empty node name" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return { ok: false, why: `node name "${name}" must match [A-Za-z0-9][A-Za-z0-9._-]* (no slashes, dots-leading, or spaces)` };
  }
  if (/^run-\d+$/i.test(name)) {
    return { ok: false, why: `node name "${name}" collides with the window names (run-N)` };
  }
  return { ok: true };
}

// ---------- json helpers ----------------------------------------------------
export function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}
export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, p);
}

// ---------- pids ------------------------------------------------------------
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// ---------- node.json -------------------------------------------------------
export function nodeJsonPath(dir) { return path.join(dir, "node.json"); }

export function readNode(rootProject, nodePath) {
  const p = nodeJsonAt(rootProject, nodePath);
  return p ? readJson(p) : null;
}

export function ensureStateMdAt(p, name) {
  if (fs.existsSync(p)) return;
  fs.writeFileSync(p, [
    `# STATE — ${name}`,
    "",
    "- goal: (set by the chain step / maintained by this node's child)",
    "- verified facts:",
    "  - (none yet)",
    "- next: (none yet)",
    "",
  ].join("\n"));
}

function ensureStateMd(dir, name) {
  ensureStateMdAt(path.join(dir, "STATE.md"), name);
}

/**
 * Join-or-create a node. A name that exists under the same parent IS that
 * node — this never creates a second one. Materializes the folder, node.json
 * (deadline taken only at creation — invariant afterwards) and STATE.md, and
 * registers the child under its parent's children list (parents materialized
 * lazily up to the root).
 *
 * Returns { node, dir, created, joined }. Throws on an invalid name.
 * Caller: hold the lock (ensureNode writes).
 */
export function ensureNode(projectDir, nodePath, { deadline = null, state = "active" } = {}) {
  const full = !nodePath || nodePath === ROOT ? ROOT : nodePath;
  if (full !== ROOT) { // the root node is the one name that needs no validation
    for (const part of full.split("/").filter(Boolean)) {
      const v = validNodeName(part);
      if (!v.ok) throw new Error(v.why);
    }
  }
  const dir = nodeDir(projectDir, full);
  fs.mkdirSync(dir, { recursive: true });
  const p = nodeJsonPath(dir);
  let nj = readJson(p);
  const created = !nj;
  if (created) {
    nj = {
      v: 1,
      name: full === ROOT ? ROOT : childName(full),
      parent: parentNodePath(full),
      deadline: deadline ? String(deadline) : null,
      state,
      children: [],
      createdAt: new Date().toISOString(),
    };
    writeJson(p, nj);
  } else if (!nj.deadline && deadline) {
    // adopt a deadline only while the node has none (the invariant is "the
    // node holds the sub-project deadline" — once set, it does not move)
    nj.deadline = String(deadline);
    writeJson(p, nj);
  }
  ensureStateMd(dir, nj.name);
  const pp = parentNodePath(full);
  if (pp) {
    const pnj = ensureNode(projectDir, pp, {}).node;
    if (!Array.isArray(pnj.children)) pnj.children = [];
    const nm = childName(full);
    if (!pnj.children.includes(nm)) {
      pnj.children.push(nm);
      writeJson(nodeJsonPath(nodeDir(projectDir, pp)), pnj);
    }
  }
  return { node: readJson(p), dir, created, joined: !created };
}

// ---------- v2 materialization + the parent registry ------------------------
// Lazily materialize the ROOT node (v2): node.json in the project's dot dir,
// STATE.md at the project root. Deadline is adopted only while unset (the
// invariant: once set, it does not move). Caller: hold the project lock.
export function ensureRootNode(projectDir, { deadline = null, state = "active" } = {}) {
  const p = supNodePath(projectDir);
  let nj = readJson(p);
  const created = !nj;
  if (created) {
    nj = {
      v: 2,
      name: ROOT,
      path: ROOT,
      parent: null,
      deadline: deadline ? String(deadline) : null,
      state,
      children: [],
      createdAt: new Date().toISOString(),
    };
    writeJson(p, nj);
  } else if (!nj.deadline && deadline) {
    nj.deadline = String(deadline);
    writeJson(p, nj);
  }
  ensureStateMdAt(path.join(projectDir, "STATE.md"), ROOT);
  return { node: readJson(p), dir: projectDir, created };
}

// Register a child under its parent (v2, plan §4): the {name, dir} line in the
// parent's children (dir relative to the parent project). Join-or-create: an
// existing name returns its entry, never a second. Creates the parent's
// node.json lazily when absent (materialization with the parent's identity).
// Caller: hold the parent project's lock.
export function registerChild(parentProjectDir, name, dirName, { parentPath = ROOT } = {}) {
  let nj = readJson(supNodePath(parentProjectDir));
  if (!nj) {
    nj = {
      v: 2,
      name: parentPath === ROOT ? ROOT : childName(parentPath),
      path: parentPath || ROOT,
      parent: parentPath === ROOT ? null : parentNodePath(parentPath),
      deadline: null,
      state: "active",
      children: [],
      createdAt: new Date().toISOString(),
    };
  }
  if (!Array.isArray(nj.children)) nj.children = [];
  const existing = nj.children.find((c) => c && c.name === name);
  if (existing) return { entry: existing, created: false };
  const entry = { name, dir: dirName };
  nj.children.push(entry);
  writeJson(supNodePath(parentProjectDir), nj);
  return { entry, created: true };
}

// Commit `detached: <iso>` on a registry entry whose dir is gone — the first
// chain step after a move-out (plan §6; renderTree computes the DETACHED line
// live, no writes). No-op when the entry is absent or its dir is back.
export function commitDetached(parentProjectDir, name) {
  const p = supNodePath(parentProjectDir);
  const nj = readJson(p);
  if (!nj || !Array.isArray(nj.children)) return null;
  const entry = nj.children.find((c) => c && c.name === name);
  if (!entry) return null;
  if (fs.existsSync(path.join(parentProjectDir, String(entry.dir)))) return null;
  if (!entry.detached) {
    entry.detached = new Date().toISOString();
    writeJson(p, nj);
  }
  return entry;
}

// ---------- windows ---------------------------------------------------------
const WINDOW_RE = /^run-(\d+)$/;

export function listWindows(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((e) => e.isDirectory() && WINDOW_RE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

export function newestWindow(dir) {
  const w = listWindows(dir);
  return w.length ? w[w.length - 1] : null;
}

/**
 * Allocate the next free window in a node: max(run-N) + 1 — never reuses a
 * number, and an unharvested window dir counts as occupied (it exists).
 * Caller: hold the lock.
 */
export function allocWindow(projectDir, nodePath, { deadline = null } = {}) {
  ensureNode(projectDir, nodePath, { deadline });
  const dir = nodeDir(projectDir, nodePath);
  const n = listWindows(dir).reduce((m, w) => Math.max(m, Number(w.slice(4))), 0);
  const name = `run-${n + 1}`;
  const wdir = path.join(dir, name);
  fs.mkdirSync(wdir, { recursive: true });
  return { window: name, dir: wdir, nodeDir: dir, nodePath: nodePath || ROOT };
}

// The next free window in an explicit runs dir (v2: <project>/.pi-supervisor/
// runs/ — the node is already materialized, and the alloc runs under the
// sub-project's own lock nested under the root lock — plan §3). Same
// never-reuse rule as allocWindow.
export function allocWindowIn(runsDir) {
  fs.mkdirSync(runsDir, { recursive: true });
  const n = listWindows(runsDir).reduce((m, w) => Math.max(m, Number(w.slice(4))), 0);
  const name = `run-${n + 1}`;
  const wdir = path.join(runsDir, name);
  fs.mkdirSync(wdir, { recursive: true });
  return { window: name, dir: wdir, nodeDir: runsDir, nodePath: null };
}

// ---------- liveness --------------------------------------------------------
/**
 * A window is LIVE when its pi-child-status.json names a guard pid that is
 * still running. Returns { window, dir, guardPid, status } | null.
 */
export function liveWindowIn(dir) {
  for (const w of listWindows(dir)) {
    const wdir = path.join(dir, w);
    const st = readJson(path.join(wdir, "pi-child-status.json"));
    if (st && st.guardPid != null && pidAlive(st.guardPid)) {
      return { window: w, dir: wdir, guardPid: st.guardPid, status: st };
    }
  }
  return null;
}

// True when the node already has a live window — "do NOT relaunch into the
// same tree".
export function nodeBusy(rootProject, nodePath) {
  const { dir, mode } = projectOfNode(rootProject, nodePath);
  if (!dir) return false;
  const runs = mode === "legacy" ? dir : path.join(supRoot(dir), "runs");
  return liveWindowIn(runs) !== null;
}

// ---------- active slot -----------------------------------------------------
// active.json: { run_dir, node, guard_pid, window, started_at, deadline }
// Written by launch.mjs at window start; cleared by the chain step at window
// end. Single-writer discipline: only those two touch it.
export function readActive(projectDir) {
  return readJson(activePath(projectDir));
}

export function activeLive(projectDir) {
  const a = readActive(projectDir);
  return a && a.guard_pid != null && pidAlive(a.guard_pid) ? a : null;
}

export function writeActive(projectDir, obj) {
  writeJson(activePath(projectDir), obj);
}

export function clearActive(projectDir) {
  try { fs.unlinkSync(activePath(projectDir)); } catch { /* already gone */ }
}

// ---------- deadline math ---------------------------------------------------
/**
 * Window budget = min(runtime, nodeDeadline − now).
 *   nodeDeadline: ISO/epoch string (the node's invariant deadline) or null
 *   runtimeMin:   a per-window cap in minutes, or null
 * Returns { ok: true, deadlineIso, deadlineMs, minutes, remainingMs } or
 *          { ok: false, expired, why } — expired=true is the deadline-expired
 *          case (downtime must not silently burn the budget).
 */
export function windowBudget({ nodeDeadline = null, runtimeMin = null, now = new Date() } = {}) {
  const nowMs = now.getTime();
  let cap = null;
  if (nodeDeadline) {
    const P = parseDeadline(nodeDeadline);
    if (!P.ok) return { ok: false, expired: false, why: `node deadline did not parse: ${P.why}` };
    cap = P.ts.getTime();
  }
  const hasRuntime = Number.isFinite(runtimeMin) && runtimeMin > 0;
  if (cap === null && !hasRuntime) {
    return { ok: false, expired: false, why: "no deadline and no runtime — the window would be unbounded" };
  }
  if (cap !== null && cap <= nowMs) {
    return { ok: false, expired: true, why: `node deadline ${nodeDeadline} is in the past` };
  }
  const endMs = Math.min(cap === null ? Infinity : cap, nowMs + (hasRuntime ? runtimeMin * 60000 : Infinity));
  const minutes = Math.floor((endMs - nowMs) / 60000);
  if (minutes < 1) {
    return { ok: false, expired: cap !== null && cap <= nowMs, why: `window budget is < 1min (deadline cap ${cap === null ? "none" : new Date(cap).toISOString()}, runtime ${hasRuntime ? runtimeMin : "none"}min)` };
  }
  return { ok: true, deadlineIso: new Date(endMs).toISOString(), deadlineMs: endMs, minutes, remainingMs: endMs - nowMs };
}

// ---------- derived state ---------------------------------------------------
/**
 * A node's live state: a live guard in any of its windows wins (it is
 * "active"); otherwise the persistent node.json state (paused(waiting:…)|
 * done|deadline-expired|stopped|blocked|active).
 */
export function nodeState(rootProject, nodePath) {
  const full = nodePath || ROOT;
  const { dir, mode, entry } = projectOfNode(rootProject, full);
  if (!dir) {
    // Unknown, or a registry entry whose dir is gone (the DETACHED row).
    return {
      nodePath: full,
      name: full === ROOT ? ROOT : childName(full),
      dir: null,
      state: entry ? "detached" : "unknown",
      live: null,
      deadline: null,
      children: [],
      childrenEntries: [],
      windows: [],
      stale: Boolean(entry),
      detached: entry?.detached ?? null,
    };
  }
  const runs = mode === "legacy" ? dir : path.join(supRoot(dir), "runs");
  const nj = mode === "legacy" ? readJson(nodeJsonPath(dir)) : readJson(supNodePath(dir));
  const live = liveWindowIn(runs);
  let state;
  if (live) state = "active";
  else if (nj && nj.state) state = nj.state;
  else state = "unknown";
  const childrenEntries = (Array.isArray(nj?.children) ? nj.children : [])
    .map((c) => (typeof c === "string" ? { name: c, dir: c } : c))
    .filter((c) => c && c.name);
  return {
    nodePath: full,
    name: nj?.name ?? (full === ROOT ? ROOT : childName(full)),
    dir,
    state,
    live,
    deadline: nj?.deadline ?? null,
    children: childrenEntries.map((c) => c.name),
    childrenEntries,
    windows: listWindows(runs),
    stale: false,
    detached: null,
  };
}

// Nested tree for the terminal banner: { path, name, state, deadline, live,
// windows, children: [...] } — children ordered as bookkept in the node's
// registry; a stale entry renders as a DETACHED node (computed live).
export function deriveTree(rootProject, nodePath = ROOT) {
  return deriveNode(rootProject, nodePath);
}

function deriveNode(rootProject, nodePath) {
  const s = nodeState(rootProject, nodePath);
  return {
    path: s.nodePath,
    name: s.name,
    state: s.state,
    deadline: s.deadline,
    live: s.live ? { window: s.live.window, guardPid: s.live.guardPid, at: s.live.status?.at ?? null } : null,
    windows: s.windows.length,
    stale: s.stale,
    detached: s.detached,
    children: s.childrenEntries.map((c) => deriveNode(rootProject, nodePath === ROOT ? c.name : `${nodePath}/${c.name}`)),
  };
}

// ---------- the project lock ------------------------------------------------
// <project>/.pi-supervisor/.lock — O_EXCL file, pid inside. Allocation +
// chain steps run under it; a dead holder (dead pid) or an old holder
// (mtime > staleMs) makes the lock reclaimable.
export async function withLock(projectDir, fn, { timeoutMs = 60000, staleMs = 300000, pollMs = 100 } = {}) {
  const lf = lockPath(projectDir);
  fs.mkdirSync(path.dirname(lf), { recursive: true });
  const start = Date.now();
  for (;;) {
    let fd = null;
    try {
      fd = fs.openSync(lf, "wx");
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (staleLock(lf, staleMs)) { try { fs.unlinkSync(lf); } catch { /* raced — retry */ } continue; }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`.lock busy: held by pid ${lockHolder(lf)} (still alive, waited ${((Date.now() - start) / 1000).toFixed(1)}s)`);
      }
      await sleep(pollMs);
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
  }
  try {
    return await fn();
  } finally {
    try { fs.unlinkSync(lf); } catch { /* best effort */ }
  }
}

function lockHolder(lf) {
  const j = readJson(lf);
  return j?.pid != null ? String(j.pid) : "?";
}

function staleLock(lf, staleMs) {
  let st;
  try { st = fs.statSync(lf); } catch { return true; }
  if (Date.now() - st.mtimeMs > staleMs) return true;
  const j = readJson(lf);
  return j?.pid != null && !pidAlive(j.pid);
}

// ---------- terminal banner -------------------------------------------------
const humanDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${r}s` : `${r}s`;
};
const shortIso = (iso) => (iso ? String(iso).slice(5, 16).replace("T", " ") : null);

/**
 * The sub-runs tree as a boxed, append-only banner (plan §5.5) — printed on
 * attach and every handoff. Plain text, no ANSI (the caller colors the whole
 * block dim if it wants). One line per node, depth-indented:
 *   state (live windows name their window + age; paused names the child it
 *   waits on; every node shows its deadline when it has one).
 */
export function renderTree(projectDir, { now = new Date() } = {}) {
  const tree = deriveTree(projectDir);
  const rows = [];
  const walk = (n, depth) => {
    const prefix = depth === 0 ? "" : "  ".repeat(depth - 1) + "  ";
    const name = `${prefix}${depth === 0 ? "" : "└ "}${n.name}`.padEnd(24);
    const bits = [];
    let st = n.state;
    const wait = String(st).match(/^paused\(waiting:([^)]+)\)$/);
    st = wait ? `PAUSED waiting ${wait[1]}` : n.state === "detached" ? "DETACHED (dir not found — moved?)" : st.toUpperCase();
    bits.push(st);
    const dl = n.deadline ? shortIso(n.deadline) : null;
    if (n.live) {
      const age = n.live.at ? humanDur(now - new Date(n.live.at).getTime()) : null;
      let s = n.live.window;
      if (age) s += `, ${age} in`;
      if (dl) s += `, deadline ${dl}`;
      bits.push(s);
    } else {
      if (n.windows > 1) bits.push(`${n.windows} windows`);
      if (dl) bits.push(`deadline ${dl}`);
    }
    rows.push(`${name} ${bits.join("  ")}`);
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(tree, 0);
  const title = `${path.basename(path.resolve(projectDir))} · sub-runs`;
  const lines = [title, ...rows];
  const w = Math.max(...lines.map((l) => l.length)) + 1;
  const top = `╭ ${title}`.padEnd(w + 1, " ") + "╮";
  const body = lines.map((l) => `│ ${l}`.padEnd(w + 1, " ") + "│");
  return [top, ...body, `╰${"─".repeat(w)}╯`].join("\n");
}

// ---------- CLI ----------
// node node.mjs tree <project-dir> — the sub-runs tree banner (ralph.sh / the
// monitor print it on attach + every handoff; plan §5.5).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, projectDir] = process.argv.slice(2);
  if (cmd === "tree" && projectDir && fs.existsSync(projectDir)) {
    process.stdout.write(renderTree(projectDir) + "\n");
  } else {
    console.error("usage: node node.mjs tree <project-dir>");
    process.exit(cmd === "tree" ? 1 : 2);
  }
}
