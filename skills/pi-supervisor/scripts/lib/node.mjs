// lib/node.mjs — the sub-runs node model (v0.28.0 — sub-runs as projects;
// the v2 shape is the ONLY shape).
//
// Layout: a node is a PROJECT. The root node is the project itself; a
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
// The legacy v0.26 shape (root node = the runs/ folder, sub-runs as node
// folders under runs/, a runs/node.json registry) was removed in v0.28.0:
// those files are inert garbage the code never reads. A project that carries
// an old runs/ tree is simply adopted as the v2 root — its run-N windows
// already live in .pi-supervisor/runs/ and keep counting; old node folders
// and the old registry are ignored.
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
// Allocation (ensureRootNode / registerChild / allocWindowIn / withLock)
// must run under the project lock (withLock). The pure readers (nodeState,
// deriveTree, liveWindowIn) do not require the lock — they only read.

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

// nodePath: "(root)" | "auth" | "auth/deeper" (forward-slash, relative to
// the tree root).
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

// ---------- layout — sub-runs as projects (the only shape) ------------------
// The node file lives in the node's OWN project dot dir (root and
// sub-projects alike) and travels with the folder. The parent's registry
// (children: [{name, dir}]) maps a node name → dir relative to the parent
// project. A node's windows are always <project>/.pi-supervisor/runs/run-N.

export function supNodePath(projectDir) { return path.join(supRoot(projectDir), "node.json"); }

/**
 * Resolve a node to its project dir: registry walk from rootProject (the
 * root node → rootProject itself). Returns { dir, entry, stale } — dir is
 * null when the node is unknown (no registry entry) or STALE (entry exists,
 * its dir is gone — a move-out).
 */
export function projectOfNode(rootProject, nodePath) {
  const full = !nodePath || nodePath === ROOT ? ROOT : nodePath;
  if (full === ROOT) return { dir: rootProject, entry: null, stale: false };
  let dir = rootProject;
  let entry = null;
  for (const part of full.split("/").filter(Boolean)) {
    const nj = readJson(supNodePath(dir)) || {};
    entry = (Array.isArray(nj.children) ? nj.children : []).find((c) => c && c.name === part) || null;
    if (!entry) return { dir: null, entry: null, stale: false };
    dir = path.join(dir, String(entry.dir));
  }
  const exists = fs.existsSync(dir);
  return { dir: exists ? dir : null, entry, stale: !exists };
}

