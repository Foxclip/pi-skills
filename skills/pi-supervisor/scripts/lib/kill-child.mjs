// lib/kill-child.mjs
//
// Kill the child subtree of a protected window. The wrapper group's leader is
// owned by the OWNER, so a plain owner-side group signal kills the leader and
// any owner-owned members — but NOT the sudo'd child pi (EPERM, by design).
// The sudo drop-in grants the owner `kill *` AS the child user, so the group
// is signalled from both sides. For non-protected windows (no childUser),
// only the owner-side group signal is attempted.
//
// status = the pi-child-status.json contents ({ childPgid, childUser, ... }).
// Returns { errors } — caller decides whether to hard-fail.

import { execFileSync } from "node:child_process";
import fs from "node:fs";

export function killChildGroup(status, signal = "SIGTERM") {
  const errors = [];
  const sigName = String(signal || "SIGTERM").replace(/^SIG/i, "").toUpperCase();
  const g = Number(status && status.childPgid);
  const user = status && status.childUser;
  if (!Number.isFinite(g) || g <= 1) return { errors: ["no childPgid recorded"] };
  // Owner side: kills the leader (sudo) + wrapper; EPERM on the child node
  // process is expected and handled below via sudo.
  try {
    process.kill(-g, sigName);
  } catch (e) {
    errors.push(`owner group-kill: ${e.message}`);
  }
  // Child-user side: reaches the sudo'd pi subtree (same group id — the
  // wrapper spawned it in the wrapper's own detached group).
  if (user) {
    try {
      execFileSync(
        "sudo", ["-n", "-u", user, "kill", "-s", sigName, `-${g}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
      );
    } catch (e) {
      const msg = ((e.stderr || "") + " " + (e.message || "")).trim();
      // ESRCH (group already gone) is fine.
      if (!/no such process|ESRCH/i.test(msg)) errors.push(`sudo kill: ${msg.split("\n").pop()}`);
    }
  }
  return { errors };
}

// Resolve the child group from a status file on disk (stop.mjs path).
export function killChildGroupFromStatusFile(statusFile, signal = "SIGTERM") {
  try {
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    return killChildGroup(status, signal);
  } catch {
    return { errors: [`status file unreadable: ${statusFile}`] };
  }
}

export function waitForGroupGone(group, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    let alive = true;
    try { process.kill(-group, 0); } catch { alive = false; }
    if (!alive) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}
