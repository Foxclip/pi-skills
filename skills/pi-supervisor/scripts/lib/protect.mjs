#!/usr/bin/env node
// Kernel-level protection for pi-supervisor run trees (v0.26.0).
//
// Problem this solves: a supervised child session runs with full shell access
// as the launching user. A sloppy cleanup command (rm -rf of the live run dir)
// destroys the run's ground truth — and nothing at the LLM layer (hooks,
// contract text) can be trusted to stop a same-uid process. This module moves
// the protection into the kernel, via Discretionary Access Control:
//
//   The child pi (and the parent's judgment/prepare pi turns) run as a
//   dedicated unprivileged OS user (PI_SUP_CHILD_USER, default "pichild")
//   through a scoped, passwordless sudoers rule owned by the launching user.
//   The run tree (.pi-supervisor) stays owned by the launching user at mode
//   700, plus a self bind-mount. The child user gets DAC grants ONLY where it
//   must work:
//
//     project dir               rwx   (its working surface)
//     .pi-supervisor            r-x   (traverse + list, never write)
//     .pi-supervisor/runs       ---x  (traverse only — contents hidden)
//     runs/<node> dirs          r-x   (readable: STATE.md, node.json)
//     live window dir (run-N)   rwx   (spawn-request, reports, scratch)
//     .pi-supervisor/sessions   rwx   (+ default ACL back to the owner)
//     pi release / pi-node trees rX   (execute pi + node)
//     --work-dirs               rwx   (repos the child must edit)
//
//   With no write grant on .pi-supervisor (or below it, except the live
//   window dir and sessions), the child can never unlink/rename/truncate
//   anything in the run tree. The self bind-mount additionally blocks
//   renaming/moving the .pi-supervisor dir entry itself (rm -rf of the
//   project dir cannot complete either, because the tree cannot be emptied).
//
//   Sudo surface (drop-in /etc/sudoers.d/pi-supervisor-<user>, managed):
//     Cmnd_Alias PI_SUP_CMDS_<USER> = <node> <realCli> *, <piBin> *, /usr/bin/kill *, /bin/sh *
//     <owner> ALL=(<user>) NOPASSWD: PI_SUP_CMDS_<USER>
//     [with --sudo]  <user> ALL=(ALL) NOPASSWD: ALL   # child gets root: protection is voidable
//     Defaults:<owner> env_keep += "PI_SUP_*"   (gate identity crosses sudo)
//     Defaults:<owner> secure_path = "<pi-node bin>:<standard paths>"
//   The child user itself has NO sudo rules — it cannot escalate.
//
//   First-time drop-in install and the bind mount need passwordless ROOT sudo
//   (broad `sudo -n`), as on this host. On hosts without it, those two steps
//   are one-time manual (messages printed); everything else is idempotent and
//   re-asserted on every `ralph.sh protect`.
//
// CLI:
//   node protect.mjs apply --project <d> --live <run-dir> --user <u> \
//       [--pi-bin <p>] [--real-cli <p>] [--node <p>] [--node-bin-dir <d>] \
//       [--work-dirs <a:b>]
//   node protect.mjs status --project <d> --user <u>
//   node protect.mjs unprotect --project <d> [--user <u>]
//
// Library exports: ensureProtection, protectionStatus, unprotect, sudoAvailable

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KILL_BIN = "/usr/bin/kill";
const SH_BIN = "/bin/sh";
const SUDOERS_D = "/etc/sudoers.d";
const ENV_KEEP_VARS = "PI_SUP_CHILD PI_SUP_RUN_DIR PI_SUP_NODE PI_SUP_PROJECT PI_SUP_WORK_DIRS PI_SUP_CHILD_USER";
const SECURE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return {
    code: r.status == null ? -1 : r.status,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
    error: r.error ? String(r.error) : "",
  };
}

function sudo(args, opts = {}) {
  return sh("sudo", ["-n", ...args], opts);
}

function sudoAs(user, cmdLine, opts = {}) {
  // Runs a shell line as `user` through the scoped `/bin/sh *` rule.
  return sudo(["-u", user, SH_BIN, "-c", cmdLine], opts);
}

export function sudoAvailable() {
  return sudo(["true"]).code === 0;
}

