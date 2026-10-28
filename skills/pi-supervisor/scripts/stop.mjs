#!/usr/bin/env node
// stop.mjs — STOP a detached guard run cleanly (the "stop the child" step).
//
// Companion to launch.mjs / monitor.mjs (v0.15.0). When the parent wants to
// stop a run — the user says "stop it", the campaign is done, a deadline is
// being forced — hand-rolling `kill -TERM <child>; kill -TERM <guard>` +
// verify-both-dead is error-prone (order, the child vs the guard, confirming).
// This does it in one call, ordered and verified:
//
//   1. read <out-dir>/pi-child-status.json → guardPid. launch.mjs spawns the
//      guard DETACHED, so the guard is the process-group leader (PGID == guardPid)
//      and the child pi process it spawns inherits that group. One group signal
//      therefore stops the whole tree. (childPid is null — RpcClient does not
//      expose it — so the guardPid + its group is the target, not the child pid.)
//   2. SIGTERM the group (graceful: the guard's own handler marks the status
//      file error/killed-SIGTERM and exits; the child dies with the group).
//   3. wait --grace-sec for the group to go.
//   4. if still alive → SIGKILL the group (force).
//   5. re-read the status file, report what it says, and confirm the PIDs are dead.
//
// One machine-readable JSON line on stdout; warnings on stderr.
//   exit 0  the run is stopped (or was already stopped)
//   exit 1  could not confirm death, OR nothing could be found (ambiguous — verify)
//   exit 2  hard error (bad args, unparseable status file)
//
// Usage:
//   node stop.mjs --out-dir <dir> [--grace-sec 10] [--signal SIGTERM] [--force]
//   node stop.mjs --status <dir>/pi-child-status.json [--grace-sec 10]
//
// --force  skip the graceful SIGTERM, go straight to SIGKILL (a wedged guard).
// --signal which graceful signal to send (default SIGTERM; SIGINT also works —
//          the guard marks killed-SIGINT).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs() {
  const a = { outDir: null, status: null, graceSec: 10, signal: "SIGTERM", force: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--out-dir") a.outDir = argv[++i];
    else if (x === "--status") a.status = argv[++i];
    else if (x === "--grace-sec") a.graceSec = Number(argv[++i]);
    else if (x === "--signal") a.signal = String(argv[++i]).toUpperCase();
    else if (x === "--force") a.force = true;
    else {
      console.error(`unknown arg: ${x}`);
      console.error("usage: stop.mjs (--out-dir <dir> | --status <path>) [--grace-sec 10] [--signal SIGTERM] [--force]");
      process.exit(2);
    }
  }
  if (!a.outDir && !a.status) {
    console.error("error: pass --out-dir <dir> (status file = <dir>/pi-child-status.json) or --status <path>");
    process.exit(2);
  }
  if (a.outDir && a.status) {
    console.error("error: pass --out-dir OR --status, not both");
    process.exit(2);
  }
  if (!["SIGTERM", "SIGINT", "SIGKILL"].includes(a.signal)) {
    console.error(`error: --signal must be SIGTERM, SIGINT or SIGKILL (got ${a.signal})`);
    process.exit(2);
  }
  return a;
}

const A = parseArgs();
const statusPath = A.status || join(A.outDir, "pi-child-status.json");

