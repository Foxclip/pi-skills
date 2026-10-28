#!/usr/bin/env node
// launch.mjs — start guard.mjs DETACHED, cross-platform, verified.
//
// Companion to guard.mjs (v0.13.0). Why this exists — the observed failure
// modes all lived in the ad-hoc launch layer (VMWare campaign review,
// E:/Trash/Empty/supervisor-review-2026-10-26.md):
//   - foreground `node guard.mjs … | tee` inside a finite-timeout bash call
//     → the timeout tree-kills guard AND child (a healthy run died at 150s;
//     the frozen "running" status cost ~24 min of blind monitoring)
//   - PowerShell Start-Process -ArgumentList quoting bugs (does not re-quote
//     elements: --name "VMWare 6" arrived as --name + 6, the "6" became a
//     positional task argument)
//   - git-bash backslash path mangling (C:\Users\… arrived as
//     C:\UsersSuburban.… → MODULE_NOT_FOUND; redirect targets landed as stray
//     files in the CWD)
//   - redirect into a not-yet-existing --out-dir
//
// Usage:
//   node launch.mjs "task text" [guard options…]
//   node launch.mjs --task-file task.md --out-dir run1 --timeout 0
//                   --expect-file report.md [--name "Run N"]
//   Extra launch options:
//     --guard <path>     guard script to start (default: guard.mjs next to this file)
//                        (exists for tests — point it at a fake guard)
//     --verify-sec <n>   stage-1 verification window (default 8)
//     --grace-sec <n>    stage-2 grace if the status file is slow but the guard
//                        process is alive (default 60)
//
// Behavior:
//   - spawns guard.mjs with detached + hidden window (Windows) + unref — the
//     run survives any timeout the caller's shell call has
//   - guard stdout/stderr → <out-dir>/launch.out / launch.err (convention
//     preserved from the nohup fallback)
//   - creates --out-dir if missing
//   - refuses backslash paths with a clear error (forward slashes only)
//   - VERIFIES the launch in two stages (the checklist in SKILL.md, "Verify
//     the launch"): stage 1 (--verify-sec) waits for the status file — the
//     guard writes "starting" before it spawns its child, so on a warm host
//     this is a second or two. If the file is still missing but the guard
//     PROCESS is alive, stage 2 (--grace-sec) extends the wait: node cold
//     start / AV scanning of a detached hidden process measured ~14s on a
//     Windows dev host (2026-10-26). An alive-but-silent process is NOT a
//     failed launch — a bare launched:false would nudge the parent into a
//     second launch into the same out-dir.
//   - prints one JSON line and exits:
//       success: {"launched":true,"guardPid":…,"status":{…},"statusPath":…}
//       unknown: {"launched":"unknown","guardPid":…,"reason":…}  (exit 0 —
//                 process alive but silent after verify+grace; check it
//                 yourself, do not relaunch)
//       failure: {"launched":false,"reason":…,"launchOutTail":…,
//                 "launchErrTail":…}  (non-zero exit — only for a DEAD
//                 process or an arg-level refusal; the tails are inline so
//                 no second read is needed)
//
// The caller's shell call should not need a long timeout: this returns in
// ~verify-sec.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeadline, sizeDeadline, fmtLocal } from "./lib/deadline.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function passthroughValue(passthrough, flag, dflt) {
  for (let i = 0; i < passthrough.length; i++) {
    if (passthrough[i] === flag) {
      const v = Number(passthrough[i + 1]);
      return Number.isFinite(v) ? v : dflt;
    }
  }
  return dflt;
}
function setPassthroughTimeout(passthrough, value) {
  for (let i = 0; i < passthrough.length; i++) {
    if (passthrough[i] === "--timeout") { passthrough.splice(i, 2); break; }
  }
  passthrough.push("--timeout", String(value));
}

let outDir = null; // hoisted so fail() can attach launch.out/err tails
let child = null;  // hoisted so fail() can report the pid/exit code

function fail(reason) {
  const obj = { launched: false, reason };
  if (child) { obj.guardPid = child.pid; obj.exitCode = child.exitCode; }
  if (outDir) {
    for (const [key, p] of [["launchOutTail", join(outDir, "launch.out")], ["launchErrTail", join(outDir, "launch.err")]]) {
      try {
        const tail = readFileSync(p, "utf8").split(/\r?\n/).filter((l) => l.trim()).slice(-5).join(" | ");
        if (tail) obj[key] = tail.slice(-2000);
      } catch { /* file not there yet */ }
    }
  }
  console.log(JSON.stringify(obj));
  process.exit(1);
}

