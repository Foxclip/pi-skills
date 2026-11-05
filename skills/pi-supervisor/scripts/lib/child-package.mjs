#!/usr/bin/env node
// child-package.mjs — sync the child user's pi package clone from the owner's
// canonical repo, so that EVERY pi session running as the child user (the
// supervised child, and the monitor's parent judgment/final-report sessions
// through pi-as-child.sh) uses the repo in the CHILD home — at the exact
// committed code the orchestrator is running.
//
// Why: the child runs with HOME=/home/<child>, so pi loads the
// git:github.com/Foxclip/pi-skills package from
//   <childHome>/.pi/agent/git/github.com/Foxclip/pi-skills
// — a separate clone of the owner's canonical checkout (the one ralph.sh
// orchestrates from). Without this sync that clone only ever moves when pi's
// own session-start package check runs — which fetches the REMOTE and
// `git reset --hard origin/<branch>`s, i.e. the child would run origin/main,
// not the code being orchestrated (when the owner is unpushed ahead).
//
// Sync semantics (all git ops run AS the child user via `sudo -n -u <user>`;
// writes must land child-owned or the clone becomes unwritable by the child):
//   1. target missing  → `git clone <ownerRepo> <target>` (LOCAL clone — the
//      clone's origin is the owner's checkout, never github; no network needed)
//   2. `git fetch <ownerRepo> HEAD`
//   3. clean → `merge --ff-only FETCH_HEAD`; dirty or non-ff → `reset --hard
//      FETCH_HEAD` (the clone is a cache of the owner's committed state)
//   4. verify `HEAD == ownerRepo HEAD` → offline:true
//
// No passwordless root for the child user → graceful skip (ok:false, reason)
// — pi's own online session-start check then covers the clone, exactly
// today's behavior. Callers set PI_OFFLINE=1 only when offline:true, so pi's
// start-up check cannot re-align the clone to the remote mid-run.
//
// Callers: child-wrapper.mjs (before every child spawn, best effort),
// ralph.sh protected bootstrap (fresh/attach/repair, status line).
//
// CLI: node child-package.mjs sync --user <u> [--owner-repo <p>] [--target <p>]
//      → one JSON line to stdout {ok, offline, target, head, ownerHead, dirty,
//        reason}; exit 0 iff ok.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status == null ? -1 : r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// The canonical repo is 4 levels up from scripts/lib: .../pi-skills.
export function deriveOwnerRepo(here = __dirname) {
  // <repo>/skills/pi-supervisor/scripts/lib → 4 up = <repo>
  return path.resolve(here, "..", "..", "..", "..");
}

