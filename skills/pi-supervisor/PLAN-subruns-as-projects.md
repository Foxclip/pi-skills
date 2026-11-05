# Plan — sub-runs as projects (v0.27.0)

Status: draft for review. Untracked; do not commit until approved.

## 1. Goal

Today a sub-run is a **folder inside the parent's run tree**:
`MyProject/.pi-supervisor/runs/<name>/` (node.json, STATE.md, task.md, run-N/) — a
parallel bookkeeping layout only the parent's tree understands
(`scripts/lib/node.mjs:13`).

Target: a sub-run is a **normal project in a subfolder**:

```
MyProject/
  TASK.md
  .pi-supervisor/
    node.json            # root node bookkeeping (registry of children)
    active.json .lock    # scheduler slot + project lock (today's locations)
    runs/                # ROOT project's own windows only (run-1, run-2, …)
  Subproject/            # a sub-run = a real project, movable
    TASK.md              # written by the chain step (from the spawn request)
    STATE.md             # maintained by the subproject's child
    .pi-supervisor/
      node.json          # THIS node's identity — travels with the folder
      active.json .lock
      runs/  run-1/ run-2/ …   # its own windows, launched with cwd = here
    (its code, its git repo, …)
  Subproject/Deepwork/   # recursion is uniform
```

Requirements (from the discussion):
- A sub-run is "basically a normal run, but in a subfolder" — zero-arg `ralph`,
  guard, monitor, stop, harvest, protect, repair all work in it unchanged.
- The folder can be **moved out** of `MyProject/` and continued anywhere like any
  other project folder. After a move, the child **no longer has a parent to
  hand off to** — completion is terminal; the final report lives in its own last
  window, STATE.md at its own root.
- Handoff to the parent after a move is explicitly deprioritized ("not very
  important now").

Non-goals:
- No `--adopt`/re-attach-to-new-parent command (future).
- No migration tool for existing trees (legacy read support instead, §8).
- No `--dir` override (subproject dir name = spawn `--name`; keep identity
  simple).

## 2. Data model

**node.json moves from the node folder to the project's dot dir**, uniform for
root and sub-projects, and **travels with the folder**:

`<project>/.pi-supervisor/node.json` (v2):
```json
{
  "v": 2,
  "name": "auth",                  // "(root)" for the root node
  "path": "auth",                  // full tree path — "(root)" | "auth" | "auth/deeper"
  "parent": "(root)",              // parent's tree path; null when standalone
  "deadline": "…ISO…",             // invariant across windows (as today)
  "state": "active",               // same state vocabulary as today
  "children": [ { "name": "deeper", "dir": "Deepwork" } ],
  "createdAt": "…"
}
```

Rules:
- **Identity** = tree path (`auth`); **location** = stored mapping, not derived.
  The parent's `children[]` is the registry (name → dir relative to the parent
  project dir). Each node's own `path` gives O(1) reverse lookup
  (window dir → project → its node.json → path).
- **Join-or-create preserved**: spawning a name that exists under the same
  parent re-enters that node (new window), never a second node. A registry
  entry whose dir no longer exists is *stale*: a spawn with that name is
  rejected with "stale entry — restore the dir or clear the registry line"
  (never silently recreate a different project under an old name).
- **The child is sovereign about its own state** (its node.json); the parent's
  registry mirrors only name+dir. Tree rendering reads the child's node.json
  live (state, deadline, live window) and falls back to the mirror.
- Legacy fallback: a project with `.pi-supervisor/runs/node.json` and **no**
  `.pi-supervisor/node.json` is a v0.26 tree — readers keep working via the
  old path-derivation (`nodeDir = runs/<path>`). New spawns never create
  legacy nodes; a project is in one mode, decided per project root.

## 3. Scheduling invariants (what does NOT change)

- The **chain step remains the only thing that launches windows**
  ("agents propose, supervisor disposes"). `ralph.sh spawn` still only writes
  `spawn-request.json` (CLI unchanged).
