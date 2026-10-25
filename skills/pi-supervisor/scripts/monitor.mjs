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
//       reason=expected   every expectedFile in the status is true
//       reason=cap        nothing happened within --cycle-min (default 20)
//   - One machine-readable JSON line on stdout — the caller needs exactly one
//     follow-up decision, not a file read.
//
// Usage:
//   node monitor.mjs --status <dir>/pi-child-status.json
//                    [--progress <dir>/pi-child-progress.log]
//                    [--cycle-min 20] [--liveness-min 3] [--poll 30]
//                    [--tail 8] [--tag <any-string>]
//
// --tag is echoed into the output: pass a per-cycle value (cycle-1, cycle-2…)
// so the invocation is not byte-identical across cycles — host-side repetition
// guards key on the call text.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function parseArgs() {
  const a = {
    status: null,
    progress: null,
    cycleMin: 20,
    livenessMin: 3,
    poll: 30,
    tail: 8,
    tag: null,
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
    else {
      console.error(`unknown arg: ${x}`);
      console.error("usage: monitor.mjs --status <dir>/pi-child-status.json [--progress <log>] [--cycle-min 20] [--liveness-min 3] [--poll 30] [--tail 8] [--tag <s>]");
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

function allExpectedMet(obj) {
  const ef = obj.expectedFiles;
  if (!ef || Object.keys(ef).length === 0) return false;
  return Object.values(ef).every((v) => v === true);
}

function emit(reason, liveness, obj, progressTail) {
  const out = {
    monitor: "pi-supervisor",
    reason, // settle | liveness | expected | cap
    liveness: liveness || null, // guard-pid-dead | status-stale | no-status-file
    status: obj ? obj.status : null,
    exitReason: obj ? obj.exitReason || null : null,
    attempts: obj ? obj.attempt ?? null : null,
    sessionId: obj ? obj.sessionId || null : null,
    sessionFile: obj ? obj.sessionFile || null : null,
    toolCalls: obj ? obj.toolCalls ?? null : null,
    expectedFiles: obj ? obj.expectedFiles || null : null,
    elapsedMonitorMs: Date.now() - t0,
    statusFile: A.status,
    tag: A.tag || undefined,
  };
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
      if ((st === "running" || st === "starting") && allExpectedMet(obj)) {
        emit("expected", null, obj, A.progress ? tailLines(A.progress, A.tail) : null);
        return;
      }
      if (st === "running" || st === "starting") {
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