// Is a pid alive? Unknown (null/absent/non-positive) => true — never report DEAD
// on a check that cannot be made (same contract as monitor.mjs).
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (process.platform === "win32") {
    try {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", timeout: 5000 });
      if (r.status !== 0) return true; // tasklist itself failed — cannot conclude
      if (/INFO:/.test(r.stdout)) return false;
      return r.stdout.split("\n").some((l) => l.trim().split(/\s+/)[1] === String(pid));
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

// Signal the run's whole process group. Mirrors the killTree() convention in
// test-launch-monitor.mjs (negative pid = the group on POSIX; taskkill /T on
// Windows, where /F is the force equivalent). Returns a short disposition.
function signalGroup(pid, sig) {
  if (!Number.isInteger(pid) || pid <= 0) return "no-pid";
  if (process.platform === "win32") {
    try {
      const args = ["/PID", String(pid), "/T"];
      if (sig === "SIGKILL") args.push("/F");
      spawnSync("taskkill", args, { stdio: "ignore", timeout: 8000 });
      return "sent";
    } catch {
      return "failed";
    }
  }
  try {
    process.kill(-pid, sig); // negative pid = the guard's process group
    return "sent-group";
  } catch (e) {
    if (e.code === "ESRCH") {
      // No such group — the guard was not a group leader (e.g. run in the
      // foreground). Fall back to signaling the process alone.
      try { process.kill(pid, sig); return "sent-proc"; }
      catch (e2) { return e2.code === "ESRCH" ? "gone" : "failed"; }
    }
    if (e.code === "EPERM") return "sent-group"; // exists, not ours
    return "failed";
  }
}

function readStatus() {
  try { return { obj: JSON.parse(readFileSync(statusPath, "utf8")), err: null }; }
  catch (e) { return { obj: null, err: e.code === "ENOENT" ? "missing" : `unreadable: ${e.message}` }; }
}

function finish(out, code) {
  out.elapsedMs = Date.now() - t0;
  console.log(JSON.stringify(out));
  process.exit(code);
}

const t0 = Date.now();
const out = {
  stopped: false,
  stoppedVia: null,
  guardPid: null,
  childPid: null,
  signal: A.signal,
  graceSec: A.graceSec,
  statusPath,
  manifestPath: join(dirname(statusPath), "pi-child-result.json"),
};

const { obj, err } = readStatus();
if (err) {
  if (err === "missing") {
    // No file: ambiguous — nothing running here, OR the parent passed the wrong
    // --out-dir. Exit 1 (verify) so a typo'd path is not mistaken for a stop.
    out.reason = `no status file at ${statusPath} — nothing running here, or wrong --out-dir; verify`;
    finish(out, 1);
  }
  out.reason = `cannot read status file: ${err}`;
  finish(out, 2); // corrupt/unreadable — a hard error
}

if (!obj.guardPid) {
  out.finalStatus = obj;
  out.finalStatusStatus = obj.status || null;
  out.reason = `status file has no guardPid (status=${obj.status || "?"}) — the run already exited`;
  finish(out, 0);
}
out.guardPid = obj.guardPid;
out.childPid = obj.childPid ?? null;

const groupDead = () => !pidAlive(obj.guardPid) && (!obj.childPid || !pidAlive(obj.childPid));

if (!pidAlive(obj.guardPid)) {
  out.stopped = false;
  out.stoppedVia = "already-dead";
  out.confirmedDead = { guard: true, child: obj.childPid ? !pidAlive(obj.childPid) : "unknown" };
  out.finalStatus = obj;
  out.finalStatusStatus = obj.status || null;
  out.reason = `guard pid ${obj.guardPid} is not alive — run already stopped`;
  finish(out, 0);
}

// --- The guard is alive. Signal its group. -----------------------------------
if (!A.force) {
  const sent = signalGroup(obj.guardPid, A.signal);
  if (sent === "failed") process.stderr.write(`[stop] graceful group signal reported failure — will escalate\n`);
  // Poll for the group to die within the grace window.
  const gEnd = t0 + A.graceSec * 1000;
  while (!groupDead() && Date.now() < gEnd) await sleep(500);
  if (groupDead()) {
    out.stopped = true;
    out.stoppedVia = `${A.signal}-group`;
  } else {
    // Escalate: force-kill the whole group.
    const k = signalGroup(obj.guardPid, "SIGKILL");
    if (k === "failed") out.escalateNote = "SIGKILL group signal reported failure — verify manually";
    const kEnd = Date.now() + Math.min(5000, Math.max(1500, Math.round(A.graceSec * 1000 / 2)));
    while (!groupDead() && Date.now() < kEnd) await sleep(400);
    out.stopped = groupDead();
    out.stoppedVia = `${A.signal}-group→SIGKILL`;
  }
} else {
  const k = signalGroup(obj.guardPid, "SIGKILL");
  if (k === "failed") out.escalateNote = "SIGKILL group signal reported failure — verify manually";
  const kEnd = Date.now() + 5000;
  while (!groupDead() && Date.now() < kEnd) await sleep(400);
  out.stopped = groupDead();
  out.stoppedVia = "SIGKILL-group";
}

// Re-read: the guard's SIGTERM/SIGINT handler marks error/killed-<sig>; a
// SIGKILL'd group leaves the last heartbeat's file (possibly still "running").
const { obj: final } = readStatus();
const fs2 = final || obj;
out.confirmedDead = {
  guard: !pidAlive(obj.guardPid),
  child: obj.childPid ? !pidAlive(obj.childPid) : "unknown",
};
out.finalStatus = fs2;
out.finalStatusStatus = fs2.status || null;
out.finalStatusExitReason = fs2.exitReason || null;
if (!out.stopped) {
  out.reason = `signaled but could not confirm death within the grace window — verify ${statusPath} manually`;
} else if (obj.childPid && out.confirmedDead.child === false) {
  out.childNote = `child pid ${obj.childPid} still reports alive (it is in the group the signal targeted) — re-check`;
}

finish(out, out.stopped ? 0 : 1);