export function ownerUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER || "";
  }
}

function homeOf(user) {
  const r = sh("getent", ["passwd", user]);
  if (r.code !== 0) return null;
  return r.out.split(":")[5] || null;
}

function sq(s) {
  // single-quote for sh -c lines
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function sudoersPathFor(user) {
  return `${SUDOERS_D}/pi-supervisor-${user}`;
}

function dropinContent({ user, owner, nodePath, realCli, piBin, nodeBinDir, sudo }) {
  const alias = `PI_SUP_CMDS_${user.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const cmds = [];
  if (nodePath && realCli) cmds.push(`${nodePath} ${realCli} *`);
  if (piBin) cmds.push(`${piBin} *`);
  cmds.push(`${KILL_BIN} *`, `${SH_BIN} *`);
  const lines = [
    `# pi-supervisor kernel protection for '${user}' — MANAGED FILE, rewritten by ralph.sh protect.`,
    `# Grants the owner passwordless, scoped sudo AS '${user}': run the pi CLI (node bundle or`,
    `# launcher), signal processes, and run shell lines for provisioning. Without --sudo the`,
    `# child user itself has no sudo rules. Re-asserted idempotently on every window.`,
    `Cmnd_Alias ${alias} = ${cmds.join(", ")}`,
    `${owner} ALL=(${user}) NOPASSWD: ${alias}`,
    ...(sudo
      ? [
          `# EXPLICIT --sudo grant — the child has full root, so kernel protection is voidable`,
          `# from inside the run by design (audit the transcripts).`,
          `${user} ALL=(ALL) NOPASSWD: ALL`,
        ]
      : []),
    `Defaults:${owner} env_keep += "${ENV_KEEP_VARS}"`,
    `Defaults:${owner} secure_path = "${(nodeBinDir ? nodeBinDir + ":" : "")}${SECURE_PATH}"`,
  ];
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// components (each idempotent)
// ---------------------------------------------------------------------------

function ensureUser(user) {
  const r = sh("id", [user]);
  if (r.code === 0) return { ok: true, created: false, detail: `user '${user}' exists` };
  const a = sudo(["useradd", "-m", "-s", "/bin/bash", user]);
  if (a.code !== 0) return { ok: false, created: false, detail: `useradd failed: ${a.err || a.out}` };
  return { ok: true, created: true, detail: `user '${user}' created` };
}

function ensureSudoers(spec) {
  const content = dropinContent(spec);
  const dest = sudoersPathFor(spec.user);
  let existing = "";
  try {
    existing = fs.readFileSync(dest, "utf8");
  } catch {
    /* absent */
  }
  if (existing === content) return { ok: true, changed: false, detail: "sudoers drop-in current" };
  const tmp = path.join(os.tmpdir(), `pisup-sudoers-${process.pid}-${spec.user}`);
  fs.writeFileSync(tmp, content, { mode: 0o644 });
  const check = sh("visudo", ["-cf", tmp]);
  if (check.code !== 0) {
    fs.rmSync(tmp, { force: true });
    return { ok: false, changed: false, detail: `sudoers validation failed: ${check.err || check.out}` };
  }
  // Install: scoped rules cannot write /etc/sudoers.d, so this needs the host's
  // broad passwordless sudo. Keep the tmp file on failure so a human can copy it.
  const r = sudo(["install", "-o", "root", "-g", "root", "-m", "0440", tmp, dest]);
  if (r.code !== 0) {
    return {
      ok: false,
      changed: false,
      detail:
        `could not install sudoers drop-in (needs passwordless root sudo): ${r.err || "denied"}. ` +
        `Copy ${tmp} to ${dest} manually, then re-run ralph.sh protect.`,
    };
  }
  fs.rmSync(tmp, { force: true });
  return { ok: true, changed: true, detail: `sudoers drop-in installed: ${dest}` };
}

function ensureAgentConfig(user, piBin) {
  // The child's pi resolves its agent dir from ITS home (HOME is reset by
  // sudo), so model/auth config must exist there. We sync the owner's
  // auth.json (and models.json / settings.json when present) as base64 to
  // avoid any shell-quoting of secrets.
  const ownerAgent = path.join(os.homedir(), ".pi", "agent");
  const userHome = homeOf(user);
  if (!userHome) return { ok: false, detail: `no home for '${user}'` };
  const userAgent = path.join(userHome, ".pi", "agent");
  let r = sudoAs(user, `umask 077; mkdir -p ${sq(userAgent)}`);
  if (r.code !== 0) return { ok: false, detail: `cannot create agent dir: ${r.err}` };
  const synced = [];
  for (const f of ["auth.json", "models.json", "settings.json"]) {
    const src = path.join(ownerAgent, f);
    if (!fs.existsSync(src)) continue;
    const b64 = fs.readFileSync(src).toString("base64");
    r = sudoAs(user, `echo ${sq(b64)} | base64 -d > ${sq(path.join(userAgent, f))}`);
    if (r.code !== 0) return { ok: false, detail: `sync ${f} failed: ${r.err}` };
    synced.push(f);
  }
  // v0.26.1: prewarm the child's pi runtime. The child's FIRST launch
  // bootstraps the pi install into its own home (an npm install of ~200
  // packages, 30-60s+) — longer than the RPC client's hardcoded 30s
  // first-prompt response timeout, so an un-prewarmed child dies on its very
  // first prompt (run27, 2026-11-04). `pi --version` as the child triggers
  // that install; afterwards it is <1s and idempotent, and re-asserting on
  // every window self-heals a pi version bump. Failure is a warning, not a
  // hard fail — the guard's tolerant first prompt is the safety net.
  let detail = synced.length ? `agent config synced: ${synced.join(", ")}` : "no owner agent config to sync";
  if (piBin) {
    const pw = sudoAs(user, `${sq(piBin)} --version`, { timeout: 300000 });
    if (pw.code === 0) detail += `; pi runtime prewarmed${pw.out ? ` (${pw.out.slice(0, 40)})` : ""}`;
    else detail += `; WARN pi runtime prewarm failed (code=${pw.code}: ${(pw.err || pw.out).slice(0, 120)}) — first child launch may be slow`;
  }
  return { ok: true, detail };
}

function ensureGitConfig(user, dirs) {
  // The child edits owner-owned repos → git's dubious-ownership guard must
  // whitelist them, and commits need an identity (pichild home's .gitconfig).
  const name = process.env.PI_SUP_CHILD_GIT_NAME || user;
  const email = process.env.PI_SUP_CHILD_GIT_EMAIL || `${user}@localhost`;
  // cwd=/ on purpose: git stats the cwd, and at this point in ensureProtection
  // the DAC grants are not in place yet — the owner's tree is untraversable.
  const atRoot = { cwd: "/" };
  let r = sudoAs(user, `git config --global user.name ${sq(name)} && git config --global user.email ${sq(email)}`, atRoot);
  if (r.code !== 0) return { ok: false, detail: `git identity failed: ${r.err}` };
  const added = [];
  for (const d of dirs) {
    if (!d || !fs.existsSync(d)) continue;
    const have = sudoAs(user, `git config --global --get-all safe.directory 2>/dev/null | grep -Fxq ${sq(d)}`, atRoot);
    if (have.code === 0) continue;
    r = sudoAs(user, `git config --global safe.directory ${sq(d)}`, atRoot);
    if (r.code !== 0) return { ok: false, detail: `git safe.directory ${d}: ${r.err}` };
    added.push(d);
  }
  return { ok: true, detail: added.length ? `git safe.directory +${added.length} dir(s)` : "git config current" };
}

// <release>/node_modules/@earendil-works/... → the releases/<version> root.
function releaseRootOf(p) {
  const i = path.resolve(p).split("/").indexOf("releases");
  if (i >= 0 && i + 2 < 100) {
    const parts = path.resolve(p).split("/");
    const root = parts.slice(0, i + 2).join("/");
    if (fs.existsSync(root)) return root;
  }
  return null;
}

function aclSet(target, spec, perm) {
  // Skip when the exact grant already exists — re-applies (every window)
  // must stay no-ops so the action list is quiet and idempotency is visible.
  const g = sh("getfacl", ["-p", target]);
  if (g.code === 0 && g.out.split("\n").some((l) => l.trim() === `user:${spec.user}:${perm}`)) return;
  let r = sh("setfacl", ["-m", `u:${spec.user}:${perm}`, target]);
  if (r.code !== 0 && /not permitted|operation not permitted/i.test(r.err))
    r = sudo(["setfacl", "-m", `u:${spec.user}:${perm}`, target]); // root-owned target
  if (r.code !== 0) throw new Error(`setfacl u:${spec.user}:${perm} ${target}: ${r.err || "failed"}`);
  spec.actions.push(`${target} → u:${spec.user}:${perm}`);
}

function aclUnset(target, spec) {
  // `setfacl -x` only accepts the name form (u:name) — a u:name:perm entry
  // fails with rc=2 and the entry survives. Name form removes every access
  // AND default entry for that user on the target.
  sh("setfacl", ["-x", `u:${spec.user}`, target]);
  sh("setfacl", ["-d", "-x", `u:${spec.user}`, target]);
}

// Walk every component of targetPath from / down; grant the child user search
// (x) wherever it cannot already traverse. Probe as the child user, so we only
// touch what is actually blocking.
function aclChainX(spec, targetPath) {
  // Grant search (x) only on directory components. If the target is a file,
  // stop at its parent: an x-only named-user entry on a FILE would replace
  // its generic read access in the ACL check (named entries shadow other::),
  // which is exactly the EACCES-on-node-realcli failure we must avoid.
  let stop = String(targetPath);
  try {
    if (fs.statSync(stop).isFile()) stop = path.dirname(stop);
  } catch { /* keep as-is */ }
  const parts = [];
  let cur = "";
  for (const seg of stop.split("/").filter(Boolean)) {
    cur = cur === "" ? `/${seg}` : `${cur}/${seg}`;
    parts.push(cur);
  }
  for (const p of parts) {
    const probe = sudo(["-u", spec.user, SH_BIN, "-c", `test -x ${sq(p)}`]);
    if (probe.code === 0) continue;
    let r = sh("setfacl", ["-m", `u:${spec.user}:x`, p]); // owner-owned components
    if (r.code !== 0) r = sudo(["setfacl", "-m", `u:${spec.user}:x`, p]); // root-owned
    if (r.code !== 0) throw new Error(`cannot grant search (x) on ${p}: ${r.err || "failed"}`);
    spec.actions.push(`${p} → u:${spec.user}:x (search)`);
  }
}

function isRunDir(d) {
  return /^run(-|$)/.test(path.basename(d));
}

function findDirs(root) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      out.push(p);
      walk(p);
    }
  };
  walk(root);
  return out;
}

