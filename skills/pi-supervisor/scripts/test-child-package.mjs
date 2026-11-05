#!/usr/bin/env node
// test-child-package.mjs — unit tests for lib/child-package.mjs (v0.29.0:
// the child user's pi package clone, synced from the owner's canonical repo).
//
//   - owner-repo / target resolution (derived + env overrides)
//   - fresh target → local clone (no network)
//   - at-HEAD no-op, ff on a new owner commit, dirty → reset, diverged → reset
//   - graceful skips (no user, not a git repo)
//   - the CLI (JSON line, exit code)
//
// All git ops are injected as direct execs (no sudo in unit tests): the
// semantics under test are the clone/fetch/ff/reset sequence, not the sudo
// plumbing.
//
// Run:  node test-child-package.mjs [--keep]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncChildPackage, deriveOwnerRepo } from "./lib/child-package.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KEEP = process.argv.includes("--keep");
const root = path.join(os.tmpdir(), `pi-sup-childpkg-${Date.now()}`);
mkdirSync(root, { recursive: true });

let pass = 0, fail = 0;
const ok = (cond, label, extra = "") => {
  if (cond) { pass++; console.log(`  ok    ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${extra ? " — " + extra : ""}`); }
};
const section = (t) => console.log(`\n== ${t}`);

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status == null ? -1 : r.status, out: (r.stdout || "") + (r.stderr || "") };
};
// injected asUser: direct exec (the tests run as a single OS user)
const asUser = (cmd, args) => sh(cmd, args);

