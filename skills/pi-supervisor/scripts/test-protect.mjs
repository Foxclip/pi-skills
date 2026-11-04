#!/usr/bin/env node
// Kernel-protection test suite (v0.26.0).
//
// Exercises the REAL kernel mechanism (user + ACLs + scoped sudo + bind mount +
// wrapper) with a dedicated test user and a sandbox project. Requires passwordless
// root sudo (the host convention); skips cleanly otherwise.
//
// Run: node scripts/test-protect.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pathModule from "node:path";
import { spawnSync, spawn } from "node:child_process";

const SKILL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PROTECT = path.join(SKILL_DIR, "scripts", "lib", "protect.mjs");
const WRAPPER = path.join(SKILL_DIR, "scripts", "lib", "child-wrapper.mjs");
const NODE = process.execPath;
const ME = os.userInfo().username;

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.log(`  FAIL: ${label}`); }
}
function sh(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: opts.timeout || 60000, ...opts });
  if (r.error) return { code: -1, out: "", err: r.error.message };
  return { code: r.status ?? -1, out: r.stdout || "", err: r.stderr || "" };
}
function j(o) { try { return JSON.parse(o); } catch { return {}; } }
function sq(s) { return `'${String(s).replaceAll("'", "'\\''")}'`; }
function asUser(user, s) { return sh("sudo", ["-n", "-u", user, "/bin/sh", "-c", s]); }

const TEST_USER = "pisuptest";
const SB = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sup-protect-test-"));