// Recursive rX over a tree (find/xargs: symlink-safe), sentinel-checked via
// the root's ACL so repeat applies are cheap.
function treeAcl(spec, root) {
  if (!root || !fs.existsSync(root)) return;
  // Fail fast on trees we cannot grant (e.g. a root-owned /usr/bin when the
  // system node won PATH): a recursive setfacl there is a wall of EPERM lines.
  const st = fs.statSync(root);
  const me = typeof process.getuid === "function" ? process.getuid() : -1;
  if (me !== 0 && st.uid !== me)
    throw new Error(
      `cannot grant ACLs over ${root} — owned by uid ${st.uid}, not the running user (uid ${me}). ` +
      `System paths (e.g. /usr/bin) are ungrantable: point --node / PI_SUP_NODE at an owner-owned node, or opt out with PI_SUP_NO_PROTECT=1`
    );
  const probe = sh("getfacl", ["-p", root]);
  if (probe.code === 0 && probe.out.includes(`user:${spec.user}:`)) return;
  const r = sh(SH_BIN, ["-c", `find ${sq(root)} \\( -type f -o -type d \\) -print0 | xargs -0 setfacl -m u:${spec.user}:rX 2>&1`]);
  if (r.code !== 0) {
    const first = (r.out || "").trim().split("\n").find(Boolean) || "setfacl failed";
    throw new Error(`setfacl over ${root} failed: ${first}`);
  }
  spec.actions.push(`${root} → u:${spec.user}:rX (recursive)`);
}

