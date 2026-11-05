#!/usr/bin/env node
// Kernel-protection child wrapper (v0.26.0).
//
// The guard's RpcClient spawns `node <cliPath> --mode rpc ...` and hard-codes
// the executable, so the user switch cannot live in the spawn call. Instead
// the guard points RpcClient at THIS file (run as the owner) and the real CLI
// path arrives via env. We re-exec the real CLI as the protected child user
// through the scoped passwordless sudo rule (protect.mjs installs it), in its
// own process group, and stay alive as the stdio bridge + exit-code forwarder.
//
// Env (set by guard.mjs):
//   PI_SUP_CHILD_USER  child OS user (required)
//   PI_SUP_REAL_CLI    absolute path of the real pi cli.js (required)
//   PI_SUP_PIDFILE     optional: where to write the child's group pid (stop.mjs)
//
// Signal contract: SIGTERM/SIGINT on us → forwarded (as the child user, via
// sudo kill, and as the owner for the owner-owned group leader) to the child
// process group, then we exit with the conventional code.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

const user = process.env.PI_SUP_CHILD_USER;
const realCli = process.env.PI_SUP_REAL_CLI;
if (!user || !realCli) {
  console.error("child-wrapper: PI_SUP_CHILD_USER and PI_SUP_REAL_CLI must be set");
  process.exit(64);
}

const args = process.argv.slice(2);
const child = spawn(
  "sudo",
  ["-n", "-u", user, process.execPath, realCli, ...args],
  { stdio: "inherit", detached: true }
);

// Record the child's process-group pid + user so stop.mjs can signal and
// verify the subtree (the group leader is the sudo parent; the real CLI runs
// as `user`). Format: "<group-pid>\n<user>".
if (process.env.PI_SUP_PIDFILE) {
  try {
    fs.writeFileSync(process.env.PI_SUP_PIDFILE, `${child.pid}\n${user}`);
  } catch {
    /* best effort */
  }
}

let exitCode = null;
let exitSignal = null;
let finished = false;

function childGroup() {
  return child.pid;
}

function forward(sig) {
  const g = childGroup();
  if (g <= 0) return;
  // As the child user: reaches every `user`-owned member (the real CLI and
  // its tool processes). The owner-owned sudo parent may be EPERM here — the
  // owner-side kill below covers it (and Linux signals all it can).
  try {
    spawnSync("sudo", ["-n", "-u", user, "/usr/bin/kill", "-s", sig, `-${g}`], { stdio: "ignore" });
  } catch {
    /* best effort */
  }
  try {
    process.kill(-g, sig);
  } catch {
    /* best effort */
  }
}

function finish(code) {
  if (finished) return;
  finished = true;
  process.exit(code);
}

child.on("exit", (code, sig) => {
  exitCode = code;
  exitSignal = sig;
  // sudo exits with the command's code, or 128+signal when the command died
  // to a signal it did not relay.
  finish(code != null ? code : sig ? 128 + { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }[sig] : 1);
});

process.on("SIGTERM", () => {
  forward("SIGTERM");
  setTimeout(() => finish(143), 2000).unref();
});
process.on("SIGINT", () => {
  forward("SIGINT");
  setTimeout(() => finish(130), 2000).unref();
});

// If the child died on its own before we got the event, report it.
setTimeout(() => {
  if (!finished && child.exitCode == null) {
    /* still running — normal; the wrapper bridges stdio until it exits */
  }
}, 10).unref();