export function syncChildPackage(opts = {}) {
  const { user, ownerRepo, target: targetOpt, asUser, log = () => {} } = opts;
  const notOk = (reason, extra = {}) => Object.assign({ ok: false, offline: false, reason }, extra);
  if (!user) return notOk("no user");
  // getent, not os.userInfo(): Node's passwd lookup returned the CALLER's
  // homedir for an existing user on this host (pichild → /home/foxclip),
  // which would silently sync the wrong directory. getent is the pattern
  // protect.mjs already trusts (homeOf).
  const pw = sh("getent", ["passwd", user]);
  const fields = pw.code === 0 ? pw.out.trim().split(":") : [];
  const childHome = fields.length > 5 ? fields[5] : null;
  if (!childHome) return notOk(`no such user (getent): ${user}`);

  const ownerRepoPath = path.resolve(ownerRepo || process.env.PI_SUP_OWNER_PKG || deriveOwnerRepo());
  if (!fs.existsSync(path.join(ownerRepoPath, ".git"))) return notOk(`owner repo is not a git worktree: ${ownerRepoPath}`);
  const owner = sh("git", ["-C", ownerRepoPath, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (owner.code !== 0 || !owner.out.trim()) return notOk(`cannot read owner HEAD in ${ownerRepoPath}: ${owner.out.trim()}`);
  const ownerHead = owner.out.trim();
  const ownerHome = os.userInfo().homedir;
  const target = path.resolve(
    targetOpt ||
      process.env.PI_SUP_CHILD_PKG ||
      path.join(childHome, path.relative(ownerHome, ownerRepoPath))
  );

  const run = asUser || ((cmd, args) => sh("sudo", ["-n", "-u", user, cmd, ...args]));
  const git = (args, cwd) => run("git", ["-C", cwd, ...args]);

  // Probe exactly what we need (git, allowed on the scoped drop-in host); no
  // passwordless root → graceful skip, never a failed launch.
  if (run("git", ["--version"]).code !== 0) {
    return notOk(`cannot run git as '${user}' (no passwordless root) — the child's pi will self-sync online at start`);
  }

  // The existence probe must run AS THE CHILD — the owner process cannot see
  // into a 700 child home (fs.existsSync would say "missing" and the clone
  // into the non-empty dir would then fail on the child side).
  const probe = run("sh", ["-c", `[ -d "${target}/.git" ] && echo repo || { [ -e "${target}" ] && echo exists || echo missing; }`], []);
  const probeState = probe.code === 0 ? probe.out.trim().split("\n").pop() : "";
  if (probeState === "missing") {
    const mk = run("sh", ["-c", `mkdir -p "${path.dirname(target)}"`], []);
    if (mk.code !== 0) return notOk(`mkdir -p ${path.dirname(target)} failed as '${user}'`);
    const clone = run("git", ["clone", "--quiet", ownerRepoPath, target]);
    if (clone.code !== 0) return notOk(`clone failed: ${clone.out.trim().slice(0, 200)}`);
  } else if (probeState !== "repo") {
    return notOk(`target exists but is not a git repo (a pi install in progress?): ${target}`);
  }
  const headNow = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], target);
  if (headNow.code !== 0 || !headNow.out.trim()) return notOk(`target is not a git worktree: ${target}`);
  if (headNow.out.trim() === ownerHead) {
    return { ok: true, offline: true, target, head: ownerHead, ownerHead, dirty: false };
  }
  const fetch = git(["fetch", "--quiet", ownerRepoPath, "HEAD"], target);
  if (fetch.code !== 0) return notOk(`fetch from owner repo failed: ${fetch.out.trim().slice(0, 200)}`);
  const status = git(["status", "--porcelain"], target);
  if (status.code !== 0) return notOk(`status failed in ${target}: ${status.out.trim().slice(0, 200)}`);
  const dirty = status.out.trim().length > 0;
  let advanced = false;
  if (!dirty) {
    const ff = git(["merge", "--ff-only", "--quiet", "FETCH_HEAD"], target);
    advanced = ff.code === 0;
    if (!advanced) log(`ff-only refused (${ff.out.trim().slice(0, 120)}) — resetting the child package cache`);
  }
  if (!advanced) {
    const reset = git(["reset", "--hard", "FETCH_HEAD"], target);
    if (reset.code !== 0) return notOk(`reset failed in ${target}: ${reset.out.trim().slice(0, 200)}`);
    // The clone is a CACHE of the owner's committed state — stray files
    // (crashed installs, test leftovers) are garbage here too.
    const clean = git(["clean", "-fdq"], target);
    if (clean.code !== 0) log(`clean after reset: ${clean.out.trim().slice(0, 120)}`);
  }
  const headAfter = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], target);
  if (headAfter.code !== 0 || headAfter.out.trim() !== ownerHead) {
    return notOk(`sync could not land on owner HEAD: got ${headAfter.out.trim() || "(none)"} want ${ownerHead}`, { target, ownerHead });
  }
  return { ok: true, offline: true, target, head: ownerHead, ownerHead, dirty };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const argv = process.argv.slice(2);
  const take = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const result = syncChildPackage({
    user: take("--user"),
    ownerRepo: take("--owner-repo"),
    target: take("--target"),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(result.ok ? 0 : 1);
}