function bindMountSelf(spec, psup) {
  // Self bind-mount: the .pi-supervisor dir entry becomes un-renamable /
  // un-removable / un-mountable by anyone but root — closes the "mv the whole
  // tree" hole that DAC alone leaves (the child has w on the project dir).
  const mnt = sh("findmnt", ["--noheadings", "--output", "TARGET", psup]);
  if (mnt.code === 0 && mnt.out.trim()) return; // already mounted
  const r = sudo(["mount", "--bind", psup, psup]);
  if (r.code !== 0)
    throw new Error(
      `bind-mount of ${psup} failed (${r.err || r.out}); needs passwordless root sudo — mount --bind ${psup} ${psup} manually`
    );
  spec.actions.push(`${psup} → self bind-mount (rename/move blocked)`);
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

export function protectionStatus({ projectDir, user }) {
  const psup = path.join(projectDir, ".pi-supervisor");
  const runs = path.join(psup, "runs");
  const sessions = path.join(psup, "sessions");
  const st = {
    user: { exists: sh("id", [user]).code === 0 },
    sudoers: { present: false },
    psup: { exists: fs.existsSync(psup) },
    mount: { bound: false },
    acls: {},
  };
  try {
    st.sudoers.present = fs.existsSync(sudoersPathFor(user));
    if (st.sudoers.present)
      st.sudoers.childRoot = fs.readFileSync(sudoersPathFor(user), "utf8").includes("ALL=(ALL) NOPASSWD: ALL");
  } catch {}
  if (st.psup.exists) {
    const probe = sudo(["-u", user, SH_BIN, "-c", `test -x ${sq(psup)} && test ! -w ${sq(psup)}`]);
    st.psup.childReadOnly = probe.code === 0;
    st.psup.childCanWrite = sudo(["-u", user, SH_BIN, "-c", `test -w ${sq(psup)}`]).code === 0;
    st.mount.bound = sh("findmnt", ["--noheadings", "--output", "TARGET", psup]).code === 0;
    const g = sh("getfacl", ["-p", psup]);
    st.acls.psup = g.code === 0 && g.out.includes(`user:${user}:`);
    if (fs.existsSync(runs)) st.acls.runs = sh("getfacl", ["-p", runs]).out.includes(`user:${user}:`);
    if (fs.existsSync(sessions)) st.acls.sessions = sh("getfacl", ["-p", sessions]).out.includes(`user:${user}:`);
  }
  return st;
}

// Resolve the real pi CLI bundle (the node entry the wrapper execs).
// Order: the pi binary's own package (through symlinks), then the pi install
// layout (current-version → releases/<v>). Returns null when unresolvable —
// the drop-in then has no node rule and the guard's verified launch aborts.
// (launch.mjs calls ensureProtection without an explicit --real-cli, the way
// the chain path does; ralph.sh still passes the resolved path explicitly.)
export function resolveRealCli(opts = {}) {
  const cands = [];
  const pushPkg = (pkgDir) => {
    cands.push(path.join(pkgDir, "dist", "bundle", "cli.js"), path.join(pkgDir, "dist", "cli.js"));
  };
  if (opts.packageDir) pushPkg(opts.packageDir);
  if (opts.piBin) {
    try {
      const real = fs.realpathSync(String(opts.piBin));
      if (path.basename(path.dirname(real)) === ".bin")
        pushPkg(path.join(path.dirname(real), "..", "@earendil-works", "pi-coding-agent"));
    } catch { /* not resolvable — keep going */ }
  }
  try {
    const v = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "install", "current-version"), "utf8").trim();
    pushPkg(path.join(os.homedir(), ".pi", "agent", "install", "releases", v, "node_modules", "@earendil-works", "pi-coding-agent"));
  } catch { /* no install layout */ }
  for (const c of cands) {
    try { if (fs.existsSync(c)) return path.resolve(c); } catch { /* next candidate */ }
  }
  return null;
}

