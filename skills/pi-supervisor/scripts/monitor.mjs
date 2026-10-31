#!/usr/bin/env node
// monitor.mjs — blocking wait loop for a DETACHED guard run, with early return.
//
// Companion to guard.mjs (v0.13.0). The run is detached (launch.mjs or nohup);
// this call only watches. Aborting this call is always safe and cheap — the
// run keeps going, and re-invocation is idempotent.
//
// Contract (see SKILL.md, "One blocking wait, not polling"):
//   - Poll the status file every --poll seconds (default 30).
//   - Return EARLY the moment anything happens:
//       reason=settle     terminal status (completed | stuck | consult | error)
//       reason=liveness   status says running/starting, but the guard process
//                         is gone (v:2 guardPid check) — a KILLED guard never
//                         updates the file, so a stale "running" + dead PID is
//                         a dead run. Never trust the file alone.
//                         (v:1 files without PIDs fall back to file freshness:
//                         the guard heartbeats `at` every 30s, so a healthy
//                         run — even mid long model-think — never goes stale
//                         past --liveness-min.)
//       reason=settled-manifest  the result manifest (pi-child-result.json in
//                         the status dir) appeared while the status still
//                         said running/starting — the manifest is the
//                         definitive completion marker. (Stale manifests from
//                         an earlier run in the same dir are ignored: the
//                         manifest must be newer than the status's `at`.)
//       reason=cap        nothing happened within --cycle-min (default 20)
//   - There is NO early return on expectedFiles: the child is usually told
//     to keep the report file updated as it goes, so the file exists from
//     early on and "expected files present" never meant "done". The guard
//     still enforces expected files at settle (missing file → intervention
//     ladder); the monitor only waits.
//   - One machine-readable JSON line on stdout — the caller needs exactly one
//     follow-up decision, not a file read.
//
// Usage:
//   node monitor.mjs --status <dir>/pi-child-status.json
//                    [--progress <dir>/pi-child-progress.log]
//                    [--cycle-min 20] [--liveness-min 3] [--poll 30]
//                    [--tail 8] [--tag <any-string>]
//   node monitor.mjs --status <dir>/pi-child-status.json --steer "message"
//
// --tag is echoed into the output: pass a per-cycle value (cycle-1, cycle-2…)
// so the invocation is not byte-identical across cycles — host-side repetition
// guards key on the call text. v0.17.0: when omitted, a tag is AUTO-generated
// (timestamp + pid), so omitting it can no longer produce byte-identical
// invocations.
//
// --steer (v0.17.0) — the parent nudge channel: write the message into the
// run's steer inbox (<out-dir>/.steer-inbox/). The LIVE guard delivers it to
// the child (prompt if idle, steer if mid-turn), logs it to the progress log,
// and moves the file to processed/ (audit trail). Requires a live run
// (status running/starting + live guardPid) — otherwise exit 1 and NO file is
// written.
//
// v0.17.0: the output JSON also carries the deadline countdown when the
// status file has a deadlineIso: {deadline: {iso, remainingMin}} — a 20-min
// monitor cycle is self-contained without re-reading the status file.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

function parseArgs() {
  const a = {
    status: null,
    progress: null,
    cycleMin: 20,
    livenessMin: 3,
    poll: 30,
    tail: 8,
    tag: null,
    steer: null,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--status") a.status = argv[++i];
    else if (x === "--progress") a.progress = argv[++i];
    else if (x === "--cycle-min") a.cycleMin = Number(argv[++i]);
    else if (x === "--liveness-min") a.livenessMin = Number(argv[++i]);
    else if (x === "--poll") a.poll = Math.max(5, Number(argv[++i]));
    else if (x === "--tail") a.tail = Number(argv[++i]);
    else if (x === "--tag") a.tag = argv[++i];
    else if (x === "--steer") a.steer = argv[++i];
    else {
      console.error(`unknown arg: ${x}`);
      console.error("usage: monitor.mjs --status <dir>/pi-child-status.json [--progress <log>] [--cycle-min 20] [--liveness-min 3] [--poll 30] [--tail 8] [--tag <s>] [--steer <msg>]");
      process.exit(2);
    }
  }
  if (!a.status) {
    console.error("error: --status <dir>/pi-child-status.json is required");
    process.exit(2);
  }
  return a;
}

const A = parseArgs();