// Inverse of projectOfNode (v2): which node path resolves to projectDir.
//   "(root)" when projectDir IS the root project; a node path like "auth" /
//   "auth/ssl" when found in the registry; null when projectDir is not part
//   of this tree (moved away, never registered, or foreign).
export function nodePathOfProject(rootProject, projectDir) {
  const target = path.resolve(projectDir);
  if (path.resolve(rootProject) === target) return ROOT;
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

// ---------- node file locations ---------------------------------------------
// The node's node.json — in the node's project dot dir. null when the node
// resolves to nothing.
export function nodeJsonAt(rootProject, nodePath) {
  const { dir } = projectOfNode(rootProject, nodePath);
  return dir ? supNodePath(dir) : null;
}

// The window home within the node: <project>/.pi-supervisor/runs.
export function nodeRunsDir(rootProject, nodePath) {
  const { dir } = projectOfNode(rootProject, nodePath);
  return dir ? path.join(supRoot(dir), "runs") : null;
}

// STATE.md — the project root (uniform for root and sub-projects).
export function stateFileOf(rootProject, nodePath) {
  const { dir } = projectOfNode(rootProject, nodePath);
  return dir ? path.join(dir, "STATE.md") : null;
}

// ---------- names -----------------------------------------------------------
export function validNodeName(name) {
  if (typeof name !== "string" || !name) return { ok: false, why: "empty node name" };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    return { ok: false, why: `node name "${name}" must match [A-Za-z0-9][A-Za-z0-9._-]* (no slashes, dots-leading, or spaces)` };
  }
  if (/^run-?\d+$/i.test(name)) {
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

// ---------- v2 materialization + the parent registry ------------------------
// Lazily materialize the ROOT node (v2): node.json in the project's dot dir,
// STATE.md at the project root. Deadline is adopted only while unset (the
// invariant: once set, it does not move). Caller: hold the project lock.
export function ensureRootNode(projectDir, { deadline = null, state = "active", unblock = false } = {}) {
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
  } else {
    // v0.29.2 (run34): a PAST invariant deadline can only reject — every
    // spawn from this node inherits it and dies in windowBudget, and a plain
    // re-run of the project used to freeze the whole spawn tree. A fresh
    // launch with a FUTURE deadline refreshes a past (or unparseable) one;
    // a FUTURE invariant deadline still never moves.
    // v0.29.3 (run35): a refresh ALSO unblocks — a root marked blocked by a
    // chain halt is waiting for exactly this human attention (a fresh
    // launch); leaving it blocked contradicts the launch. (State is an
    // informational marker; the functional freeze was the past deadline.)
    // v0.30.1: unblock decoupled from the refresh — a fresh launch unblocks
    // a blocked root even when the deadline must not move (the v0.29.3
    // rationale "the fresh launch IS the human attention" no longer rides on
    // a deadline being past). The chain step's materialization call
    // (ensureRootNode(dir, {})) passes neither deadline nor unblock, so it
    // never touches state.
    const fresh = deadline ? parseDeadline(String(deadline)) : null;
    const old = nj.deadline ? parseDeadline(nj.deadline) : null;
    const refresh = Boolean(deadline) && (
      !nj.deadline
      || (fresh.ok && fresh.ts.getTime() > Date.now()
      && (!old.ok || old.ts.getTime() <= Date.now())));
    // both HALT classes wait for the same human attention (blocked = abnormal
    // end, stopped = user stop) — a fresh launch is that attention for both
    if (refresh || (unblock && ["blocked", "stopped"].includes(nj.state))) {
      if (refresh) nj.deadline = String(deadline);
      nj.state = "active";
      writeJson(p, nj);
    }
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
// Window dirs come in two spellings: `run-N` (chain allocation — allocWindowIn)
// and `runN` (human root launch — ralph.sh's S0 alloc). Both coexist in one
// runs dir, and every lookup must accept both (Spec 5.1: a re-entry must find
// the original window no matter who allocated it). The spelling is an
// implementation detail, not a Spec concept — never rename dirs to "unify".
export function windowNumber(name) {
  const m = /^run-?(\d+)$/.exec(String(name ?? ""));
  return m ? Number(m[1]) : null;
}
// Shared window-name check — both `run-N` (chain-allocated) and `runN`
// (human root launch) forms.
export function isWindowName(name) {
  return windowNumber(name) !== null;
}
const WINDOW_RE = /^run-?\d+$/;

export function listWindows(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((e) => e.isDirectory() && WINDOW_RE.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => windowNumber(a) - windowNumber(b));
}

export function newestWindow(dir) {
  const w = listWindows(dir);
  return w.length ? w[w.length - 1] : null;
}

// The next free window in an explicit runs dir (<project>/.pi-supervisor/
// runs/ — the node is already materialized, and the alloc runs under the
// sub-project's own lock nested under the root lock — plan §3): max(run-N) +
// 1, never reusing a number; an unharvested window dir counts as occupied
// (it exists). Caller: hold the lock.
export function allocWindowIn(runsDir) {
  fs.mkdirSync(runsDir, { recursive: true });
  const n = listWindows(runsDir).reduce((m, w) => Math.max(m, windowNumber(w)), 0);
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
  const { dir } = projectOfNode(rootProject, nodePath);
  if (!dir) return false;
  return liveWindowIn(path.join(supRoot(dir), "runs")) !== null;
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
  const { dir, entry } = projectOfNode(rootProject, full);
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
  const runs = path.join(supRoot(dir), "runs");
  const nj = readJson(supNodePath(dir));
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