export function ensureProtection(opts) {
  const t0 = Date.now();
  const projectDir = path.resolve(opts.projectDir);
  const liveRunDir = opts.liveRunDir ? path.resolve(opts.liveRunDir) : null;
  const user = opts.user || process.env.PI_SUP_CHILD_USER || "pichild";
  const nodePath = opts.nodePath || (opts.nodeBinDir ? path.join(opts.nodeBinDir, "node") : null);
  const psup = path.join(projectDir, ".pi-supervisor");
  const runs = path.join(psup, "runs");
  const sessions = path.join(psup, "sessions");
  const workDirs = (opts.workDirs || []).map((d) => path.resolve(d)).filter(Boolean);

  if (!sudoAvailable())
    throw new Error("passwordless sudo unavailable — kernel protection cannot be applied (set PI_SUP_NO_PROTECT=1 to run unprotected)");

  const actions = [];
  const results = [];
  // "First run" = this user's sudoers drop-in did not exist yet (per user,
  // not per project — the boundary is host-scoped, so only the first
  // protection in a while is firstRun).
  const firstRun = !fs.existsSync(sudoersPathFor(user));

  const u = ensureUser(user);
  results.push(u);
  if (!u.ok) throw new Error(u.detail);

  const su = ensureSudoers({
    user,
    owner: ownerUser(),
    nodePath,
    realCli: opts.realCli || resolveRealCli({ piBin: opts.piBin }),
    piBin: opts.piBin || null,
    nodeBinDir: opts.nodeBinDir || null,
    sudo: !!opts.sudo,
  });
  results.push(su);
  if (!su.ok) throw new Error(su.detail);

  const cfg = ensureAgentConfig(user, opts.piBin || null);
  results.push(cfg);
  if (!cfg.ok) throw new Error(cfg.detail);

  const git = ensureGitConfig(user, [projectDir, ...workDirs]);
  results.push(git);
  if (!git.ok) throw new Error(git.detail);

  // DAC grants.
  const spec = { user, actions };
  if (!fs.existsSync(psup)) throw new Error(`run tree missing: ${psup}`);
  for (const t of [projectDir, ...workDirs, nodePath, opts.piBin, opts.nodeBinDir, opts.realCli])
    if (t && fs.existsSync(t)) aclChainX(spec, t);

  aclSet(projectDir, spec, "rwx");
  aclSet(psup, spec, "r-x");
  if (fs.existsSync(runs)) aclSet(runs, spec, "--x");
  if (fs.existsSync(runs)) {
    for (const d of findDirs(runs)) {
      if (!isRunDir(d)) aclSet(d, spec, "r-x"); // node dirs (readable)
    }
  }
  if (liveRunDir) aclSet(liveRunDir, spec, "rwx");
  if (workDirs.length) for (const w of workDirs) aclSet(w, spec, "rwx");
  if (opts.piBin && fs.existsSync(opts.piBin)) {
    aclSet(path.dirname(opts.piBin), spec, "r-x");
    aclSet(opts.piBin, spec, "r-x");
  }
  if (opts.nodeBinDir) treeAcl(spec, opts.nodeBinDir);
  if (opts.realCli) treeAcl(spec, releaseRootOf(opts.realCli));
  if (!fs.existsSync(sessions)) fs.mkdirSync(sessions, { mode: 0o700 });
  aclSet(sessions, spec, "rwx");
  sh("setfacl", ["-d", "-m", `u:${ownerUser()}:rX`, sessions]); // owner can read child's session files

  bindMountSelf(spec, psup);

  const status = protectionStatus({ projectDir, user });
  const detail = actions.length
    ? actions.join("; ")
    : "all grants already in place";
  return { ok: true, ms: Date.now() - t0, user, firstRun, detail, actions, results, status };
}

