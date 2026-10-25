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
//     --verify-sec <n>   how long to verify the launch (default 8)
//
// Behavior:
//   - spawns guard.mjs with detached + hidden window (Windows) + unref — the
//     run survives any timeout the caller's shell call has
//   - guard stdout/stderr → <out-dir>/launch.out / launch.err (convention
//     preserved from the nohup fallback)
//   - creates --out-dir if missing
//   - refuses backslash paths with a clear error (forward slashes only)
//   - VERIFIES the launch (the checklist in SKILL.md, "Verify the launch"):
//     guard process alive AND the status file appeared with a live status
//   - prints one JSON line and exits:
//       success: {"launched":true,"guardPid":…,"status":{…},"statusPath":…}
//       failure: {"launched":false,"reason":…}  (non-zero exit)
//
// The caller's shell call should not need a long timeout: this returns in
// ~verify-sec.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(reason) {
  console.log(JSON.stringify({ launched: false, reason }));
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
let task = null;
let taskFromFlag = false; // --task/--task-file values stay in passthrough; only a positional task is prepended
let pendingValueFor = null; // last seen flag awaiting its value
const passthrough = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const x = argv[i];
  if (x === "--guard") { guardPath = argv[++i]; pendingValueFor = null; continue; }
  if (x === "--verify-sec") { verifySec = Number(argv[++i]); pendingValueFor = null; continue; }
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
let outDir = null;
for (let i = 0; i < passthrough.length; i++) {
  if (passthrough[i] === "--out-dir") outDir = passthrough[i + 1];
}
outDir = outDir || process.cwd();
try { mkdirSync(outDir, { recursive: true }); } catch (e) { fail(`cannot create out dir ${outDir}: ${e.message}`); }

// Launch: detached + unref → survives the caller's timeout. Hidden window on
// Windows (detached implies CREATE_NEW_CONSOLE; windowsHide suppresses it).
const guardArgs = taskFromFlag ? [guardPath, ...passthrough] : [guardPath, task, ...passthrough];
let child;
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

// Verify: guard process alive AND the status file appeared with a live status.
// (A killed guard leaves a stale "running" — the process check, not the file,
// is what proves the launch worked. The guard writes status "starting" before
// it spawns its child, so the file is expected within a second or two.)
const statusPath = join(outDir, "pi-child-status.json");
const t0 = Date.now();
let seen = null;
while (Date.now() - t0 < verifySec * 1000) {
  await sleep(500);
  if (child.exitCode !== null || child.signalCode !== null) {
    fail(`guard process exited during launch (code ${child.exitCode}, signal ${child.signalCode || "none"}) — read ${join(outDir, "launch.out")} and ${join(outDir, "launch.err")}`);
  }
  try {
    seen = JSON.parse(readFileSync(statusPath, "utf8"));
    if (seen.status === "starting" || seen.status === "running") break;
    if (seen.status === "error" || seen.status === "stuck") {
      fail(`status file already terminal at launch: status=${seen.status} exitReason=${seen.exitReason || "?"} — read ${join(outDir, "launch.out")}`);
    }
  } catch {
    seen = null; // not written yet
  }
}
if (!seen) {
  fail(`status file did not appear at ${statusPath} within ${verifySec}s — the launch likely failed; check the arguments and ${join(outDir, "launch.out")}`);
}
console.log(JSON.stringify({ launched: true, guardPid: child.pid, status: seen, statusPath }));
process.exit(0);
