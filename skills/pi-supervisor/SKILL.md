---
name: pi-supervisor
description: Spawn and interact with a second pi agent as a child process (RPC mode) for multi-turn agent-to-agent work. Use for long-lived, isolated second pi — parallel work, sub-conversations, orchestrated follow-ups — that one-shot `pi --print` cannot cover. Also bundles guard.mjs for unattended long runs (loop/stall/degenerate-settle detection, steer→rewind→fork→stuck ladder, workspace invariants, parent nudge inbox, --expect-file artifacts, context-overflow distill-and-relaunch, always-on progress log + v:2 liveness status), launch.mjs (verified detached launcher, --deadline sizing), monitor.mjs (early-return wait loop with liveness detection), stop.mjs (ordered group-kill stop + state snapshot) and campaign.mjs (durable multi-run campaigns — goal+deadline state file, verified-facts ledger, next-run loop).
---

# Interacting with a child pi process

A pi agent can spawn and converse with another pi agent. It is not limited to `acp_delegate` subagents. Pick the lightest interface that fits:

| Need | Interface | How |
|---|---|---|
| One-shot task, final text is enough | Print mode | `pi --print "task"` (plain bash) |
| One-shot, structured events | JSON mode | `pi --mode json "task"` |
| Multi-turn, bidirectional | **RPC mode** | `scripts/rpc-child.mjs` in this skill, or a custom `RpcClient` script |
| One long autonomous job, unattended | **Supervised RPC** | `scripts/guard.mjs` (loop/stall detection + steer→rewind→fork→stuck ladder) |
| In-process Node/Bun, full API | SDK | `createAgentSession()` from `@earendil-works/pi-coding-agent` |

If the child's job is fire-and-forget with no ongoing dialogue, `acp_delegate` is usually better: clean context, async, result saved to a file.

## Quickstart (bundled harness)

Run `scripts/rpc-child.mjs` (relative to this skill directory) **from the directory the child should work in** — the child inherits that cwd.

```bash
# One-shot
node scripts/rpc-child.mjs "Explain this repository in one paragraph"

# Multi-turn: each --turn is sent only after the previous child reply settles
node scripts/rpc-child.mjs \
  --turn "Introduce yourself and ask me one short question" \
  --turn "Now answer your own question in one sentence; end with FINISHED"
```

Output: the child's live streamed text, then `[reply-N]` blocks, then a final machine-readable line —

```
=== RESULT === {"replies":["...", "..."]}
```

Parse that line for programmatic use. Exit code is non-zero on timeout or child failure. Options: `--provider`, `--model`, `--timeout <ms>`, `--keep-question-tool`, `--session-id <id>`, `--session <path|id>`, `--session-dir <dir>`, `--name <name>`, `--help`.

## Session persistence and resuming

By default the harness runs the child with `--no-session` — throwaway. Nothing is saved, so there is nothing to resume. To make a job resumable, persist the session under a stable ID, and reuse that ID (from the same working directory) in later runs:

```bash
# run 1 — creates the session
node scripts/rpc-child.mjs --session-id my-job --name "my-job" --turn "step 1..."

# run 2 — later, e.g. after a timeout or crash: continues the conversation
node scripts/rpc-child.mjs --session-id my-job --turn "continue; do step 2..."
```

Every run prints the resolved session to stderr (`[info] session id=... file=...`). Resumed turns are appended to the same transcript, so the child sees all earlier turns. `--session-id` creates the session if missing, so runs 1 and 2 use the same code path.
To resume a session created elsewhere (e.g. a TUI run), pass its file or exact ID instead:

```bash
node scripts/rpc-child.mjs --session <path-or-exact-id> --turn "..."
```

- Sessions are stored per-project: under `~/.pi/agent/sessions/`, grouped by working directory (override with `--session-dir <dir>`). The same `--session-id` from a *different cwd* silently creates a fresh session in that project.
- `--session` with a partial ID may open the interactive session picker, which blocks forever in RPC mode (there is no TUI). Pass the full path or full ID — from the `[info] session ...` line, or via `pi --resume` in a normal terminal.
- Don't point a child at a session that is open in another running pi (e.g. this session's own file) — two writers on one transcript. `pi --fork <id>` makes a branch you can hand to a child instead.
- Runtime alternative in a custom client: `client.switchSession(path)` / `client.newSession()` load a different session into an already-running child (`docs/rpc-commands.md`).

## Critical gotchas (learned the hard way — do not skip)

1. **The child matches the parent session's model by default.** Precedence: explicit `--provider`/`--model` flags > `PI_PROVIDER`/`PI_MODEL` env vars (pi sets these on its own tools) > the parent session file (`PI_SESSION_FILE`, else the most recently modified session jsonl under `~/.pi/agent/sessions` — covers envs where pi exports no session vars, e.g. MCP sandboxes; the info log names the file when both fields came from there). If none of those exist the child falls back to the *configured default* model — for local providers (llama.cpp) that means loading a different GGUF: very slow, or failing.
2. **`RpcClient.promptAndWait` defaults to a 60-second timeout.** Slow local models exceed this. Always pass an explicit per-turn timeout (harness default: 5 min; `--timeout <ms>`). If a turn may exceed even that, see **Long-running work** below.
3. **Dialog tools hang the child.** `ask_user_question` (and similar extension-UI dialog tools) make the child emit an `extension_ui_request` on stdout and block until the client sends back a matching `extension_ui_response` on stdin. The harness excludes `ask_user_question` by default (`--keep-question-tool` retains it — then your client MUST answer dialogs per the RPC extension-UI protocol). The supervisor additionally excludes `acp_delegate` from the child's toolset by default (v0.4.0) — a child's sub-agents would run outside the supervision ladder (`--keep-delegate-tool` retains it).
4. **The child has zero context from the parent conversation.** Every prompt must be self-contained: include file paths, constraints, and everything the child needs — the same rule as writing `acp_delegate` tasks.
5. **`agent_end` ≠ done.** Retries, compaction, or queued work can follow `agent_end`; wait for `agent_settled` (the harness does this via `promptAndWait`).
6. **The child's stdout is the protocol.** Diagnostics belong on stderr; never write non-protocol data to the child's stdin/stdout.
7. **Windows/Node**: the child needs the pi CLI entry `dist/bundle/cli.js` of the installed package (the package `bin`), not `dist/cli.js` from a repo checkout. The harness resolves the install automatically: `PI_PACKAGE_DIR` env > self-managed install (`~/.pi/agent/install/releases/<ver>` per `current-version`) > npm global > `%APPDATA%\npm` (Windows).
8. **Sessions are per-project.** The same `--session-id` resolves only in the same working directory (sessions live under `~/.pi/agent/sessions`, grouped by cwd). Resuming from a different cwd silently starts a fresh session. `--session`/`--session-id` must reference an exact ID or path — partial IDs may open the interactive picker, which blocks forever in RPC mode.
9. **Campaign state is git-ignored, not git-tracked.** `campaign.mjs` keeps its state in `<project>/.pi-supervisor/<name>.json` — bookkeeping, not source. Add `.pi-supervisor/` to the project's `.gitignore` (`init` warns when it is missing). A reboot wipes the /tmp run out-dirs; the campaign file survives and marks those runs `gone` — the history lives on, the artifacts do not.
10. **A campaign is one live run at a time.** `campaign next` pid-checks the latest run's guard before spawning (never the status file — it lies when the host died) and refuses while that pid is alive. Stop the run first (`campaign stop`).

## Long-running work (when a turn exceeds the timeout)

The timeout is **client-side, wall-clock, per turn**. When it fires, `promptAndWait` rejects with `Timeout collecting events`, the harness exits non-zero, and `client.stop()` closes the child's stdin — an **orderly shutdown**: the child aborts the in-flight turn and exits (no orphan process). **No rollback**: tool side effects already completed stay on disk; the partial turn is lost, and with `--no-session` there is no transcript to resume it. Completed earlier turns remain in the output (`[reply-N]` blocks; the exit code marks the failure).