export function unprotect(opts) {
  const projectDir = path.resolve(opts.projectDir);
  const user = opts.user || process.env.PI_SUP_CHILD_USER || "pichild";
  const psup = path.join(projectDir, ".pi-supervisor");
  const runs = path.join(psup, "runs");
  const sessions = path.join(psup, "sessions");
  const actions = [];

  // Unmount first (blocks nothing for the owner afterwards).
  const m = sh("findmnt", ["--noheadings", "--output", "TARGET", psup]);
  if (m.code === 0) {
    const r = sudo(["umount", psup]);
    actions.push(r.code === 0 ? `bind mount removed: ${psup} unmounted` : `umount failed: ${r.err}`);
  }
  const spec = { user, actions };
  try {
    aclUnset(projectDir, spec);
    for (const w of (opts.workDirs || []).map((d) => path.resolve(d)).filter(Boolean))
      if (fs.existsSync(w)) aclUnset(w, spec);
    if (fs.existsSync(psup)) aclUnset(psup, spec);
    if (fs.existsSync(runs)) {
      aclUnset(runs, spec);
      for (const d of findDirs(runs)) if (!isRunDir(d)) aclUnset(d, spec);
    }
    if (fs.existsSync(sessions)) {
      aclUnset(sessions, spec);
      sh("setfacl", ["-d", "-x", `u:${ownerUser()}:rX`, sessions]);
    }
    if (opts.piBin && fs.existsSync(opts.piBin)) {
      aclUnset(path.dirname(opts.piBin), spec);
      aclUnset(opts.piBin, spec);
    }
    for (const root of [opts.nodeBinDir, opts.realCli ? releaseRootOf(opts.realCli) : null]) {
      if (root && fs.existsSync(root)) {
        sh(SH_BIN, ["-c", `find ${sq(root)} \\( -type f -o -type d \\) -print0 | xargs -0 setfacl -x u:${user}`]);
        actions.push(`${root} ACLs removed`);
      }
    }
  } catch (e) {
    actions.push(`warning: ${e.message}`);
  }
  const dropin = sudoersPathFor(user);
  if (fs.existsSync(dropin)) {
    const r = sudo(["rm", "-f", dropin]);
    actions.push(r.code === 0 ? `sudoers drop-in removed: ${dropin}` : `could not remove ${dropin} (manual: sudo rm ${dropin})`);
  }
  try { fs.rmSync(path.join(projectDir, ".pi-supervisor", "pi-abs"), { force: true }); } catch { /* best effort */ }
  // The user account is kept on purpose (agent config + history survive;
  // ralph.sh protect is idempotent). `userdel <user>` removes it fully.
  return { ok: true, actions };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cli() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const A = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      if (a === "--sudo") { A.sudo = true; continue; } // bare flag; the generic path takes a value
      A[a.slice(2)] = argv[i + 1], i++;
    }
  }
  const fail = (msg) => {
    console.error(`protect: ${msg}`);
    process.exit(1);
  };
  try {
    if (cmd === "apply") {
      if (!A.project) fail("--project required");
      const res = ensureProtection({
        projectDir: A.project,
        liveRunDir: A.live || null,
        user: A.user || process.env.PI_SUP_CHILD_USER || "pichild",
        piBin: A["pi-bin"] || null,
        realCli: A["real-cli"] || null,
        nodePath: A.node || null,
        nodeBinDir: A["node-bin-dir"] || null,
        workDirs: A["work-dirs"] ? String(A["work-dirs"]).split(":").filter(Boolean) : [],
        sudo: !!A.sudo,
      });
      // Machine contract: stdout is ONE JSON object (tests + ralph.sh parse
      // it); human-facing progress goes to stderr.
      for (const a of res.actions) console.error(`  ${a}`);
      console.log(JSON.stringify({ ok: true, firstRun: res.firstRun, ms: res.ms, user: res.user, actions: res.actions, status: res.status }));
    } else if (cmd === "status") {
      if (!A.project) fail("--project required");
      const st = protectionStatus({ projectDir: A.project, user: A.user || process.env.PI_SUP_CHILD_USER || "pichild" });
      console.log(JSON.stringify(st, null, 2));
    } else if (cmd === "unprotect") {
      if (!A.project) fail("--project required");
      const res = unprotect({ projectDir: A.project, user: A.user, piBin: A["pi-bin"] || null, nodeBinDir: A["node-bin-dir"] || null, realCli: A["real-cli"] || null, workDirs: A["work-dirs"] ? String(A["work-dirs"]).split(":").filter(Boolean) : [] });
      for (const a of res.actions) console.error(`  ${a}`);
      console.log(JSON.stringify({ ok: true, actions: res.actions }));
    } else {
      console.error("usage: protect.mjs apply|status|unprotect --project <d> [--live <run-dir>] [--user <u>] [--pi-bin <p>] [--real-cli <p>] [--node <p>] [--node-bin-dir <d>] [--work-dirs <a:b>] [--sudo]");
      process.exit(2);
    }
  } catch (e) {
    fail(e.message || String(e));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