function mkRepo(dir, file = "a.txt") {
  mkdirSync(dir, { recursive: true });
  sh("git", ["-C", dir, "init", "-q", "-b", "main"]);
  sh("git", ["-C", dir, "config", "user.email", "t@t"]);
  sh("git", ["-C", dir, "config", "user.name", "t"]);
  sh("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  sh("git", ["-C", dir, "config", "core.hooksPath", "/dev/null"]);
  writeFileSync(path.join(dir, file), "v1\n");
  sh("git", ["-C", dir, "add", "-A"]);
  sh("git", ["-C", dir, "commit", "-qm", "c1"]);
  return dir;
}
const head = (dir) => sh("git", ["-C", dir, "rev-parse", "HEAD"]).out.trim();
const newCommit = (dir, n) => {
  writeFileSync(path.join(dir, "a.txt"), `v${n}\n`);
  sh("git", ["-C", dir, "add", "-A"]);
  sh("git", ["-C", dir, "commit", "-qm", `c${n}`]);
  return head(dir);
};

// The user must exist (homedir lookup is real) — the test runner itself;
// asUser is injected so no sudo is needed for P2–P7.
const USER = os.userInfo().username;

// --------------------------------------------------------------------------
section("P1 — resolution + graceful skips");
{
  const notGit = path.join(root, "notgit");
  mkdirSync(notGit, { recursive: true });
  let r = syncChildPackage({ user: USER, ownerRepo: notGit, target: path.join(root, "t1"), asUser });
  ok(r.ok === false && /not a git worktree/.test(r.reason), "owner dir without .git → ok:false with reason", JSON.stringify(r));
  r = syncChildPackage({ ownerRepo: notGit, asUser });
  ok(r.ok === false && /no user/.test(r.reason), "missing user → ok:false", JSON.stringify(r));
  r = syncChildPackage({ user: "no-such-user-xyz-12345", ownerRepo: path.join(root, "repo"), asUser });
  ok(r.ok === false && /no such user/.test(r.reason), "unknown user → ok:false (getent)", JSON.stringify(r));
  const fakeLib = path.join(root, "repo", "skills", "pi-supervisor", "scripts", "lib");
  mkdirSync(fakeLib, { recursive: true });
  ok(deriveOwnerRepo(fakeLib) === path.join(root, "repo"), "deriveOwnerRepo walks 4 levels up from scripts/lib");
}

// --------------------------------------------------------------------------
section("P2 — fresh target → local clone");
{
  const owner = mkRepo(path.join(root, "owner-fresh"));
  const target = path.join(root, "child-fresh");
  const r = syncChildPackage({ user: USER, ownerRepo: owner, target, asUser });
  ok(r.ok && r.offline === true, "fresh sync ok + offline");
  ok(r.target === target, "target resolved as given");
  ok(head(target) === head(owner), "clone lands at owner HEAD");
  const origin = sh("git", ["-C", target, "remote", "get-url", "origin"]).out.trim();
  ok(origin === owner, "clone origin is the LOCAL owner repo (never github)", origin);
}

// --------------------------------------------------------------------------
section("P3 — at-HEAD no-op");
{
  const owner = mkRepo(path.join(root, "owner-noop"));
  const target = path.join(root, "child-noop");
  const r1 = syncChildPackage({ user: USER, ownerRepo: owner, target, asUser });
  const before = head(target);
  const r2 = syncChildPackage({ user: USER, ownerRepo: owner, target, asUser });
  ok(r1.ok && r2.ok && r2.dirty === false, "second sync is a no-op (dirty:false)");
  ok(head(target) === before, "HEAD untouched");
}

// --------------------------------------------------------------------------
section("P4 — ff on a new owner commit");
{
  const owner = mkRepo(path.join(root, "owner-ff"));
  const target = path.join(root, "child-ff");
  const r1 = syncChildPackage({ user: USER, ownerRepo: owner, target, asUser });
  const want = newCommit(owner, 2);
  const r2 = syncChildPackage({ user: USER, ownerRepo: owner, target, asUser });
  ok(r1.ok && r2.ok, "both syncs ok");
  ok(head(target) === want, "target ff'd to the new owner HEAD");
  ok(sh("git", ["-C", target, "log", "--oneline", "-1"]).out.includes("c2"), "the new commit is present");
}

// --------------------------------------------------------------------------
section("P5 — dirty target → reset (cache semantics)");
{
  const owner = mkRepo(path.join(root, "owner-dirty"));
  const target = path.join(root, "child-dirty");
  syncChildPackage({ user: USER, ownerRepo: owner, target, asUser });
  const want = newCommit(owner, 2);
  writeFileSync(path.join(target, "rogue.txt"), "leftover\n"); // UNTRACKED — the dirty case
  const r = syncChildPackage({ user: USER, ownerRepo: owner, target, asUser });
  ok(r.ok && r.dirty === true, "reported dirty");
  ok(head(target) === want, "reset to owner HEAD (local-only commit gone)");
  ok(sh("git", ["-C", target, "status", "--porcelain"]).out.trim() === "", "target clean after sync");
  ok(!fs.existsSync(path.join(target, "rogue.txt")), "committed leftovers reset away");
}

// --------------------------------------------------------------------------
section("P6 — diverged (non-ff) clean target → reset");
{
  const owner = mkRepo(path.join(root, "owner-div"));
  const target = path.join(root, "child-div");
  syncChildPackage({ user: USER, ownerRepo: owner, target, asUser });
  const want = newCommit(owner, 2);
  newCommit(target, "local"); // target has its own commit → ff refused
  const r = syncChildPackage({ user: USER, ownerRepo: owner, target, asUser });
  ok(r.ok, "sync ok");
  ok(head(target) === want, "non-ff → reset --hard FETCH_HEAD");
}

// --------------------------------------------------------------------------
section("P7 — env overrides + derived defaults");
{
  const owner = mkRepo(path.join(root, "owner-env"));
  const target = path.join(root, "child-env");
  const saved = { o: process.env.PI_SUP_OWNER_PKG, t: process.env.PI_SUP_CHILD_PKG };
  process.env.PI_SUP_OWNER_PKG = owner;
  process.env.PI_SUP_CHILD_PKG = target;
  try {
    const r = syncChildPackage({ user: USER, asUser });
    ok(r.ok && r.target === target && head(target) === head(owner), "PI_SUP_OWNER_PKG / PI_SUP_CHILD_PKG honored");
  } finally {
    if (saved.o == null) delete process.env.PI_SUP_OWNER_PKG; else process.env.PI_SUP_OWNER_PKG = saved.o;
    if (saved.t == null) delete process.env.PI_SUP_CHILD_PKG; else process.env.PI_SUP_CHILD_PKG = saved.t;
  }
}

// --------------------------------------------------------------------------
section("P8 — CLI: JSON line + exit code");
{
  const owner = mkRepo(path.join(root, "owner-cli"));
  const target = path.join(root, "child-cli");
  const cli = path.join(__dirname, "lib", "child-package.mjs");
  const r = spawnSync(process.execPath, [cli, "sync", "--user", USER, "--owner-repo", owner, "--target", target], { encoding: "utf8" });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout.trim().split("\n").pop() || "{}"); } catch { /* assert below */ }
  ok(r.status === 0, "exit 0 on ok", `status=${r.status} out=${r.stdout} err=${r.stderr}`);
  ok(parsed && parsed.ok === true && parsed.offline === true && parsed.head === head(owner), "stdout is one JSON line with ok/offline/head", r.stdout);
  ok(parsed && parsed.target === target, "target echoed");
  const r2 = spawnSync(process.execPath, [cli, "sync", "--user", USER, "--owner-repo", path.join(root, "nope"), "--target", target], { encoding: "utf8" });
  let p2 = null;
  try { p2 = JSON.parse(r2.stdout.trim().split("\n").pop() || "{}"); } catch { /* below */ }
  ok(r2.status === 1 && p2 && p2.ok === false, "exit 1 + ok:false on a bad owner repo", `status=${r2.status} out=${r2.stdout}`);
}

// --------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (!KEEP) rmSync(root, { recursive: true, force: true });
else console.log(`(kept: ${root})`);
process.exit(fail ? 1 : 0);