// Flags the guard takes NO value for — anything else starting with -- may
// carry a value, so a following bare argument is treated as ITS value (unknown
// flags are forwarded; the guard's strict CLI rejects them with its own error).
const VALUELESS = new Set([
  "--consult", "--no-session", "--pivot-relaunch",
  "--keep-question-tool", "--keep-delegate-tool", "-h", "--help",
]);

let guardPath = join(HERE, "guard.mjs");
let verifySec = 8;
let graceSec = 60;
let deadlineRaw = null; // --deadline <time>: size --timeout so finalize lands on this wall clock
let task = null;
let taskFromFlag = false; // --task/--task-file values stay in passthrough; only a positional task is prepended
let pendingValueFor = null; // last seen flag awaiting its value
const passthrough = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const x = argv[i];
  if (x === "--guard") { guardPath = argv[++i]; pendingValueFor = null; continue; }
  if (x === "--verify-sec") { verifySec = Number(argv[++i]); pendingValueFor = null; continue; }
  if (x === "--grace-sec") { graceSec = Number(argv[++i]); pendingValueFor = null; continue; }
  if (x === "--deadline") { deadlineRaw = argv[++i]; pendingValueFor = null; continue; }
  if (x === "--") { passthrough.push(x); pendingValueFor = null; continue; }
  if (x.startsWith("--")) {
    pendingValueFor = VALUELESS.has(x) ? null : x;
    passthrough.push(x);
    continue;
  }
  // Bare argument.
  if (pendingValueFor) {
    if (pendingValueFor === "--task" || pendingValueFor === "--task-file") {
      task = x;
      taskFromFlag = true;
    }
    passthrough.push(x);
    pendingValueFor = null;
    continue;
  }
  const prev = i > 0 ? argv[i - 1] : null;
  if (prev !== null && prev.startsWith("--") && !VALUELESS.has(prev)) {
    // Value of a flag the loop did not consume (defensive).
    passthrough.push(x);
    continue;
  }
  if (task === null) { task = x; continue; } // the positional task
  fail(`unexpected extra positional argument: ${x} (task must be a bare argument, or use --task <t> / --task-file <path>)`);
}
if (pendingValueFor) fail(`flag ${pendingValueFor} is missing its value`);

// Path hygiene:
//  - POSIX: backslashes are literal filename characters — a path with them is
//    almost certainly a mangled Windows path (git-bash eats backslashes; the
//    VMWare campaign's MODULE_NOT_FOUND + stray-redirect failures). Refuse.
//  - Windows: backslashes are normal native paths — accept. But a Windows path
//    typed in git-bash arrives MANGLED (backslashes already eaten), which looks
//    like a nonexistent file — the task-file check below catches that.
if (process.platform !== "win32") {
  for (const a of [...(task ? [task] : []), ...passthrough]) {
    if (typeof a === "string" && a.includes("\\")) {
      fail(`backslash path in argument: ${a} — use forward slashes (git-bash mangles backslashes)`);
    }
  }
}
if (task === null) fail("no task: pass it as the FIRST positional argument, or via --task <t> / --task-file <path>");
if (!existsSync(guardPath)) fail(`guard script not found: ${guardPath}`);
for (let i = 0; i < passthrough.length; i++) {
  if (passthrough[i] === "--task-file") {
    const p = passthrough[i + 1];
    if (!p || !existsSync(p)) {
      fail(`task file not found: ${p || "(missing value)"} — if you typed a Windows path in git-bash, its backslashes were mangled; use forward slashes`);
    }
  }
}

// --out-dir: create it (redirect targets and status file must have a home).
for (let i = 0; i < passthrough.length; i++) {
  if (passthrough[i] === "--out-dir") outDir = passthrough[i + 1];
}
outDir = outDir || process.cwd();
try { mkdirSync(outDir, { recursive: true }); } catch (e) { fail(`cannot create out dir ${outDir}: ${e.message}`); }

