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
const GUARD = path.join(SKILL_DIR, "scripts", "guard.mjs");
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

// fs.rmSync's force skips ENOENT but EACCES still throws — the S5c sysbin dir is root-owned.
function cleanSb() {
  try { sh("sudo", ["-n", "rm", "-rf", path.join(SB, "sysbin")], { timeoutMs: 10000 }); } catch {}
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch {}
}

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
  // models-store.json carries the custom provider DEFINITIONS (e.g. llama.cpp)
  // that the inherited --provider/--model reference — without it the child's pi
  // dies with "Unknown provider llama.cpp" (run28, 2026-11-04).
  const ownerStore = path.join(os.homedir(), ".pi", "agent", "models-store.json");
  if (fs.existsSync(ownerStore)) {
    const childMd5 = asUser(TEST_USER, `md5sum $HOME/.pi/agent/models-store.json 2>/dev/null | cut -d' ' -f1`).out.trim();
    const ownerMd5 = sh("md5sum", [ownerStore]).out.trim().split(/\s+/)[0];
    ok(!!childMd5 && childMd5 === ownerMd5, "child's models-store.json matches the owner's (custom providers resolvable)");
  } else {
    ok(true, "models-store sync (owner has no models-store.json — skipped)");
  }
  c = asUser(TEST_USER, `cd / && test -f $HOME/.gitconfig && git config --global user.name`);
  ok(c.out.includes(TEST_USER), "child git identity configured");

  // ---- S2b: safe.directory multi-value regression ----------------------------
  // (2026-11-05, TestProject) The child's global config already held multiple
  // safe.directory values; ensureGitConfig then wrote a plain single value,
  // which git refuses when the key has multiple values ("cannot overwrite
  // multiple values with a single value") — every protected run for a NEW
  // project hard-failed in preflight. The write must be `git config --add`
  // (the have-check above guarantees the value is new, so no duplicates).
  {
    const safeA = path.join(SB, "safe-a"), safeB = path.join(SB, "safe-b");
    fs.mkdirSync(safeA, { recursive: true });
    fs.mkdirSync(safeB, { recursive: true });
    asUser(TEST_USER, `cd / && git config --global --unset-all safe.directory 2>/dev/null; git config --global --add safe.directory ${sq(safeA)} && git config --global --add safe.directory ${sq(safeB)}`);
    const g0 = asUser(TEST_USER, `cd / && git config --global --get-all safe.directory 2>/dev/null | wc -l`);
    ok(g0.out.trim() === "2", "fixture: multi-value safe.directory (2 values, project absent)");
    r = sh(NODE, [PROTECT, ...applyArgs()]);
    let a3 = j(r.out);
    ok(a3.ok === true, `apply with multi-value safe.directory ok (${a3.error || ""})`);
    const g1 = asUser(TEST_USER, `cd / && git config --global --get-all safe.directory | grep -Fx ${sq(proj)} | wc -l`);
    ok(g1.out.trim() === "1", "project dir appended to multi-value safe.directory exactly once");
  }

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
  // v0.29.0: PI_OFFLINE must cross too (child-wrapper sets it after a verified
  // child package sync so pi's own session-start check stays off).
  c = sh("sudo", ["-n", "-u", TEST_USER, "/bin/sh", "-c", "echo v=$PI_OFFLINE"], { env: { ...process.env, PI_OFFLINE: "1" } });
  ok(c.out.trim() === "v=1", "PI_OFFLINE crosses sudo (env_keep)");
  let dp0 = sh("sudo", ["-n", "cat", dropin]).out;
  ok(/\/usr\/bin\/git \*|\/usr\/local\/bin\/git \*|\/bin\/git \*/.test(dp0), "drop-in Cmnd_Alias includes the git binary (child package sync)");
  ok(dp0.includes("PI_OFFLINE"), "drop-in env_keep lists PI_OFFLINE");

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

  // ---- S5c: non-owner (system) node tree rejected fast ----------------------
  console.log("S5c: system node tree rejected");
  const sysbin = path.join(SB, "sysbin");
  sh("sudo", ["-n", "mkdir", "-p", sysbin]);
  sh("sudo", ["-n", "touch", path.join(sysbin, "node")]); // root-owned dir + file
  let sys = sh(NODE, [PROTECT, "apply", "--project", proj, "--user", TEST_USER, "--pi-bin", fakePi, "--real-cli", fakeCli, "--node", path.join(sysbin, "node"), "--node-bin-dir", sysbin, "--live", liveRun]);
  ok(sys.code !== 0 && /ungrantable/i.test(sys.err), "apply with root-owned node bin dir fails fast");
  ok(!sys.err.includes("Operation not permitted"), "no raw setfacl EPERM storm");

  // ---- S7: guard.mjs module-eval under protection ----------------------------
  // Regression: outDir was initialized BELOW the protected-child block (TDZ →
  // ReferenceError on every protected run; suites never caught it because they
  // opt out via PI_SUP_NO_PROTECT). The stub package's index.js exits 42 the
  // moment guard imports it — reaching the import proves module-eval survived
  // the protected-child block, with no model touched.
  console.log("S7: guard module-eval with PI_SUP_CHILD_USER");
  const fakePkg = path.join(SB, "fakepkg");
  fs.mkdirSync(path.join(fakePkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(fakePkg, "dist", "index.js"),
    'console.log("STUB-LOADED"); process.exit(42);\nexport class RpcClient {}\n');
  fs.writeFileSync(path.join(fakePkg, "dist", "cli.js"), "// stub cli entry (guard resolves it before the import)\n");
  const guardTask = path.join(SB, "guard-task.md");
  fs.writeFileSync(guardTask, "stub task");
  const gr = sh(NODE, [GUARD, "--out-dir", path.join(SB, "gout"), "--task-file", guardTask],
    { timeout: 30000, env: { ...process.env, PI_PACKAGE_DIR: fakePkg, PI_SUP_CHILD_USER: "pichild" } });
  ok(gr.code === 42, "guard with child user reaches the (stub) RpcClient import");
  ok(gr.out.includes("STUB-LOADED") && !gr.err.includes("ReferenceError"), "no TDZ/crash during guard module-eval");

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

  // ---- S6b: owner package repo ACL (v0.29.0) --------------------------------
  console.log("S6b: owner package repo ACL");
  const pkgRepo = path.join(SB, "pkgrepo");
  sh("git", ["init", "-q", pkgRepo]);
  sh("git", ["-C", pkgRepo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"]);
  r = sh(NODE, [PROTECT, ...applyArgs()], { env: { ...process.env, PI_SUP_OWNER_PKG: pkgRepo } });
  let a24 = j(r.out);
  ok(a24.ok === true, `apply with PI_SUP_OWNER_PKG ok (${a24.error || ""})`);
  ok(a24.actions.some((x) => x.startsWith(pkgRepo + " ")), "repo rX action reported");
  const fa24 = sh("getfacl", ["-p", path.join(pkgRepo, ".git")]);
  ok(fa24.out.includes(`user:${TEST_USER}:`), "repo .git granted to child (umask-independent)");

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
  cleanSb();

  console.log(`\npi-supervisor kernel-protection: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

try {
  main();
} catch (e) {
  console.error("suite crashed:", e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e);
  cleanSb();
  process.exit(1);
}