- **One active window per tree** (flat scheduling, as today).
- Deadline invariant per node; window budget = `min(runtime, deadline − now)`
  (unchanged math).
- Chain step decision table (completed / budget-used / blocked / stopped,
  continuation / re-entry / halt) unchanged in shape; only *where* the next
  window is allocated changes.

What changes is *whose lock and whose active.json*:
- `PI_SUP_PROJECT` env (launch.mjs → guard) keeps today's meaning: **the
  window's own project** (active.json home, sessions dir, child cwd).
- New env `PI_SUP_TREE_ROOT` (set by the chain's launchWindow; defaults to the
  window's project): the **scheduler root**. The guard's chain hook
  (`guard.mjs:2262`) calls `chainStep(PI_SUP_TREE_ROOT || PI_SUP_PROJECT, …)`.
- Lock discipline: the chain step holds the **root** lock for its decision;
  `allocWindow` into a sub-project runs under **that sub-project's** lock
  (nested lock order: always root → child). A direct user launch into a nested
  project is refused (§5), so no cross-lock double-allocation exists.
- Active slots: `launch.mjs` writes the **window's project** active.json
  (unchanged); the chain step additionally maintains the **root's**
  active.json (the tree slot the root's attach follows) from the launch's
  returned guard pid, and clears both when a window ends. A detached/standalone
  project simply has no root slot to clear.

## 4. Lifecycle in the new layout

**Spawn** (chain step, under root lock): `processSpawnRequest`
(`lib/chain.mjs`) resolves the parent node's project dir P (registry walk from
the root; root → P = root project dir), then:
1. `mkdir P/<name>/`, write `P/<name>/TASK.md` (request's task text) — the
   subproject's root, next to its code.
2. Write `P/<name>/.pi-supervisor/node.json` (v2, `parent` = parent path,
   deadline inherited as today: request deadline → parent node deadline →
   parent window deadline → runtime-bounded).
3. Register `{name, dir: <name>}` in the parent's children (create the parent's
   node.json if absent — lazy root materialization, as today).
4. `allocWindow` into `P/<name>/.pi-supervisor/runs/` under the sub-project
   lock; write the brief as `run-1/TASK.md` (briefs unchanged except the
   STATE.md path wording: "your project dir, one up from .pi-supervisor").
5. Launch: `launch.mjs --project P/<name> --tree-root <root> …` with
   **spawn cwd = `P/<name>`** — the guard inherits it, RpcClient inherits it,
   so **the child pi's cwd is the subproject** and its pi sessions live there
   (session IDs resolve per-cwd — this is what makes it "a normal project").
6. Parent node → `paused(waiting:<name>)`; root active.json → the new window.

**Window ends** (guard → chain step at root):
- `completed` → child node done; **re-entry** window allocated in the *parent
  project's* dir (registry walk) with cwd = parent project dir, brief
  unchanged (RE-ENTRY, bookkeeping-only).
- `budget-used` → continuation `run-N+1` in the same subproject (cwd unchanged).
- `blocked`/`stopped` → halt, as today (active slots cleared, node blocked/
  stopped, STATE.md line).
- Stale-dir detection: any step that touches a registry entry with a missing
  dir commits `detached: <iso>` on that entry (see §6).

**Detached completion** (the moved subproject): its next window end fires the
chain hook with `PI_SUP_TREE_ROOT` pointing at a path that no longer contains
`.pi-supervisor` (the parent moved away or the tree root is gone) → the chain
**degrades to standalone mode**: same table with `isRoot = true` —
completed → idle/done (no re-entry; nothing to hand off to — the final report
in the last window dir + STATE.md at the project root ARE the deliverables),
budget-used → continuation, blocked → halt. The step also sets
`parent: null` in the project's own node.json (one-time demotion) and uses the
project's own lock/active slot from then on. A `chain-error.json` is NOT
written for this path (it is a normal mode change, logged to chain.log).

## 5. Direct `ralph` in a nested subproject (human at the terminal)

- `cd MyProject/Subproject && ralph` (zero-arg): **attach/view/stop/repair
  only** — everything that operates on the subproject's own `.pi-supervisor`
  works unchanged (its own active.json, runs/, monitor, stop, harvest).
- A **fresh launch is refused** when the project is nested (walk up from the
  project dir: an ancestor contains `.pi-supervisor` → nested), with a message
  pointing at the parent tree ("windows in a nested project are launched by the
  parent's chain step — spawn from inside, or run ralph in the parent").
  Exception: no nested project exists with a live window that needs no parent —
  the scheduler owns it, so refuse always; attach to the live window still works.
- Standalone project (no ancestor `.pi-supervisor`) → fully normal ralph,
  including fresh launches. This is exactly "continue like any other project
  folder with runs in it".
- Child sessions (PI_SUP_CHILD) keep today's gate: direct launches denied,
  `ralph.sh spawn` is the only mutating API; in a **detached** project spawn is
  refused up front (node.json `parent == null` → "this project has no parent
  tree — complete the task and end with a final report instead").

## 6. Move-out semantics (the child loses its parent)

- The user may `mv MyProject/Subproject /elsewhere` (or the whole MyProject
  tree) **only while no window in it is live** (documented; moving a live
  window's dir out from under its guard destroys the run — same as today).
- Parent side: the registry entry's dir is missing. `renderTree` shows
  `DETACHED (dir not found — moved?)` **computed live, no writes** (render
  stays pure). The next chain step touching the tree commits
  `detached: <iso>` on the entry. No re-entry is ever launched for a detached
  child; if the parent was `paused(waiting:X)` and X is detached, the parent's
  next step/attach shows it and halts with reason `child-moved` (human decides:
  clear the line, or point the registry at the new location manually).
- Child side: per §4 "detached completion" — demoted to `parent: null`,
  standalone table, its own lock. **There is no handoff to the parent by
  design at this point** (user: "it no longer has a parent that it can handoff
  anything to"). The deliverables are where a normal project's are:
  `Subproject/.pi-supervisor/runs/run-N/FINAL-REPORT.md` + `Subproject/STATE.md`.
- Future (out of scope): `ralph.sh adopt <dir> [--as <name>]` to re-register a
  moved project at a new location / under a new parent.

## 7. File-by-file changes

| File | Change |
|---|---|
| `scripts/lib/node.mjs` | node.json v2 at `.pi-supervisor/node.json`; `nodeDir`/`nodePathOf` become registry lookups (root project dir → its node.json `path`); add `projectOfNode(root, path)` (registry walk), `windowProjectOf(windowDir)` (walk up to nearest `.pi-supervisor`), `nestedParent(projectDir)` (ancestor walk for §5), stale/detached helpers; `ensureNode` split: root/registry entries vs materializing a subproject (that moves to chain.mjs §4); `renderTree` reads child node.json + live windows in child runs/; legacy fallback: `runs/<path>` when the project is in v0.26 mode. Keep pure readers lock-free. |
| `scripts/lib/chain.mjs` | `processSpawnRequest`: create `P/<name>/` project (TASK.md + node.json + registry line) instead of `runs/<name>/`; briefs: STATE.md wording "your project dir"; `launchWindow`: add `--project` = subproject dir, `--tree-root` = root, and **cwd = subproject dir** on the spawnSync; re-entry: resolve parent project dir via registry walk (cwd = parent dir); step(): detached-entry commit + `child-moved` halt; standalone degradation when `PI_SUP_TREE_ROOT` unresolvable (§4). |
| `scripts/launch.mjs` | New `--tree-root <dir>` flag (default: the project); set `PI_SUP_TREE_ROOT` in the guard env; spawn the guard with `cwd = project dir` (today: inherited — make explicit; the window's project, not the root); root active.json slot write moved to the chain step (see §3). |
| `scripts/guard.mjs` | Chain hook: `chainStep(process.env.PI_SUP_TREE_ROOT \|\| process.env.PI_SUP_PROJECT, outDir, …)` (+ null-guard: if tree root's `.pi-supervisor` is missing, that's the standalone path inside chain, not an error). Everything else unchanged (cwd is inherited from launch). |
| `scripts/ralph.sh` | Zero-arg in a nested project: refuse fresh launches (§5), attach/stop/repair as today; tree-banner condition updated (`.pi-supervisor/node.json` instead of `runs/node.json`); spawn help text: `--name` now names the **subproject dir** (no flag change). Version header → v0.27.0. |
| `scripts/lib/harvest.mjs`, `monitor.mjs`, `stop.mjs` | Expected: unchanged (they operate on run dirs / project dirs given explicitly). Verify + note in tests. |
| `scripts/test-node.mjs` | New units: registry lookup, windowProjectOf, nestedParent, stale entry, legacy fallback, v2 node.json round-trip. |
| `scripts/test-chain.mjs` | T1–T13 rebuilt on the new layout (e.g. T2 `R(p,"auth/node.json")` → `R(p,"auth/.pi-supervisor/node.json")`, child run dir → `auth/.pi-supervisor/runs/run-1`, root windows stay in root `runs/`). New scenarios: S1 spawn creates a project-level dir (not under runs/); S2 launch cwd = subproject (assert via status file cwd field); S3 move-out → next step commits detached + `child-moved` halt on the parent; S4 standalone completion after move (no re-entry, idle, `parent:null` demotion); S5 stale-entry spawn rejection; S6 nested direct-launch refusal (bash-level, test-ralph.sh); S7 legacy-tree step still works (read-only mode). |
| `scripts/test-tree.mjs` | Fixtures → new layout; DETACHED line rendering (live, no write); child state read from child node.json. |
| `scripts/test-ralph.sh` | New S-scene for §5 refusal + tree-banner condition. |
| `SKILL.md` | Rewrite the sub-runs section (layout, lifecycle, move-out, nested-attach rules); v0.27.0 release bullet; update the plan §2/§5.5 references. |
| Version headers | `ralph.sh`, `guard.mjs`, `chain.mjs`, `node.mjs`, `launch.mjs` → v0.27.0. |

## 8. Back-compat

- v0.26 trees (`runs/<name>/` node folders): fully readable and step-able
  (legacy mode per project root); no migration tool — finish old trees in place.
- `active.json` schema unchanged (run_dir/node/guard_pid/window/started_at/
  deadline) — now also written at the root for tree slots.
- `PI_SUP_*` env: names/meanings stable; only `PI_SUP_TREE_ROOT` added.

## 9. Test/rollout plan

1. Unit pass: node.mjs + chain.mjs suites green (new layout).
2. ralph.sh scenes green (spawn refusal, tree banner).
3. Manual e2e on a scratch project: root run → child spawns `Subproject/` →
   verify child cwd + sessions in `Subproject/` → budget continuation → done →
   root re-entry → root done. Then: stop all, `mv Subproject /tmp`, step the
   tree (detached + `child-moved`), run standalone `ralph` in the moved
   folder → continuation works → complete → idle, no re-entry, report in place.
4. Full suite run (all test-*.mjs + test-ralph.sh), version bump, commit
   "pi-supervisor: v0.27.0 — sub-runs as projects", SKILL.md release bullet.

## 10. Explicit open items (deferred, not blocking)

- `ralph.sh adopt <dir>` — re-register a moved project / new parent.
- `--dir` (dir name ≠ node name).
- A structured "hand back to parent" protocol (e.g. the parent re-reads a
  moved child's FINAL-REPORT when re-registered).
