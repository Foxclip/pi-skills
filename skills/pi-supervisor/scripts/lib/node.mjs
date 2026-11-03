// lib/node.mjs — the sub-runs node model (v0.26.0).
//
// A node is a FOLDER in the project's run tree:
//   <project>/.pi-supervisor/runs/            ← the ROOT node
//     node.json  STATE.md  run-1/ run-2/ ...  ← windows
//     auth/                      ← child node (a sub-project)
//       node.json  STATE.md  task.md  run-1/ ...
//       deeper/                  ← grandchild node — recursion is uniform
//
// Rules (plan §2):
//   - node = folder identity. Join-or-create: a name that exists under the
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

export function readNode(projectDir, nodePath) {
  return readJson(nodeJsonPath(nodeDir(projectDir, nodePath)));
}

function ensureStateMd(dir, name) {
  const sp = path.join(dir, "STATE.md");
  if (!fs.existsSync(sp)) {
    fs.writeFileSync(sp, [
      `# STATE — ${name}`,
      "",
      "- goal: (set by the chain step / maintained by this node's child)",
      "- verified facts:",
      "  - (none yet)",
      "- next: (none yet)",
      "",
    ].join("\n"));
  }
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
export function nodeBusy(projectDir, nodePath) {
  return liveWindowIn(nodeDir(projectDir, nodePath)) !== null;
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
export function nodeState(projectDir, nodePath) {
  const full = nodePath || ROOT;
  const dir = nodeDir(projectDir, full);
  const nj = readJson(nodeJsonPath(dir));
  const live = liveWindowIn(dir);
  let state;
  if (live) state = "active";
  else if (nj && nj.state) state = nj.state;
  else state = "unknown";
  return {
    nodePath: full,
    name: nj?.name ?? (full === ROOT ? ROOT : childName(full)),
    dir,
    state,
    live,
    deadline: nj?.deadline ?? null,
    children: Array.isArray(nj?.children) ? nj.children : [],
    windows: listWindows(dir),
  };
}

// Nested tree for the terminal banner: { path, name, state, deadline, live,
// children: [...] } — children ordered as bookkept in node.json.
export function deriveTree(projectDir, nodePath = ROOT) {
  const s = nodeState(projectDir, nodePath);
  return {
    path: s.nodePath,
    name: s.name,
    state: s.state,
    deadline: s.deadline,
    live: s.live ? { window: s.live.window, guardPid: s.live.guardPid, at: s.live.status?.at ?? null } : null,
    windows: s.windows.length,
    children: s.children.map((c) => deriveTree(projectDir, s.nodePath === ROOT ? c : `${s.nodePath}/${c}`)),
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
    st = wait ? `PAUSED waiting ${wait[1]}` : st.toUpperCase();
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