Mitigations:

1. **Raise it**: `--timeout 3600000` (1 h). It is a hard wall-clock deadline, so size it to the job.
2. **Decompose into more, smaller turns** — the interactive advantage: the parent reads each `[reply-N]`/`RESULT` line and sends the next step, so every turn gets its own budget and you can react mid-job instead of blind-waiting on one long prompt.
3. **Custom client with an idle-based timeout** — the built-in deadline is wall-clock from prompt send, so a legitimate long tool run plus a long generation can trip it even though nothing is wrong. In a custom `RpcClient` script, reset the deadline on every incoming event (text deltas, `tool_execution_start`/`update`, `bash_execution_update`): an actively working child keeps emitting events; only a genuinely hung child (e.g. stalled provider, unanswered dialog) goes silent.
4. **Persist the child's session** for long jobs — pass `--session-id <id>` (plus `--name`) so a timed-out or aborted job can be *resumed* in a fresh child instead of restarted from scratch: same ID, same cwd, next turn continues the conversation (see **Session persistence and resuming**).

## Supervised autonomous runs (guard.mjs)

For **one long autonomous job** (one task, many turns, runs unattended), use `scripts/guard.mjs` instead of one giant `--turn`. It runs the child and supervises it against the failure modes that kill long jobs:

- **Tool-call loops.** The ACP context layer (the `billion-context-pi` package) runs a `repetitionGuard` (issue #308; `acp.json` key `repetitionGuard`; defaults warn=3, abort=5, counter **per session**) that refuses the 5th consecutive byte-identical tool call and **aborts the turn**. The supervisor detects the loop itself — consecutive identical tool+args in `tool_execution_start` events — and escalates:
  1. **L1 steer** (default budget `--max-steers 3`): inject a corrective message via `steer()` — the programmatic "please continue, different approach".
  2. **L1.5 rewind** (default budget `--max-rewinds 1`, `0` = off): abort + fork before the task message + re-prompt the task with an anti-loop note (`--rewind-note` replaces it). The loop history is gone and the attempt restarts from a clean transcript — the first full reset, tried before spending a fork. (Mechanically a fork before the task, like L2; it occupies its own budget slot and fires only on tool loops — stalls and external aborts go straight to L2.)
  3. **L2 fork+retry** (default budget `--max-forks 2`): abort + `fork(before the task message)` + re-prompt with a "that approach is exhausted" note. A fork is a **new session file** — loop history discarded, and the guard's per-session counter starts clean.
  4. **L3 give up**: `RESULT status=stuck`, exit 3.
- **Stalls** (no events at all): `--idle-timeout` (default 300 s while the model thinks) or `--tool-timeout` (default 1800 s while one tool call is running — long builds are normal) → straight to L2; a steer cannot reach a hung LLM call.
- **External aborts** (the guard firing at 5, or any host-side abort of the turn) are treated as recoverable: straight to L2 while fork budget remains.
- **Degenerate settles** (v0.4.0) — the model can end a turn *without acting*: thinking-only (no text, no tool call), empty text, or a settle right after an external abort with nothing produced in between. Before v0.4.0 these were reported as `completed` — a 3.8-hour run that spent its whole budget hunting a now-unrecoverable transcript secret, and a run whose task was a 27-char CLI artifact, both "completed" this way. Now the supervisor inspects every settle: a degenerate settle is handled like an external abort (corrective prompt on L1 budget → L2 fork → consult-park or `exitReason=degenerate-settle`, exit 3). A settle right after an external abort is degenerate only if the model produced nothing at all in between (a short, deliberate stop that follows an abort is a normal stop).
- **Missing completion artifacts** (`--expect-file <path>`, repeatable, v0.4.0): the supervisor has no notion of "done" beyond "the model stopped talking". On any settle, a missing expected file is handled exactly like a degenerate settle (`exitReason=missing-expected-file`) — the supervisor does not declare success while a required artifact is absent.
- **Consult mode** (`--consult`) — intelligent steering by the parent session: instead of firing L1/L2 with built-in messages, the supervisor **pauses at the intervention point**. It persists the session, writes `pi-child-consult.json` (trigger, loop stats, open + last 15 completed tool calls, last assistant text, budgets, session id/file) and exits **4** with `RESULT status=consult, consultFile=...`. The child is shut down orderly (in-flight turn aborted; completed side effects stay on disk). The parent then reads the payload and re-invokes:
  ```bash
  node scripts/guard.mjs --consult-file pi-child-consult.json --action steer|fork|rewind|continue --message "your steering instruction"
  ```
  `steer` = send your message into the same session, in place. `fork` = branch before the task message and re-prompt task + your message (new session file, fresh guard counter — like L2, but with your note). `rewind` = the same operation as `fork` (branch before the task, re-prompt task + your message) but consumes the L1.5 rewind budget instead of the fork budget — choose it when the run was parked on a loop. `continue` = resume with the built-in ladder for the rest of the run. Budgets, attempt count and the hard wall clock carry across resumes (they come from the consult file, not flags). The consult file is **overwritten at each intervention** — always resume the latest one. While the child is parked, it is not running: no CPU/model cost, but also no progress.
- **Extended sensors**. The built-in detectors cover *known* failure shapes; these widen the net. `error-loop`, `text-loop` and `stagnation` run in **both** modes: in consult mode a hit parks the run for the parent, in autonomous mode they run the normal ladder (steer once, then fork per budget). `heartbeat` is consult-only (parking for a parent review is meaningless unattended):
  - `error-loop` — `--max-errors <n>` (default **6**, 0 disables): N consecutive *failing* tool calls of any kind. Catches thrashing the identical-loop detector misses (different calls, all failing).
  - `heartbeat` — `--heartbeat <n>` (default 0 = off): after every N completed tool calls, the supervisor parks and hands you the trace for a progress review. The payload carries the recent tool calls (args, truncated results, errors, durations) plus the child's last text, so you can judge drift, wasted work, or anything a fixed detector cannot name. Each heartbeat = one parent turn + child restart (it re-reads its transcript), so keep N large.
  - `text-loop` — `--max-text <n>` (default **20000** chars, 0 disables): an assistant message longer than N characters *without a tool call*. This is the "thinking loop" — the model keeps appending words to the same message. It is invisible to every other sensor: the child emits text deltas continuously, so the stall detector sees a healthy, busy child, and there are no tool calls for the loop/error/heartbeat detectors to key on. Without this sensor, only the hard wall clock stops the run — and that is terminal (`stuck`, exit 3). In consult mode the payload's `lastAssistantText` shows you the ramble (steer or fork); in autonomous mode the ladder steers the child back on task, then forks per budget.
  - `stagnation` — `--stagnation <n>` (default **0 = off**): N consecutive tool calls that returned **no usable content** — empty output, `killed`, `timed out`, HTTP 4xx/5xx, permission denied. These calls *succeed* (exit 0), so `error-loop` never sees them; this is the shape probe-heavy tasks die in (a 2026-10-16 run made 124 calls, most returning "killed at 270 s" or HTTP 400, and no failure sensor ever fired). Marked calls carry `noContent: true` in `recentToolCalls`.
- **Workspace invariants** (`--invariant <cmd>`, repeatable; v0.17.0): every sensor above watches *model behavior* — a child can corrupt its own world (detached HEAD, a red self-test, conflict markers, stray processes) and still "complete" cleanly. An invariant is a shell command that must ALWAYS exit 0, re-checked every `--invariant-interval <sec>` seconds (default **60**; 30 s per-command timeout). A failure is a sensor hit whose evidence is the command's own output (last 800 chars): autonomous mode runs the normal ladder (steer with the evidence → fork per budget → `exitReason=stuck-invariant`, exit 3); consult mode parks (trigger `invariant`). Each check logs an `[invariant]` line to the progress log (exit code + command), so a post-mortem can diff the world state against the timeline. Use for `./selftest` (exit 0), `git status --porcelain` (empty), "no conflict markers", "no stray processes". Note: invariants run in the guard's cwd (the project), and a check that reads a file the child is mid-write on can see transient state — the ladder (steer first) makes that self-healing.
- **Parent nudge channel** (v0.17.0): before v0.17.0 the parent's levers on a LIVE autonomous run were wait, kill, or park-via-consult — the parent could verify (pixel diffs, log reads) but not write back. Now: drop a `.txt` file into `<out-dir>/.steer-inbox/` (or `monitor.mjs --status <status> --steer "message"` does it atomically) and the guard delivers it to the live child — a prompt when the child is idle, a steer when it is mid-turn — then moves it to `.steer-inbox/processed/` (the audit trail). Each delivery logs `[steer-inbox] file=… disposition=…` to the progress log and increments the manifest's `parentSteers` count. Parent steers do NOT count against the guard's own `--max-steers` ladder budget — they are parent judgment, not an automatic intervention, so there is no cap (each file = one message). Delivery is best-effort for live runs: a file dropped after the run settled is not delivered.
- **Empty-final settle** (v0.17.0): an EMPTY final message (no text, no thinking) after a non-trivial attempt (≥1 tool call or streamed text) is now a first-class settle condition with the full ladder (corrective steer → fork per budget → `exitReason=empty-final`, exit 3). Before v0.17.0 the same signal was inconsistent across runs: runs whose attempt counters looked healthy "completed" with `finalText: ""`, while the identical settle with a thinking tail tripped `degenerate-settle` by accident. A manifest with `finalText: ""` + 0-byte `pi-child-final.txt` is therefore legitimate either way — judge completion by commits/artifacts, and treat a bare `completed` with empty final text as "verify it, don't trust it".
- **Standard task contract** (`--preamble standard`, v0.17.0): the standing rules every long task needs, bundled as `templates/standard-contract.md` and available as the magic value `--preamble standard` (any other `--preamble <t>` value is used verbatim). The contract: (a) the hard deadline is the ONLY stop condition — phase lists are pacing guides; (b) commit each verified sub-step, re-baseline after ~30 min without a commit; (c) **after every screenshot, READ it and state what is visible** — capable models have vision but never use it spontaneously; (d) never end on an empty message (ties into empty-final settle); (e) safe git recovery (back up conflicted files first; prefer `git stash push` — safety nets block `checkout <path>`/`reset --hard`); (f) evidence conventions (`evidence-<n>-<desc>.<ext>`, small files, referenced by name). Edit the template per project, or pass your own text.
- **Deadline awareness and finalization** (v0.10.0): the child is told the hard deadline in the initial prompt (`[supervisor] HARD DEADLINE: ...`), a `BUDGET WARNING` is sent at 90% of the budget ("do not start new work items; write your final report now"), and the wall-clock expiry does NOT kill the run while `--finalize <min>` is enabled (default **10**, `0` = the old immediate kill): the supervisor enters a **finalization window** — one prompt ("STOP all new work, write the final report NOW"), up to N minutes waiting for a settle with the ladder suppressed. A settle with a report → `exitReason=completed-finalized` (status `completed`, exit 0); nothing usable → `hard-timeout` (exit 3). This turns a hard timeout from "no artifact" into "partial report" — a 4-hour run killed mid-probe was recovered in ~5 minutes instead of ~1 hour of forensics.
- **Parent-authored ladder messages** (no consult needed): `--steer-msg "<text>"`, `--rewind-note "<text>"` and `--fork-note "<text>"` fully replace the built-in L1/L1.5/L2 messages (variables `{tool}`, `{count}` for L1; `{reason}` for L1.5/L2). Use for task-specific guidance — the parent wrote the task, so it knows which failure modes to warn about (e.g. "the registry is blocked; use the local cache").
- **Progress log, always on** (v0.4.0): `pi-child-progress.log` in the working directory (or `--out-dir`) is written in every mode — one line per completed tool call, plus `[start]`/`[settled]`/`[result]` summary lines. Since v0.6.0 each settle also logs a `[settle]` line with the attempt's tool-call count, streamed text size, and the **last 200 chars of the child's own text** — the one-line answer to "what does the child think is happening?" for a 20–30-minute monitor. It is the cheap status surface for a parent that wants to peek without parsing a 20 MB session jsonl (see **Monitoring a long run**).
- **Live status file, always on** (v0.11.0; **v:2 schema in v0.13.0**): `pi-child-status.json` in the working directory (or `--out-dir`). Since v0.13.0 it is written **before the child spawns** (`status:"starting"`), **heartbeats `at` every 30 s while running** (stays fresh even mid long model-think), and carries **`guardPid`/`childPid`** — nulled in a final write on ANY exit (an `exit` hook, plus best-effort SIGTERM/SIGINT `killed-…` marking; Windows console tree-kills deliver no signal, so the file simply stays stale and the monitor's PID check catches it). Full payload: `{v: 2, status (starting|running|completed|stuck|consult|error), exitReason, guardPid, childPid, attempt, toolCalls, lastTool, lastToolStartedAt, elapsedMs, sessionId, sessionFile, sessionBytes (v0.6.0 — transcript size, so context growth is visible without reading the jsonl), expectedFiles}`, rewritten on every completed tool call and every state transition (start/steer/fork/consult/result/error). The machine-readable half of the progress log — a monitoring loop is one read + JSON.parse, and the `expectedFiles` map answers "is the artifact there yet?" without an `ls`. **Liveness rule:** the file can only assert what the guard itself wrote — a killed guard leaves a stale `"running"`, so a monitor must check the `guardPid` process, never the file alone (`monitor.mjs` does this automatically).
- **Monitor, bundled** (v0.13.0; v0.14.0: watches the result manifest, dropped the expected-files early return): `scripts/monitor.mjs` is the wait side of a detached launch — one blocking call per cycle that returns **early on any event** (below). It exists because the ad-hoc launch/monitor layer was the entire failure surface of the 2026-10-24/25 VMWare campaign (tree-killed launch → stale `running` → ~24 min blind; a hand-typed poll loop that lost its JSON quoting → three consecutive late detections of completed runs).
- **All artifacts in one place: `--out-dir` (v0.6.0).** Every `pi-child-*` file (progress log, status file, result manifest, consult file, brief/relaunch files) goes to `--out-dir` (default: the cwd). Point it at a temp/supervisor dir to keep the project tree clean — you then clean ONE directory after the run instead of hunting `pi-child-*` files in the project root (where, pre-v0.6.0, the child also could not delete them while the supervisor was running).
- **Context-overflow pivot (v0.6.0).** A resumed transcript near the model's context window stalls on the *first prompt with zero tool calls* — and forking it would stall identically (a fork copies the same transcript). The guard classifies that signature (`--session` resume + first attempt + zero tool calls + session file ≥ `--overflow-threshold-mb`, default 3 MB; the launch preflight warns at the same threshold, and the resume-mode idle watchdog is lowered 300 s → 120 s). On a matching stall it does NOT fork: it writes `pi-child-brief.md` (a distilled fresh-session brief — original task verbatim, required artifacts, remaining budget, the tail of the last assistant text) + `pi-child-relaunch.json` (the **exact relaunch command line**: fresh session, remaining wall clock, inherited provider/model/expect-files) and exits 3 with `exitReason: "stuck-overflow"` (both paths in the manifest). `--pivot-relaunch` instead spawns that relay itself and exits with the relay's code (the relay's manifest carries `relayedFrom`). See **Long multi-run jobs: distill, don't resume** below.
- **Task from a file** (`--task-file <path>`, v0.11.0): long tasks belong in a file — no shell quoting, no truncation. The whole file (BOM/whitespace-trimmed) becomes the task; mutually exclusive with a positional/`--task` task. A task that happens to be an existing file path (the classic "I passed the path, not the text" bug — it cost a 2026-10-17 run a wasted discovery step) now gets an explicit `did you mean --task-file?` warning.
- **Strict CLI** (v0.4.0): an unknown `--flag` is an error (exit 2). Unknown flags used to be joined into the task text — a typo'd flag became the child's *entire* task. At startup the supervisor echoes the resolved task (`[supervisor] task: N chars — "..."`) and warns when it is suspiciously short (< 100 chars). `rpc-child.mjs` rejects unknown flags the same way.

```bash
node <skill_dir>/scripts/launch.mjs --task-file task.md --out-dir <run-dir> --timeout 120 --expect-file report.md
# Deadline-aware (v0.15.0) — replace --timeout so the finalization window ends AT a wall clock:
node <skill_dir>/scripts/launch.mjs --task-file task.md --out-dir <run-dir> --deadline "2026-10-28 10:00" --expect-file report.md
# → {"launched":true,"guardPid":…,"deadline":{…},"status":{…}} (verified) — or
# → {"launched":"unknown",…} (alive but silent after verify+grace: check it yourself,
#   do NOT relaunch into the same --out-dir) — or non-zero exit {"launched":false,…}
#   only for a DEAD process (launch.out/err tails inlined)
```

**Launch detached — never in the foreground of a finite-timeout call.** The bundled `launch.mjs` (v0.13.0) does the right thing: spawns guard.mjs detached (survives any timeout the caller's shell call has; hidden console on Windows), writes the guard's stdout/stderr to `<out-dir>/launch.out`/`launch.err`, creates `--out-dir`, and **verifies the launch in two stages** (v0.14.0): stage 1 (`--verify-sec`, default 8 s) waits for the status file — the guard writes `starting` before it spawns its child, so on a warm host this is a second or two; if the file is still missing but the guard **process** is alive, stage 2 (`--grace-sec`, default 60 s) extends the wait, because node cold start / AV scanning of a detached hidden process measured ~14 s on a Windows dev host (2026-10-26). Only a **dead** process is a failure (`{"launched":false,…}` + inlined launch.out/err tails, non-zero exit); an alive-but-silent process is `{"launched":"unknown"…}` (exit 0) — check the process yourself and NEVER relaunch into the same `--out-dir` (the guard also refuses a second live launch there — below). A foreground `node guard.mjs …` inside a finite-timeout bash call MUST be avoided — the timeout kills the whole process tree at expiry (observed in the 2026-10-25 VMWare campaign: a healthy run tree-killed at 150 s; the frozen `running` status then cost ~24 minutes of blind monitoring). Fallback without launch.mjs: `mkdir -p <out-dir> && nohup node <skill_dir>/scripts/guard.mjs … > <out-dir>/launch.out 2> <out-dir>/launch.err &` + capture `$!` immediately. Under git-bash use forward-slash paths only — backslashes get mangled before node ever sees them.

- **Deadline-aware launch (`--deadline <wall-clock>`, v0.15.0; epoch + aliases in v0.17.0)**: pass a wall-clock deadline instead of a `--timeout` and the launcher sizes the budget so the run's finalization window ends AT the deadline — total real time = `--timeout` + `--finalize` (default 10), so it reserves the finalize minutes and computes `--timeout = floor((deadline − now)/min) − finalize`. Accepts ISO (`2026-10-28T10:00Z`), a local wall clock (`"2026-10-28 10:00"`, `"10:00"` = today, host timezone), or — v0.17.0 — an **epoch number: 10 digits = seconds, 13 = milliseconds** (the interpretation is echoed in the `deadline` block's `deadlineLocal` as `[epoch <n>]`). v0.17.0 also maps the two most common flag typos with a stderr warning instead of a hard failure: `--state-dir` → `--out-dir`, `--tag` → `--name`. (Before v0.17.0 an epoch was rejected and the launcher silently fell back to the 240-min default — the fallback, not the parse error, was the trap.) It **replaces** any `--timeout` (mutually exclusive) and is **never forwarded to the guard** (a strict-CLI guard would exit 2 on the unknown flag). On success the JSON gains a `deadline` block: `{deadline, deadlineLocal, timeoutMin, finalizeMin, hardStopAt, hardStopAtLocal, finalizeAt, finalizeAtLocal}` — the projected hard-stop and finalize times. It refuses (exit 1) when the deadline is unparseable or leaves < 1 work-minute after the finalize window. This is the "one deadline across many back-to-back runs" case: each fresh run re-invokes `--deadline` with the same wall clock and the launcher re-computes the shrinking budget.
- **Mid-turn-safe delivery (v0.17.0, found in E2E)**: pi's RPC rejects `prompt()` while the agent is processing ("Agent is already processing. Specify streamingBehavior..." — an E2E run died on exactly this when a steer-inbox nudge was `prompt()`ed into a mid-generation child). Guard delivery now tracks real turn state (`turnActive`: set at every prompt site, cleared at `agent_settled`) instead of the old `toolDepth > 0` heuristic — steer-inbox, budget warnings, finalization, and sensor steers all use `deliverToChild` (steer mid-turn, prompt between turns), and a failed steer-inbox delivery now logs + archives the file instead of killing the run. This also fixes the latent v0.10.0 finalization path, whose `prompt()` at wall-clock time (the child is almost always mid-turn) could never have reached the child and was silently swallowed by its own try/catch.
- **Persists the session by default** (auto `--session-id sup-<timestamp>`, `--name` = the ID) so runs stay resumable. Every rewind/L2 fork creates a NEW session file — the RESULT line reports the **final** session (`sessionId`/`sessionFile`); resume THAT file with `rpc-child.mjs --session <file>` to continue or debug. `--no-session` for throwaway.
- RESULT JSON: `{status: "completed"|"stuck"|"consult", exitReason: completed|completed-finalized|hard-timeout|stuck-loop|stuck-idle|stuck-overflow|aborted-external|degenerate-settle|empty-final (v0.17.0)|missing-expected-file|stuck-stagnation|stuck-invariant (v0.17.0)|consult-loop|consult-stall|consult-external-abort|consult-error-loop|consult-heartbeat|consult-text-loop|consult-stagnation|consult-invariant|consult-empty-final, task (≤200 chars) + taskChars, attempts, interventions: {steers, forks, rewinds, loopsSeen}, parentSteers (v0.17.0 — parent nudge files delivered; NOT part of the interventions budget), sessionId, sessionFile, finalText (≤4000 chars) + finalTextTruncated + finalTextFile (v0.14.0 — `pi-child-final.txt` in the out dir, the FULL final text), settle: {attemptTextChars, attemptToolCalls, lastMessageTextChars, errorStreakAtEnd}, expectedFiles (when given), progressLog, elapsedMs, recentToolCalls (last 15: {tool, args, isError, result≤300, durationMs, noContent?}), deadline (ISO), finalized (when the timeout was absorbed by the finalization window), briefFile/relaunchFile/relaunched (stuck-overflow only), relayedFrom (relay runs), manifest (path), consultFile/trigger/allowedActions (status=consult only)}`. The same summary is also written as a `[result]` line in the progress log, and the same payload + `cwd/provider/model/startedAt/finishedAt` is **always written to `pi-child-result.json` in the working directory** (the `manifest` field) — a stable small file the parent reads instead of digging the RESULT line out of a multi-hundred-KB log. Exit codes: 0 completed (incl. `completed-finalized`), 3 stuck, **4 consult** (waiting on the parent's resume), 1 error, 2 usage (including an unknown `--flag`).
- Tuning: `--loop-threshold` (default **4** — one below the guard's default abort=5 so the steer lands first), `--max-steers`, `--max-rewinds` (L1.5 budget, default **1**, `0` = off), `--max-forks`, `--idle-timeout`, `--tool-timeout`, `--timeout <min>` (hard wall clock, default 240; `0` = no wall clock / unlimited), `--finalize <min>` (finalization window at the wall clock, default 10, 0=off), `--expect-file <path>` (repeatable), `--out-dir <dir>` (all `pi-child-*` artifacts; default cwd), `--overflow-threshold-mb <n>` (resume-session size that turns a first-prompt stall into an overflow pivot; default 3), `--pivot-relaunch` (auto-relay on overflow), `--keep-delegate-tool`, sensors (`--max-errors`, `--heartbeat`, `--max-text`, `--stagnation`), steering (`--consult`, `--consult-file`, `--action`, `--message`, `--steer-msg`, `--rewind-note`, `--fork-note`), plus all harness session/model flags (`--provider`, `--model`, `--session-id`, `--session`, `--session-dir`, `--name`).
- If you run with a custom `repetitionGuard` config, set `--loop-threshold` one below its `abort` value so L1 always wins the race.

### Task authoring (what a good long task contains)

Start from `task-template.md` in this skill directory — a fill-in-the-blanks contract that encodes the rules below.

A long autonomous task is a *contract*, not a suggestion. Every failure in this skill's history traced back to a missing piece of the contract:

1. **Goal + explicit completion criteria.** Name the files the task must produce, and pass them as `--expect-file` so a "settled" turn is not accepted while they are missing.
2. **Anti-loop rules.** "Max 3 attempts per approach; no cosmetic re-runs of a failing command (re-running it with `| head -N` or a reworded variant counts as the same attempt); if an approach is exhausted, log it and move to the next." This keeps the model just inside the repetitionGuard's threshold — a 6h48m run with zero interventions used exactly this preamble.
3. **Durability rule — the transcript is NOT storage.** ACP compression can physically delete old transcript messages (rebase), so anything that must survive (credentials, artifacts, intermediate findings) has to be written to disk *immediately*: "write the credentials to `data/creds.txt` FIRST, before continuing". A VK password that existed only in the transcript was unrecoverable after a rebase, and a 3.8-hour run was lost re-hunting it. Keep a `STATUS.md` (or notes file) updated at milestones — it is what makes a resumed or forked run start with context instead of amnesia.
4. **Boundaries.** "Do not use `acp_delegate`" (excluded by default anyway), "no new dependencies", and the paths of everything the child needs — it has zero context from your conversation.
5. **No silent stops.** "End with a written status update (what is done, what is blocked and why, what remains) — never stop with only internal thinking." Degenerate settles are now caught by the supervisor, but the contract makes the child avoid them in the first place.
6. **Budget awareness.** The supervisor injects the hard deadline into the initial prompt and sends a BUDGET WARNING at 90% of the budget (v0.10.0), but state *per-item* timeboxes in the task ("each candidate: max ~15 min including retries") — the deadline is global; per-item pacing is yours to give.
7. **Incremental artifacts.** Make the child append a one-line result to a results file *immediately after each sub-item* (in addition to the final report, passed as `--expect-file`). A partial results file survives a timeout or crash; a report-only-at-end does not. Consequence: an `--expect-file` that the child maintains throughout the run is a **living report, not a completion marker** — never key any "is it done?" check on its mere existence (the v0.13.0 monitor did, and returned "done" on the first cycle of every such run). The completion marker is the guard's `pi-child-result.json` manifest, which exists only after a settle.
8. **Environment invariants — state them when they apply.** These are properties of the *host environment*, not the project, but the child cannot discover them until it pays for them (a whole session was lost to #1): if the host's bash tool kills commands after a fixed wall time (common: 60 s), say: "every command must finish in <N s; pass explicit tool timeouts for builds and long work — never let a command be killed." If the host runs a safety net that blocks interpreter one-liners (`node -e`, `python -c`), `rm -rf`, dynamic executable names, or `$_` expansion inside inline PowerShell, say so and require script files run with literal paths. A 2026-10-19 parent-verification step was blocked on a dynamic `$VAR/exe` invocation until rewritten with a literal path.

### Monitoring a long run (parent side)

- **Verify the launch, before walking away — process FIRST, then file.** `launch.mjs` does all three checks and prints the result. Slow hosts (cold node / AV scan of a detached hidden process): the status file can lag ~14 s+ — `launch.mjs` covers that with the stage-2 grace and reports `launched:"unknown"` rather than a false failure when the process is alive but silent. Treat `unknown` as "go check the process", never as "relaunch". With a manual launch: (1) the guard process is actually alive (`tasklist /FI "PID eq <pid>"` / `kill -0 <pid>`) — checked *in addition to*, never *instead of*, the file; (2) `head <out-dir>/launch.out` shows the `[supervisor] task: N chars — "..."` echo — the task the child *actually received* (a typo'd `--flag` (now exit 2) or a truncated task used to become the child's entire task, and the run would "complete" doing nothing in 6 minutes); (3) `pi-child-status.json` says `starting`/`running` — not `error`, not the previous run's leftover. The process check is load-bearing: a status file can never prove liveness, only the process can.
- **One blocking wait, not polling — with MANDATORY early return.** The wait is one `monitor.mjs` call per cycle:

  ```bash
  node <skill_dir>/scripts/monitor.mjs --status <out-dir>/pi-child-status.json --cycle-min 20 --tag cycle-N
  ```

  It polls every 30 s and returns the moment anything happens — `reason=settle` (terminal status: completed/stuck/consult/error), `reason=settled-manifest` (v0.14.0 — the result manifest `pi-child-result.json` appeared while the status still said running; the manifest is the definitive completion marker; a stale manifest from an earlier run in the same dir is excluded by freshness), `reason=liveness` (status says running but the guard process is gone — the killed-run signature; v:1 files without PIDs fall back to `at` freshness) — otherwise it returns at the cap, `reason=cap` (default 20 min). There is **no** `reason=expected` anymore (removed in v0.14.0): the task authoring rules above tell the child to keep the report updated *as it goes*, so the expected file exists from early on — "all expected files present" was never a completion signal, and the pre-v0.14.0 monitor returned `expected` on the very first cycle of such a run (the toposort campaign, 2026-10-26). The guard still enforces expected files **at settle** (missing file → intervention ladder); the monitor only waits. The one JSON line it prints (status, exitReason, attempt, sessionId, toolCalls, expectedFiles, progress tail) is your only follow-up input. **A wait that cannot return before the cap is a stall, not a wait.** Aborting the call is always safe and cheap — the run is detached and keeps going, and re-invocation is idempotent. Do NOT hand-type the poll loop (a hand-typed loop that lost its JSON quoting silently ran every full 20-minute cycle — three consecutive late detections in the 2026-10-25 VMWare campaign), and do NOT use `goal_wait` or any goal-system wait for run supervision (long blocking call, no early return). The blocking shape (instead of many short polls) is deliberate on `parallel=1` model servers — every host turn taxes the child; the early-return contract is what makes the blocking wait safe. Mid-run status comes from the monitor's JSON, never from re-running anything. v0.17.0 adds the reverse direction — the parent nudge channel: `monitor.mjs --status <status> --steer "message"` writes the message into the run's steer inbox and the live guard delivers it to the child (a prompt when idle, a steer mid-turn); a dead run exits 1 and writes nothing.
- **Host silence during runs (local models).** A `parallel=1` model server serializes host and child requests, and every context switch pays a prefill — host turns measurably slow the child (and vice versa). SOP: only long blocking waits (15–20 min) while a child runs; do all host-side analysis after it exits.
- **Do NOT pre-warm the child model before launch (local `parallel=1` backends).** The tempting move — "send a small completion to the router with the child's model so it's loaded by the time the child's first prompt hits" — is counterproductive at `parallel=1`: between the warmup and the child's first prompt the parent's own completions are unavoidable (processing the warmup's tool result, writing the task file, the launch call itself), and the single slot means each of them EVICTS the warmed child model. Observed sequence: child (warmup) → parent (next turn, loads parent model) → child (first prompt, reloads child model) = 3 loads where the no-warmup path costs exactly 1 (the child's first prompt — unavoidable cold load, accepted). The minimal-load launch on `parallel=1` is: no warmup → synchronous launch (parent blocked in the bash call) → child's first prompt loads the child model (1) → the parent's next turn lazily loads the parent model (1 — unavoidable; an eager post-run "restore" of the parent model saves no load, it only relocates it, which is why a v0.6.4 guard restore feature was added then reverted as unnecessary). Pre-warming only pays off on `parallel>1` servers, where the warmed child model can coexist with the parent's; it is a no-op-or-harm elsewhere.
- **The progress log is the status surface.** `pi-child-progress.log` (path in the `[start]` line and in RESULT's `progressLog`): one line per completed tool call plus `[settled]`/`[result]` summary lines. A peek is a `tail` on a small file — no 20 MB session-jsonl parsing, no custom scripts.
- **The result manifest is the exit surface.** `pi-child-result.json` in the working directory (always written, every outcome including consult/stuck): the full RESULT payload + run metadata. At the end of a run, read this one small file, not the log.
- **Multi-hour runs: `--consult --heartbeat <N>` for structured monitoring.** Instead of ad-hoc log tailing, the supervisor parks every N completed tool calls and hands you the recent trace (the payload includes the last tool calls with args/results + the child's last text). Each heartbeat = one parent turn + child restart (it re-reads its transcript), so keep N large (≥30; much larger on slow local models).
- **Polls must be non-identical.** The ACP host's own `repetitionGuard` (warn=3/abort=5, per session, byte-identical calls) counts *your* monitoring calls too — an unchanging `tail -n 20 file` poll will trip it. Vary the call each time (a changing offset, a `--since <last-line>` argument, or append the poll timestamp to the command). `monitor.mjs` takes `--tag <s>` for exactly this — pass a per-cycle value (`cycle-1`, `cycle-2`…) and the invocation is never byte-identical. v0.17.0: an omitted `--tag` is now auto-generated (`auto-<timestamp>-<pid>`), so the untagged form can no longer trip the guard either; and the JSON now carries the deadline countdown when the guard wrote a `deadlineIso` into the status (`deadline: {iso, remainingMin}`), so a 20-min cycle is self-contained without re-reading the status file.
- **The session file rotates after an L2 fork.** Anything keyed to one session-file path goes blind after a fork. Follow `sessionId`/`sessionFile` in the RESULT (or the consult file), or just watch the progress log — it is cwd-relative and stable.
- **Windows gotchas** (this skill was developed under them): the console codepage is cp1251 — any script that prints Cyrillic must set `PYTHONIOENCODING=utf-8` and reconfigure stdout with `errors="replace"`, or it crashes on the first non-Latin character. MSYS bash expands `$_`/`$()` inside double-quoted `powershell -Command "..."` — write a `.ps1`/`.py` file and run it with `-File`/`python <file>` instead. Host safety rules may block inline one-liners for the same reason.
- **One out-dir per live run — the guard enforces it now (v0.14.0).** A second guard pointed at a live run's `--out-dir` (a diagnostic probe, or a relaunch after a misread slow startup) used to silently truncate the live run's progress log and clobber its status file. Now the guard **refuses to start** when the status file names a live `guardPid` (exit 2, clear message; `--force` overrides). Never run a probe/diagnostic guard against a live run's out-dir — use a fresh throwaway `--out-dir` (e.g. under the temp dir) with `--no-session`. A stale owner (dead pid, or a healthy finished run — the exit hook nulls the pids) is overwritable without `--force`; `--force` against a live owner APPENDS to its progress log (with a run-id `[start]` line) instead of resetting it.
- **After a hard-timeout or stuck exit**, capture "what remains" from the child's STATUS.md *before* relaunching: the resume (same session file, fresh supervisor run) then starts with a precise remainder list instead of re-deriving state. With `--finalize` (v0.10.0) the child usually wrote its own partial report first — check `pi-child-result.json` → `finalText` / the expect-file before doing anything else.

### Stopping a run (`stop.mjs`, v0.15.0)

Hand-rolling `kill -TERM <child>; kill -TERM <guard>` is error-prone (order, which pid, confirming both died). `stop.mjs` does it in one call — read the status file, signal the **whole process group** (the guard is the group leader; the child it spawns inherits the group, so one group signal takes down guard + child, not just the leader), wait a grace window, escalate to SIGKILL, then re-read and report:

```bash
node <skill_dir>/scripts/stop.mjs --out-dir <run-dir>            # graceful SIGTERM → escalate SIGKILL
node <skill_dir>/scripts/stop.mjs --out-dir <run-dir> --force   # straight to SIGKILL (a wedged guard)
# → {"stopped":true,"stoppedVia":"SIGTERM-group","confirmedDead":{"guard":true},"finalStatusStatus":"error",…}
```

Graceful is the right default: the guard's own SIGTERM handler marks the status file `error`/`killed-SIGTERM` before it exits, so a graceful stop leaves an accurate final status — only a SIGKILL'd group leaves the file stale-`running`. One JSON line on stdout: `{stopped, stoppedVia, guardPid, childPid, confirmedDead:{guard,child}, finalStatus, manifestPath}`. **Exit codes: 0 = stopped (or already stopped); 1 = could not confirm death, or nothing was found (a missing status file is exit 1 + "verify" — it may be a typo'd `--out-dir`, never mistaken for a stop); 2 = hard error (bad args, corrupt status file).** Use it whenever a human says "stop the child", a campaign deadline is forced, or you need to tear a run down before relaunching; then audit the final `pi-child-result.json` (if it settled) and the expect-files before the next run.

## Multi-run campaigns (`campaign.mjs`, v0.16.0)

A **campaign** is a durable, named, goal-anchored multi-run thing — a goal, a deadline, per-run history, a **verified-facts ledger**, final **acceptance criteria**, and a **next-brief slot**. It is the generalization of the hand-rolled BlockGame pattern (goal "finish the game by <deadline>", N supervised runs, a compounding verified-facts list): previously that loop lived in the parent LLM and had to be reconstructed after every context overflow or reboot; now the mechanics are scripted. The script owns the MECHANICS (locating artifacts, liveness, deadline math, bookkeeping); the LLM owns the JUDGMENT (what to do next — via the next slot, `--brief-file`, or `--goal`). State lives in `<project>/.pi-supervisor/<name>.json` (git-ignored — see gotchas). Runs are still ephemeral `--out-dir`s under /tmp; the campaign file only *references* them, so a reboot losing /tmp costs the artifacts, not the history. Every subcommand prints **one JSON line on stdout** + a summary on stderr (`--quiet` suppresses it). **Exit codes — 0 success · 1 operational refusal/failure · 2 usage error.** **Decision rule (v0.17.0) — the loop the script deliberately does NOT own:** (1) read the latest run's result JSON + manifest and diff its verified facts against the campaign's acceptance criteria; (2) if every criterion has passing, dated, artifact-backed evidence → `campaign finish`; (3) otherwise write the next brief — goal, verified-so-far, open gaps, ONE focused task (and `--preamble standard` when a long supervised run is expected) — then `campaign next`. The script owns mechanics; that judgment stays with the LLM (see v0.17.0 Notes).

```bash
# 1) create — the goal + deadline are what make it a campaign, not just a run
node <skill_dir>/scripts/campaign.mjs init --name <n> --goal "<objective>" --deadline "<ISO or local wall clock>" [--run-timeout-min 40]

# 2) fresh-monitor re-entry — read-only, NO writes; do this FIRST in any new session
node <skill_dir>/scripts/campaign.mjs status

# 3) assemble run N+1's brief (NO launch) → .pi-supervisor/brief-run<N+1>.md —
#    campaign goal + this run's goal (next slot) + verified facts + last run's manifest final-text tail
#    + STATUS.md tail + deadline math. Edit it (parent judgment), then launch:
node <skill_dir>/scripts/campaign.mjs scaffold
node <skill_dir>/scripts/campaign.mjs next --brief-file .pi-supervisor/brief-run<N+1>.md
#    …or launch directly (the assembled brief is still written to brief-run<N+1>.md for inspection):
node <skill_dir>/scripts/campaign.mjs next --goal "…" --accept "c1,c2"

# 4) when the run settles:
node <skill_dir>/scripts/campaign.mjs record "<verified finding>" --run N --verified-by manifest
node <skill_dir>/scripts/campaign.mjs stop [--grace-sec N]      # delegates to stop.mjs for the latest run
node <skill_dir>/scripts/campaign.mjs done [--confirm "<criterion>"]   # final acceptance gate
```

- **`status`** — the whole re-entry point: the latest run (pid-checked liveness, not just the status file), its manifest tail (final text ≤2000 chars), the verified-facts ledger, the next-brief slot, and minutes-to-deadline. No writes.
- **`next`** — builds the brief (or reads `--brief-file`), sizes the deadline, **spawns via `launch.mjs`** (detached — the run survives the monitor dying), records the run in the state file. Per-run deadline = **min(campaign deadline, `--deadline` override, now + `runTimeoutMin`)** — the same math as `launch.mjs --deadline` (shared `lib/deadline.mjs`). **Refusals** (each overridable with `--force`): nothing to launch (no brief, no slot), the campaign deadline has already passed, or the latest run is still LIVE.
- **`record`** — appends a fact to the verified-facts ledger, which the next brief injects as "do not re-derive" — the compounding asset between runs (see *distill, don't resume* below). `--verified-by parent|manifest|probe` says who checked it.
- **`stop`** — thin wrapper over `stop.mjs` for the latest run; the run's final status is recorded in the campaign file.
- **`done`** — the machine acceptance gate. `acceptance[]` entries are `{criterion, check}`: `check` is a shell command run in the project dir (POSIX `sh -c` / Windows `cmd /c`), `check: null` = a parent-judgment criterion confirmed with `--confirm "<criterion>"`. All pass → `status: "completed"` + a `done.md` report. Refuses while a run is LIVE. A campaign's goal without machine-checkable acceptance is a scope, not a definition of done.

**The monitor loop** (what the supervising session does): `campaign status` → judge → *settled?* read manifest + STATUS.md, `record` verified facts, `scaffold` → edit → `next` · *live?* `monitor.mjs --expected-file …` → repeat. Each `next` re-computes the shrinking per-run budget from the same campaign deadline — the "one deadline across many back-to-back runs" case, with the bookkeeping kept out of the LLM.

## Long multi-run jobs: distill, don't resume (v0.6.0)

A job that needs more than one run has exactly one scarce resource: **the model's context window**. A resumed transcript grows with every run, and once it approaches the window, the resume dies in a very specific shape: the child emits **zero events on the first prompt** (the prefill cannot fit), stalls — and because a fork copies the same transcript, every fork stalls identically. Field case (2026-10-19, Box2D font bug): runs 2–3 appended to a 2.9 MB session and grew it to 7 MB; a fourth run (resume of that session) stalled three times in ~18 min with ACP reporting "EMERGENCY 99%"; a **fresh** session with a self-contained brief fixed and verified the bug in 58 min / 131 tool calls / 0 interventions — vs 600+ min across the appended runs with no result. Most of the delta is the clean context plus a "do not re-derive" list.

**The rule: never resume a transcript above ~50–60% of the model's context window.** Check the size before every resume (`ls -la` on the `.jsonl`). Past the line, do not resume — distill the state into a brief and start fresh.

The guard enforces this semi-automatically (see the overflow-pivot bullet above): preflight warning at launch, 120 s resume watchdog, the overflow classifier, `pi-child-brief.md` + `pi-child-relaunch.json` on a matching stall, and `--pivot-relaunch` for an unattended relay.

**The parent loop for a multi-run job:**

```
launch (fresh session + brief)  →  wait (20–30 min monitor cycles)
   → completed?  → parent acceptance audit (above) → done
   → not done?   → distill: child's report + STATUS.md + your audit findings
                   → update the brief (grow the "verified facts — do not re-derive"
                     list — it is the compounding asset between runs)
                   → launch a FRESH run (or run the relaunch command from
                     pi-child-result.json → relaunch after an overflow pivot)
```

**Brief anatomy (the template that won the 2026-10-19 run):** goal verbatim → **VERIFIED FACTS explicitly marked "do not re-derive"** → evidence locations on disk → prioritized plan (one change at a time) → invariants (Task authoring above) → deadline + partial-report rule → "old transcript exists at `<path>` — grep it, never load it".

**Budget expectations:** a fresh run converges far faster than a resumed one (field case: 58 min vs 600+ min). Give every run a real deadline (`--timeout`) — a run that hits it leaves a partial report (finalization window) and a brief, not a void.

**A concrete methodology built on this loop:** for a hard, long-running *bug* hunt — differential reproduction, stage-by-stage ground-truth diffing, broken-baseline + per-fix regression proofs, the verified-facts ledger — see the **bughunt** skill, which layers a phase-by-phase playbook on top of exactly this distill-don't-resume loop.

## Multi-hour run playbook (host side)

Field lessons from real long runs — including a 240-minute run on a ~0.5 tok/s local model that was killed mid-probe with no report and had to be reconstructed from logs afterwards.

**Preflight (host side, before launch — cheap checks the child cannot do for you):**
- Verify every external package/model/credential the task references *by name* (`npm view <pkg> version`, endpoint model list). A 2026-10-16 run lost 30+ minutes to discovering that 4 of 6 candidate package names were 404s on npm.
- Declare vision if the task needs it: the child inherits the host's agent config, so the child's provider/model entry in your `models.json` must declare `input: ["text","image"]` — pi's default declaration is text-only, which means the child CANNOT be fed images even when the server supports them, and nothing warns about it. Verify the effective `input` field before launch.
- Measure the model: there is no built-in latency probe in host mode — run a short timed completion yourself (e.g. a 16-token request against the endpoint) and note tok/s before launch. Then budget: Σ(per-item timebox) ≤ `--timeout`. A run where N items × T min > the hard timeout is mathematically doomed before launch — reduce N, raise `--timeout`, or split the run.
- Verify the child's toolchain deps (ffmpeg, venvs, writable temp dirs — see child-environment gotchas below).
- **Never pass host-side file facts to the task as ground truth.** The child shares your filesystem, but its shell environment is not identical to yours (PATH, codepage, temp dirs). Pass paths and let the child's "verify first" section produce the ground truth (2026-10-17: a host probe of a 4h video reported the wrong duration and content; the child's in-environment probe was right).

**Task contract (beyond the authoring rules above):**
- Incremental artifacts: one line per sub-item to a results file immediately (`--expect-file` for the final report).
- Give the child an *environment-failure policy*: "if a tool returns no usable content three times in a row, record the finding and move on" (the `--stagnation` sensor steers it there if it doesn't).

**Monitoring:** end of run → `pi-child-result.json` (manifest) + the expected artifacts; mid-run → ONE `monitor.mjs` blocking call per cycle (early-return on settle/settled-manifest/liveness; above) — it reads `pi-child-status.json` and the progress log for you; long runs → `--consult --heartbeat` (above).

**Compression hygiene (ACP hosts):** when compressing conversation around a run, record the *exact* artifact paths (project dir, log files, report file) in the summary, verbatim. A paraphrased path cost an hour of artifact hunting in the 2026-10-16 post-mortem.

**Child-environment gotchas (field-found):**
- Write the task with absolute paths — the child's shell cwd handling is not identical to yours.
- A `parallel=1` llama.cpp server *queues* a new request while a killed probe client's request is still generating — the next probe "hangs" for the rest of the queued generation. Drain/wait before the next probe.

**Parent acceptance audit (always run it — the manifest proves the model *stopped*, not that the job is done).** Five cheap steps, in order:
1. **Re-run the acceptance check yourself** — the test suite, the repro script, the pixel/state checker — from your own shell, not from the child's transcript.
2. **Inspect the artifacts yourself** (the report, the screenshots, the generated files) — not through the child's *description* of them.
3. **Generate your own fresh artifact from a clean state** (a new screenshot, a fresh build+run) to prove the result reproduces outside the child's worktree state.
4. **Inspect the committed diffs**: minimal, one concern per commit (bump submodule pointers deliberately), and no debug instrumentation left behind.
5. **Clean up**: supervisor artifacts (`pi-child-*.json/.log` — or your `--out-dir`), the child's scratch dirs and temp scripts, and your own monitoring scripts.

**After the run:**
- If the task installed extensions/packages, check the shared agent dir (`pi list` + the profile) for orphans; clean leftovers before the next run (a 2026-10-16 run silently left two video extensions on the account profile).
- `pi-child-final.txt` holds the child's FULL final message (`RESULT.finalTextFile` points at it; `RESULT.finalText` is still truncated to 4000 chars).

## Custom client (when the harness isn't enough)

For reacting dynamically between turns, answering extension-UI dialogs, switching models mid-conversation, or inspecting session state, write a short script using the exported `RpcClient`. `scripts/rpc-child.mjs` is the same pattern with argument parsing — read it as a reference. Core shape:

```js
import { pathToFileURL } from "node:url";
const pkgDir = "<resolved global dir of @earendil-works/pi-coding-agent>";
const { RpcClient } = await import(pathToFileURL(`${pkgDir}/dist/index.js`).href);

const client = new RpcClient({
  cliPath: `${pkgDir}/dist/bundle/cli.js`,
  args: [
    "--no-session",
    "--provider", process.env.PI_PROVIDER, // custom client: pass the parent's model explicitly (the harness scripts inherit it themselves)
    "--model", process.env.PI_MODEL,
    "--exclude-tools", "ask_user_question", // dialog tools block on unanswered UI requests
  ],
});
await client.start();
client.onEvent((e) => { /* stream e.assistantMessageEvent deltas, watch tool_execution_start / extension_ui_request */ });
await client.promptAndWait("turn 1", undefined, 5 * 60 * 1000);
// read the reply (accumulate text deltas, or client.getLastAssistantText()), then:
await client.promptAndWait("turn 2 that reacts to the reply", undefined, 5 * 60 * 1000);
await client.stop();
```

## No Node available?

Raw JSONL over stdio works in any language: spawn `pi --mode rpc --no-session`, write one JSON command object per line to stdin, read LF-delimited JSON records from stdout, and wait for `agent_settled`:

```python
import json, subprocess
p = subprocess.Popen(["pi", "--mode", "rpc", "--no-session"],
                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
p.stdin.write(json.dumps({"type": "prompt", "message": "Hello"}).encode() + b"\n")
p.stdin.flush()
for line in p.stdout:
    r = json.loads(line)
    if r.get("type") == "message_update" and r["assistantMessageEvent"]["type"] == "text_delta":
        print(r["assistantMessageEvent"]["delta"], end="", flush=True)
    elif r.get("type") == "agent_settled":
        break
p.stdin.close(); p.wait()
```

Note: do not use a generic line reader that splits on Unicode line separators (U+2028/U+2029) — split on LF only.

## Notes

- **v0.17.0:** (1) **`--invariant <cmd>` (repeatable) workspace invariants** — the missing failure sensor: every sensor previously watched *model behavior*, so a child could corrupt its own world (detached HEAD, a red self-test, conflict markers, stray processes) and "complete" cleanly. Invariants are shell commands that must always exit 0, re-checked every `--invariant-interval <sec>` (default 60); a failure is a sensor hit (evidence = the command's own output) that runs the normal ladder — steer → fork → `stuck-invariant`/`consult-invariant` — and every check logs `[invariant]` to the progress log (2026-10-31 BlockGame5 run 7: the world was broken for hours with a "completed" run, because every existing sensor keyed on model actions, not world state). (2) **Parent nudge channel** — `.steer-inbox/` files dropped on a live run are delivered to the child (prompt if idle, steer if mid-turn), logged as `[steer-inbox]` with disposition, counted in `parentSteers`, and moved to `processed/` as an audit trail; `monitor.mjs --steer <msg>` is the one-shot writer (atomic tmp+rename, refuses dead runs with exit 1). This was the gap that left the parent able to *verify* (pixel diffs, logs) but not *write back* to a live run — only wait, kill, or park-via-consult. (3) **`--preamble standard`** — `templates/standard-contract.md`, the standing rules every long task needed (deadline is the only stop condition; ~30-min commit re-baseline; **screenshots must be READ, not just taken**; never end on an empty message; safe git recovery with `git stash push` over blocked `checkout`/`reset --hard`; evidence-file conventions) — the contract a 2026-10-31 run's brief ended up hand-writing, now bundled. (4) **`campaign next` decision rule** — the script owns mechanics only; the LLM owns judgment: read the last result + diff verified facts vs acceptance criteria, `finish` when all criteria have dated artifact-backed evidence, otherwise write the next brief and spawn. (5) **Epoch deadlines** — `--deadline` accepts epoch seconds (10 digits) or milliseconds (13); the interpretation is echoed in `deadlineLocal` as `[epoch <n>]` (before: rejected, and the launcher silently fell back to the 240-min default — the fallback, not the error, was the trap); plus `--state-dir`→`--out-dir` and `--tag`→`--name` aliases in `launch.mjs` with a stderr warning instead of a hard failure. (6) **Empty-final settle** — an empty final message after a non-trivial attempt is a first-class settle (`empty-final`, full ladder) instead of the pre-v0.17.0 inconsistency where identical settles "completed" in one run and tripped `degenerate-settle` by accident in another. (7) **Monitor v0.17.0** — auto-tag when `--tag` is omitted, `--steer` one-shot mode, and a `deadline: {iso, remainingMin}` countdown in the output when the guard wrote a `deadlineIso` (a 20-min cycle no longer needs to re-read the status file for the clock). (8) **Manifest shape documented** — the payload is nested under the top-level `result` key (`{v, cwd, provider, model, startedAt, finishedAt, result}`); read `.result.finalText`. A `finalText: ""` with a 0-byte `pi-child-final.txt` is a legitimate model empty-final (handled by (3)/(6)), not a harness bug.
- **v0.16.1:** fixed Windows script-dir resolution in `test-campaign.mjs` and `test-deadline-stop.mjs` (`fileURLToPath` instead of `new URL(import.meta.url).pathname`, which yields `/C:/…` that Node resolves against the current drive → `E:\C:\Users\…` → `Cannot find module`). The v0.15/v0.16 test suites now run and pass on Windows (9/9, 15/15) — before this fix they could never run there.
- The harness runs the child with `--no-session` (throwaway) by default. Use `--session-id`/`--session` to persist and resume — see **Session persistence and resuming**.
- The child is a full agent: it has `read`, `bash`, `edit`, `write` by default and can do real work. Its tool activity arrives as `tool_execution_start` events (harness prints them to stderr).
- Credentials/config are inherited from the same config dir and environment, so a child in a pi session can use the same providers as the parent.
- Protocol references (pi docs, in the package): `docs/rpc.md` (protocol), `docs/rpc-commands.md` (all stdin commands), `docs/json.md` (events), `docs/rpc-extension-ui.md` (dialogs), `docs/cli-integration.md` (mode overview).