function main() {
  console.log(`pi-supervisor kernel-protection suite\n  sandbox: ${SB}\n`);

  const root = sh("sudo", ["-n", "true"]);
  if (root.code !== 0) {
    console.log("SKIP: passwordless root sudo unavailable — kernel-protection suite requires it.");
    console.log("\nSKIP (no root): pass=0 fail=0");
    return { pass: 0, fail: 0, skipped: true };
  }

  // Fresh test user (remove leftovers from a prior crashed run).
  sh("sudo", ["-n", "userdel", "-r", TEST_USER]);
  const um = sh("sudo", ["-n", "useradd", "-m", "-s", "/bin/bash", TEST_USER]);
  ok(um.code === 0, "test user created");
  const dropin = `/etc/sudoers.d/pi-supervisor-${TEST_USER}`;
  sh("sudo", ["-n", "rm", "-f", dropin]); // stale drop-in would break firstRun + rules

  // ---- fixtures -----------------------------------------------------------
  const proj = path.join(SB, "proj");
  fs.mkdirSync(path.join(proj, ".pi-supervisor", "runs", "auth"), { recursive: true });
  fs.writeFileSync(path.join(proj, "TASK.md"), "task\n");

  const nodeBinDir = path.dirname(NODE); // real node dir → secure_path + ACL
  const fakeRelease = path.join(SB, "release", "node_modules", "@earendil-works", "pi-coding-agent");
  fs.mkdirSync(path.join(fakeRelease, "dist", "bundle"), { recursive: true });
  const fakeCli = path.join(fakeRelease, "dist", "bundle", "cli.js");
  fs.writeFileSync(fakeCli, `
'use strict';
const a = process.argv.slice(2);
if (a.includes("--uid-test")) {
  const { execSync } = require("node:child_process");
  const uid = execSync("id -u").toString().trim();
  const user = execSync("id -un").toString().trim();
  console.log("uid=" + uid + " user=" + user + " HOME=" + process.env.HOME + " PI_SUP_CHILD=" + (process.env.PI_SUP_CHILD || "-"));
  process.exit(0);
}
const ei = a.indexOf("--exit");
if (ei >= 0) process.exit(parseInt(a[ei + 1], 10));
const si = a.indexOf("--sleep");
if (si >= 0) { console.log("sleeper-started"); setTimeout(() => {}, parseInt(a[si + 1], 10) * 1000); }
console.log("fakecli ready");
setTimeout(() => {}, 300000);
`);
  const fakePi = path.join(SB, "pi-fake");
  fs.writeFileSync(fakePi, `#!/bin/sh\necho "fakepi uid=$(id -u) user=$(id -un)"\n`);
  fs.chmodSync(fakePi, 0o755);

  const liveRun = path.join(proj, ".pi-supervisor", "runs", "auth", "run-1");
  fs.mkdirSync(liveRun, { recursive: true });

  const applyArgs = (extra = []) => ["apply", "--project", proj, "--user", TEST_USER, "--pi-bin", fakePi, "--real-cli", fakeCli, "--node", NODE, "--node-bin-dir", nodeBinDir, "--live", liveRun, ...extra];

  // ---- S1: apply + idempotency --------------------------------------------
  console.log("S1: apply");
  let r = sh(NODE, [PROTECT, ...applyArgs()]);
  let a1 = j(r.out);
  ok(a1.ok === true, `apply ok (${a1.error || ""})`);
  if (!a1.ok) { console.log(r.err); process.exit(1); }
  ok(a1.firstRun === true, "firstRun flag");
  ok(fs.existsSync(dropin), "sudoers drop-in installed");
  const visudo = sh("sudo", ["-n", "visudo", "-cf", dropin]);
  ok(visudo.code === 0, "drop-in passes visudo -c");

  r = sh(NODE, [PROTECT, ...applyArgs()]);
  let a2 = j(r.out);
  ok(a2.ok === true && a2.firstRun === false, "re-apply idempotent (firstRun=false)");
  ok(a2.actions.every((x) => !x.includes("→") || x.includes("current")), "re-apply adds no ACL actions");

  // ---- S2: child identity + config ----------------------------------------
  console.log("S2: child identity");
  let c = asUser(TEST_USER, "id -un; echo HOME=$HOME");
  ok(c.out.trim() === `${TEST_USER}\nHOME=/home/${TEST_USER}`, "child runs as test user with own HOME");
  c = asUser(TEST_USER, `test -r $HOME/.pi/agent/auth.json && echo auth-ok`);
  ok(c.out.includes("auth-ok"), "child can read synced auth.json");
  c = asUser(TEST_USER, `cd / && test -f $HOME/.gitconfig && git config --global user.name`);
  ok(c.out.includes(TEST_USER), "child git identity configured");

  // ---- S3: kernel protection holds -----------------------------------------
  console.log("S3: kernel protection");
  c = asUser(TEST_USER, `rm -rf ${sq(proj)}/.pi-supervisor; echo rc=$?`);
  ok(c.out.includes("rc=") && !c.out.includes("rc=0") && fs.existsSync(path.join(proj, ".pi-supervisor")), "child rm -rf .pi-supervisor BLOCKED (tree intact)");
  c = asUser(TEST_USER, `mv ${sq(proj)}/.pi-supervisor /tmp/stash-psup; echo rc=$?`);
  ok(!c.out.includes("rc=0") && fs.existsSync(path.join(proj, ".pi-supervisor")), "child mv .pi-supervisor BLOCKED (bind mount)");
  const oldRun = path.join(proj, ".pi-supervisor", "runs", "auth", "run-0");
  fs.mkdirSync(oldRun, { recursive: true });
  c = asUser(TEST_USER, `rm -rf ${sq(oldRun)}; echo rc=$?`);
  ok(!c.out.includes("rc=0"), "child rm of an older run dir BLOCKED (r-x)");
  c = asUser(TEST_USER, `touch ${sq(liveRun)}/child-file && echo ok`);
  ok(c.out.includes("ok"), "child writes in live run-N dir (rwx)");
  c = asUser(TEST_USER, `touch ${sq(proj + "/.pi-supervisor")}/top-file; echo rc=$?`);
  ok(!c.out.includes("rc=0"), "child write at .pi-supervisor top BLOCKED");
  const sessDir = path.join(proj, ".pi-supervisor", "sessions");
  c = asUser(TEST_USER, `mkdir -p ${sq(sessDir)}/s1 && touch ${sq(sessDir)}/s1/x.jsonl && echo ok`);
  ok(c.out.includes("ok"), "child writes in sessions dir");

  // ---- S4: kill rule -------------------------------------------------------
  console.log("S4: kill rule");
  const sleeper = spawn("sudo", ["-n", "-u", TEST_USER, NODE, fakeCli, "--sleep", "60"], { stdio: "ignore" });
  sleeper.unref();
  sh("sleep", ["1.5"]);
  const pgrep = sh("pgrep", ["-u", TEST_USER, "-f", `node ${fakeCli} --sleep`]);
  const spid = pgrep.out.trim().split("\n")[0];
  ok(!!spid, `sleeper child started (pid ${spid || "?"})`);
  if (spid) {
    const kill = sh("sudo", ["-n", "-u", TEST_USER, "/usr/bin/kill", "-TERM", spid]);
    ok(kill.code === 0, "child-user kill rule works (sudo kill)");
    sh("sleep", ["0.5"]);
    const still = sh("pgrep", ["-u", TEST_USER, "-f", `node ${fakeCli} --sleep`]);
    ok(!still.out.trim(), "sleeper dead after kill");
  }

  // ---- S5: env_keep through sudo -------------------------------------------
  console.log("S5: env_keep");
  c = sh("sudo", ["-n", "-u", TEST_USER, "/bin/sh", "-c", "echo v=$PI_SUP_CHILD"], { env: { ...process.env, PI_SUP_CHILD: "1" } });
  ok(c.out.trim() === "v=1", "PI_SUP_CHILD crosses sudo (env_keep)");

  // ---- S5b: --sudo grant (opt-in child root) --------------------------------
  console.log("S5b: --sudo");
  r = sh(NODE, [PROTECT, ...applyArgs(["--sudo"])]);
  let asu = j(r.out);
  ok(asu.ok === true, `apply --sudo ok (${asu.error || ""})`);
  let dp = sh("sudo", ["-n", "cat", dropin]).out; // drop-in is root:root 0440
  ok(dp.includes(`${TEST_USER} ALL=(ALL) NOPASSWD: ALL`), "drop-in grants child root with --sudo");
  let priv = asUser(TEST_USER, "sudo -n true; echo rc=$?");
  ok(priv.out.includes("rc=0"), "child sudo (root) works with --sudo");
  r = sh(NODE, [PROTECT, ...applyArgs()]);
  asu = j(r.out);
  ok(asu.ok === true, `re-apply without --sudo ok (${asu.error || ""})`);
  dp = sh("sudo", ["-n", "cat", dropin]).out;
  ok(!dp.includes("ALL=(ALL)"), "child root rule revoked on plain re-apply");
  priv = asUser(TEST_USER, "sudo -n true; echo rc=$?");
  ok(!priv.out.includes("rc=0"), "child sudo denied after revocation");

  // ---- S6: wrapper e2e ------------------------------------------------------
  console.log("S6: child wrapper");
  let w = spawnSync(NODE, [WRAPPER, "--uid-test"], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, PI_SUP_CHILD_USER: TEST_USER, PI_SUP_REAL_CLI: fakeCli, PI_SUP_CHILD: "1" },
  });
  ok(w.status === 0, `wrapper exit 0 on success (got ${w.status})`);
  ok(w.stdout.includes(`user=${TEST_USER}`), "wrapper child ran as test user");
  ok(w.stdout.includes("PI_SUP_CHILD=1"), "wrapper env passed through");
  ok(w.stdout.includes(`HOME=/home/${TEST_USER}`), "child HOME is test user home");

  w = spawnSync(NODE, [WRAPPER, "--exit", "42"], {
    encoding: "utf8", timeout: 30000,
    env: { ...process.env, PI_SUP_CHILD_USER: TEST_USER, PI_SUP_REAL_CLI: fakeCli },
  });
  ok(w.status === 42, `wrapper forwards exit code 42 (got ${w.status})`);

  const pgidFile = path.join(SB, "pgid");
  const wp = spawn(NODE, [WRAPPER, "--sleep", "300"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_SUP_CHILD_USER: TEST_USER, PI_SUP_REAL_CLI: fakeCli, PI_SUP_PIDFILE: pgidFile },
  });
  sh("sleep", ["2"]);
  const g = fs.existsSync(pgidFile) ? parseInt(fs.readFileSync(pgidFile, "utf8").trim(), 10) : 0;
  ok(g > 0, `pidfile written (group ${g || "none"})`);
  let cliPid = "";
  if (g) {
    const ch = fs.existsSync(`/proc/${g}/task/${g}/children`) ? fs.readFileSync(`/proc/${g}/task/${g}/children`, "utf8").trim() : "";
    cliPid = ch.split(/\s+/).find((p) => p !== g) || "";
    ok(!!cliPid, "group has sudo+cli members");
  }
  if (g && fs.existsSync(`/proc/${g}`)) {
    process.kill(g, "SIGTERM");
    let wrc = null;
    const wt = setTimeout(() => wp.kill("SIGKILL"), 6000);
    wp.on("exit", (code) => { wrc = code; });
    sh("sleep", ["2"]);
    if (wrc == null) wp.kill("SIGKILL");
    sh("sleep", ["0.5"]);
    const grpGone = !fs.existsSync(`/proc/${g}`);
    const leftovers = sh("pgrep", ["-u", TEST_USER, "-f", `node ${fakeCli} --sleep`]);
    ok(grpGone, "SIGTERM on group leader kills wrapper group");
    ok(!leftovers.out.trim(), "no leftover sleeper child after group kill");
    clearTimeout(wt);
  }

  // ---- S7: unprotect restores -----------------------------------------------
  console.log("S7: unprotect");
  // Remove child-owned files AS THE CHILD first — unprotect about to run
  // deletes the /bin/sh sudo rule, after which the child user is unreachable.
  asUser(TEST_USER, `rm -rf ${sq(liveRun)} ${sq(sessDir)}`);
  r = sh(NODE, [PROTECT, "unprotect", "--project", proj, "--user", TEST_USER, "--pi-bin", fakePi, "--real-cli", fakeCli, "--node-bin-dir", nodeBinDir, "--live", liveRun]);
  let u = j(r.out);
  ok(u.ok === true, `unprotect ok (${u.error || ""})`);
  ok(u.actions.some((x) => x.includes("drop-in removed")), "sudoers drop-in removed");
  ok(u.actions.some((x) => x.includes("bind mount removed")), "bind mount removed");
  ok(!fs.existsSync(dropin), "drop-in file gone");
  const acl = sh("getfacl", ["-p", path.join(proj, ".pi-supervisor")]);
  ok(!acl.out.includes(`user:${TEST_USER}:`), "project ACLs removed");
  ok(sh("rm", ["-rf", path.join(proj, ".pi-supervisor")]).code === 0, "owner rm -rf works after unprotect");
  sh("sudo", ["-n", "userdel", "-r", TEST_USER]);
  fs.rmSync(SB, { recursive: true, force: true });

  console.log(`\npi-supervisor kernel-protection: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

try {
  main();
} catch (e) {
  console.error("suite crashed:", e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
  fs.rmSync(SB, { recursive: true, force: true });
  process.exit(1);
}