// v0.17.0: auto-tag (see the --tag note in the header).
if (A.tag === null) {
  A.tag = `auto-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Is a pid alive? Unknown (null/absent/non-positive) => true — never report
// DEAD on a check that cannot be made.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (process.platform === "win32") {
    try {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", timeout: 5000 });
      if (r.status !== 0) return true; // tasklist itself failed — cannot conclude
      if (/INFO:/.test(r.stdout)) return false;
      return r.stdout
        .split("\n")
        .some((l) => l.trim().split(/\s+/)[1] === String(pid));
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

function readStatus() {
  try {
    return { obj: JSON.parse(readFileSync(A.status, "utf8")), err: null };
  } catch (e) {
    return { obj: null, err: e.code === "ENOENT" ? "missing" : `unreadable: ${e.message}` };
  }
}

function tailLines(file, n) {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    return lines.slice(-n);
  } catch {
    return null;
  }
}

const resultPath = join(dirname(A.status), "pi-child-result.json");

// v0.14.0: is there a result manifest that is newer than the current status
// heartbeat? Returns the manifest's finishedAt, or null.
function manifestSignal() {
  try {
    const m = JSON.parse(readFileSync(resultPath, "utf8"));
    const fin = Date.parse(m.finishedAt);
    if (!Number.isFinite(fin)) return null;
    const at = Date.parse(readStatus().obj?.at);
    if (Number.isFinite(at) && fin < at) return null; // stale — earlier run in the same dir
    return m.finishedAt;
  } catch {
    return null;
  }
}

// v0.17.0: --steer one-shot mode (the parent nudge channel). Writes the
// message into the run's steer inbox; the live guard delivers it.
function steerOneShot() {
  const dir = dirname(A.status);
  const { obj, err } = readStatus();
  let live = false;
  if (!err && obj && (obj.status === "running" || obj.status === "starting")) {
    live = !(obj.v === 2 && Number.isInteger(obj.guardPid)) || pidAlive(obj.guardPid);
  }
  if (!live) {
    console.log(JSON.stringify({
      monitor: "pi-supervisor",
      steer: false,
      status: obj ? obj.status : "missing",
      reason: `no live run to steer (status=${obj ? obj.status : "missing"}) — the guard is not running here; nothing was written`,
    }));
    process.exit(1);
  }
  const inbox = join(dir, ".steer-inbox");
  mkdirSync(inbox, { recursive: true });
  const name = `steer-${Date.now()}-${process.pid}.txt`;
  const p = join(inbox, name);
  writeFileSync(`${p}.tmp`, A.steer, "utf8");
  renameSync(`${p}.tmp`, p); // atomic — the guard never sees a half-written file
  console.log(JSON.stringify({
    monitor: "pi-supervisor",
    steer: true,
    file: p,
    status: obj.status,
    note: "the guard delivers it to the live child (prompt if idle, steer if mid-turn) and moves it to .steer-inbox/processed/",
  }));
  process.exit(0);
}
if (A.steer !== null) steerOneShot();

function emit(reason, liveness, obj, progressTail) {
  const out = {
    monitor: "pi-supervisor",
    reason, // settle | settled-manifest | liveness | cap
    liveness: liveness || null, // guard-pid-dead | status-stale | no-status-file
    status: obj ? obj.status : null,
    exitReason: obj ? obj.exitReason || null : null,
    attempts: obj ? obj.attempt ?? null : null,
    sessionId: obj ? obj.sessionId || null : null,
    sessionFile: obj ? obj.sessionFile || null : null,
    toolCalls: obj ? obj.toolCalls ?? null : null,
    expectedFiles: obj ? obj.expectedFiles || null : null,
    // v0.17.0: deadline countdown — self-contained cycles without re-reading
    // the status file (set when the guard wrote a deadlineIso into the status).
    deadline: null,
    manifestPath: resultPath,
    elapsedMonitorMs: Date.now() - t0,
    statusFile: A.status,
    tag: A.tag || undefined,
  };
  if (obj && obj.deadlineIso) {
    const dl = Date.parse(obj.deadlineIso);
    if (Number.isFinite(dl)) out.deadline = { iso: obj.deadlineIso, remainingMin: Math.round((dl - Date.now()) / 60000) };
  }
  if (progressTail) out.progressTail = progressTail;
  console.log(JSON.stringify(out));
}

const t0 = Date.now();
const capMs = A.cycleMin * 60_000;
let fileSeen = false;
// The guard writes the status file at startup (before the child spawns). If it
// is still absent after two polls, the launch itself failed — do not burn the
// whole cycle waiting for a file that will never come.
const missingGiveUpAt = t0 + A.poll * 1000 * 2;

async function main() {
  while (true) {
    const remaining = capMs - (Date.now() - t0);
    if (remaining <= 0) {
      emit("cap", null, readStatus().obj, A.progress ? tailLines(A.progress, A.tail) : null);
      return;
    }

    const { obj, err } = readStatus();
    if (!err) fileSeen = true;

    if (!err && obj) {
      const st = obj.status;
      if (st === "completed" || st === "stuck" || st === "consult" || st === "error") {
        emit("settle", null, obj, A.progress ? tailLines(A.progress, A.tail) : null);
        return;
      }
      if (st === "running" || st === "starting") {
        // v0.14.0: watch the result manifest as a completion signal (covers
        // a lagging status write; a stale manifest from an earlier run in the
        // same dir is excluded by the freshness check inside manifestSignal).
        if (manifestSignal()) {
          emit("settled-manifest", null, obj, A.progress ? tailLines(A.progress, A.tail) : null);
          return;
        }
        // Liveness: the file can only assert what the guard itself wrote. A
        // killed guard leaves a stale "running" — check the process.
        let dead = false;
        let why = null;
        if (obj.v === 2 && Number.isInteger(obj.guardPid)) {
          dead = !pidAlive(obj.guardPid);
          why = "guard-pid-dead";
        } else {
          // v:1 file, or v:2 after the exit-hook nulled the PIDs: freshness
          // fallback. The 30s heartbeat keeps `at` fresh while alive, so a
          // healthy run never crosses --liveness-min.
          const at = Date.parse(obj.at);
          dead = Number.isFinite(at) && Date.now() - at > A.livenessMin * 60_000;
          why = "status-stale";
        }
        if (dead) {
          emit("liveness", why, obj, A.progress ? tailLines(A.progress, A.tail) : null);
          return;
        }
      }
    } else if (err && !fileSeen && Date.now() > missingGiveUpAt) {
      emit("liveness", "no-status-file", null, null);
      return;
    }

    await sleep(Math.min(A.poll * 1000, remaining));
  }
}

main().catch((e) => {
  console.error(`monitor error: ${e.message}`);
  process.exit(1);
});