// --deadline: replace --timeout so the guard's finalization window ends at the
// wall-clock deadline. total real time = --timeout + --finalize, so reserve it.
let deadlineInfo = null;
if (deadlineRaw !== null) {
  const P = parseDeadline(deadlineRaw);
  if (!P.ok) {
    fail(`cannot parse --deadline "${deadlineRaw}" — use ISO (2026-10-28T10:00Z) or a local wall clock ("2026-10-28 10:00", "10:00")`);
  }
  const finalizeMin = passthroughValue(passthrough, "--finalize", 10);
  const S = sizeDeadline({ ts: P.ts, finalizeMin, now: new Date() });
  if (!S.ok) {
    fail(`--deadline ${fmtLocal(P.ts)} ${S.why}`);
  }
  setPassthroughTimeout(passthrough, S.timeoutMin);
  deadlineInfo = {
    deadline: P.ts.toISOString(),
    deadlineLocal: P.label,
    timeoutMin: S.timeoutMin,
    finalizeMin: S.finalizeMin,
    hardStopAt: S.hardStopAt,
    hardStopAtLocal: S.hardStopAtLocal,
    finalizeAt: S.finalizeAt,
    finalizeAtLocal: S.finalizeAtLocal,
    note: `--timeout ${S.timeoutMin} computed so the ${S.finalizeMin}min finalization window ends at the deadline (projected: hard stop ${S.hardStopAtLocal}, finalize ${S.finalizeAtLocal})`,
  };
}

// Launch: detached + unref → survives the caller's timeout. Hidden window on
// Windows (detached implies CREATE_NEW_CONSOLE; windowsHide suppresses it).
const guardArgs = taskFromFlag ? [guardPath, ...passthrough] : [guardPath, task, ...passthrough];
try {
  const outFd = openSync(join(outDir, "launch.out"), "a");
  const errFd = openSync(join(outDir, "launch.err"), "a");
  child = spawn(process.execPath, guardArgs, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", outFd, errFd],
  });
} catch (e) {
  fail(`spawn failed: ${e.message}`);
}
child.unref();

// Verify (two stages). Stage 1 (--verify-sec): wait for the status file.
// Stage 2 (--grace-sec): file still missing but the guard PROCESS is alive →
// slow host startup; keep waiting. Only a DEAD process is a failure (with the
// launch.out/launch.err tails inlined); an alive-but-silent process is
// "unknown" (exit 0) so the parent verifies instead of relaunching.
const statusPath = join(outDir, "pi-child-status.json");
const t0 = Date.now();
const deadline = t0 + (verifySec + graceSec) * 1000;
let seen = null;
let seenAtMs = 0;
while (Date.now() - t0 < deadline) {
  await sleep(500);
  if (child.exitCode !== null || child.signalCode !== null) {
    fail(`guard process exited before the launch could be verified (code ${child.exitCode}, signal ${child.signalCode || "none"}) — see launchOutTail/launchErrTail`);
  }
  try {
    seen = JSON.parse(readFileSync(statusPath, "utf8"));
    if (seen.status === "error" || seen.status === "stuck") {
      fail(`status file already terminal at launch: status=${seen.status} exitReason=${seen.exitReason || "?"} — see launchOutTail/launchErrTail`);
    }
    // starting|running|completed|consult — the guard is (was) alive and writing
    seenAtMs = Date.now() - t0;
    break;
  } catch {
    seen = null; // not written yet
  }
}
if (!seen) {
  // Still no file after verify+grace and the process is ALIVE (a dead process
  // would have failed above). Slow host, not a failed launch.
  console.log(JSON.stringify({
    launched: "unknown",
    guardPid: child.pid,
    reason: `status file still absent after ${verifySec}s + ${graceSec}s grace, but the guard process is ALIVE — startup is slow on this host (node cold start / AV scan). Do NOT relaunch into ${outDir}. Check the process, tail ${join(outDir, "launch.out")}, and/or run monitor.mjs --status ${statusPath}.`,
    statusPath,
    elapsedMs: Date.now() - t0,
    ...(deadlineInfo ? { deadline: deadlineInfo } : {}),
  }));
  process.exit(0);
}
console.log(JSON.stringify({
  launched: true,
  guardPid: child.pid,
  status: seen,
  statusPath,
  verifiedMs: seenAtMs,
  ...(deadlineInfo ? { deadline: deadlineInfo } : {}),
  ...(seenAtMs > verifySec * 1000 ? { slowStart: true, note: "status file appeared after the stage-1 window — slow host startup" } : {}),
}));
process.exit(0);
