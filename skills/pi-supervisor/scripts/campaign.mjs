#!/usr/bin/env node
// campaign.mjs — the durable multi-run campaign primitive (v0.16.0).
//
// A *campaign* is a durable, named, goal-anchored thing: { goal, deadline,
// run history, verified-facts ledger, acceptance criteria, next-brief slot }.
// It replaces the hand-rolled per-run supervisor loop (reconstruct run state,
// read STATUS.md + manifest, write the next brief, size the timeout to the
// deadline, audit acceptance). The script owns the MECHANICS (locate
// artifacts, liveness, deadline math, bookkeeping); the parent LLM owns the
// JUDGMENT (what to do next — supplied via the campaign `next` slot,
// --brief-file, or --goal).
//
// State: one JSON file in the PROJECT dir, `<project>/.pi-supervisor/<name>.json`
// (git-ignored — add ".pi-supervisor/" to the project's .gitignore). It
// survives reboots; /tmp run out-dirs stay ephemeral and are only REFERENCED
// (a wiped out-dir marks a run "gone" in `status`; the history survives).
// Project-agnostic: assumes only a project dir, a child-maintained STATUS.md,
// the pi-child-* artifact convention, and a deadline.
//
// Purely a supervisor-side layer over the existing artifacts — no changes to
// guard.mjs / rpc-child.mjs. Spawning delegates to launch.mjs (the proven
// detached path), stopping delegates to stop.mjs, deadline math comes from
// lib/deadline.mjs (shared with launch.mjs --deadline).
//
// Every subcommand prints ONE JSON line on stdout + a human summary on stderr
// (--quiet suppresses the summary). Exit codes: 0 success · 1 operational
// refusal/failure · 2 usage error.
//
// Subcommands:
//   init --name <n> --goal "<obj>" [--deadline <time>] [--project DIR]
//        [--status-file P] [--run-timeout-min N] [--force]
//   status    latest run's LIVE state (pid check, not just the status file) +
//             manifest tail + ledger + next slot — NO writes. The whole
//             re-entry point for a fresh monitor session.
//   scaffold  assemble run N+1's brief → .pi-supervisor/brief-run<N+1>.md.
//             No launch — edit the file (parent judgment), then `next`.
//   next [--brief-file F | --goal "…" --accept "c1,c2"] [--deadline <time>]
//        [--dry-run] [--force]  — build brief + spawn run + record, one call.
//        Refusals: nothing to launch · campaign deadline passed · last run live.
//   record "<fact>" [--run N] [--verified-by parent|manifest|probe]
//   stop [--grace-sec N]  — delegate to stop.mjs against the latest run
//   done [--confirm "c1,c2"] [--force]  — acceptance checklist; all pass →
//        status=completed + done.md
//
// Campaign path resolution: --campaign <path> (explicit) > --name <n>
// (<cwd>/.pi-supervisor/<n>.json) > the single .json in <cwd>/.pi-supervisor/.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDeadline, sizeDeadline, fmtLocal } from "./lib/deadline.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LAUNCH = path.join(HERE, "launch.mjs");
const STOP = path.join(HERE, "stop.mjs");
const FINALIZE_MIN = 10; // must match guard.mjs's --finalize default
const TERMINAL = new Set(["completed", "stuck", "error", "consult"]);

const USAGE = `campaign.mjs — durable multi-run campaigns (v0.16.0). One JSON line on stdout; summary on stderr (--quiet suppresses it).

usage: node campaign.mjs <subcommand> [options] [--name <n> | --campaign <path>]

  init     --name <n> --goal "<objective>" [--deadline <time>] [--project DIR]
           [--status-file P] [--run-timeout-min N] [--force]
  status   latest run's LIVE state (pid check) + manifest tail + ledger + next
           slot — NO writes; the re-entry point for a fresh monitor session
  scaffold assemble run N+1's brief → .pi-supervisor/brief-run<N+1>.md (goal +
           next slot + verified-facts ledger + last-run manifest + STATUS.md +
           deadline math). NO launch — edit the file, then: next --brief-file
  next     [--brief-file F | --goal "…" --accept "c1,c2"] [--deadline <time>]
           [--dry-run] [--force] — build brief, spawn via launch.mjs, record
  record   "<fact>" [--run N] [--verified-by parent|manifest|probe]
  stop     [--grace-sec N] — delegate to stop.mjs against the latest run
  done     [--confirm "c1,c2"] [--force] — acceptance checklist (check = shell
           command in the project dir; null check = parent confirms); all pass
           → status=completed + done.md

state file: <project>/.pi-supervisor/<name>.json (git-ignored). Run from the
project dir, or pass --name / --campaign explicitly.`;

// ---------- CLI parsing (flat; subcommand = first positional) -------------
const VALFLAGS = new Set(["--name", "--campaign", "--goal", "--deadline", "--project", "--status-file", "--run-timeout-min", "--brief-file", "--accept", "--run", "--verified-by", "--confirm", "--grace-sec", "--_guard", "--_verify-sec"]);
const keyOf = (f) => f.slice(2).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const A = { sub: null, values: {}, positionals: [], quiet: false, force: false, dryRun: false, noSpawn: false };

function usageError(reason) {
  console.log(JSON.stringify({ ok: false, reason, usage: USAGE.split("\n") }));
  process.exit(2);
}

{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "-h" || x === "--help") { console.log(USAGE); process.exit(0); }
    if (VALFLAGS.has(x)) {
      const v = argv[++i];
      if (v === undefined) usageError(`flag ${x} is missing its value`);
      A.values[keyOf(x)] = v;
      continue;
    }
    if (x === "--quiet") { A.quiet = true; continue; }
    if (x === "--force") { A.force = true; continue; }
    if (x === "--dry-run") { A.dryRun = true; continue; }
    if (x === "--_no-spawn") { A.noSpawn = true; continue; } // test hook
    if (x.startsWith("--")) usageError(`unknown flag: ${x}`);
    if (A.sub === null) A.sub = x; else A.positionals.push(x);
  }
}

function emit(out, code, summary) {
  console.log(JSON.stringify(out));
  if (summary && !A.quiet) console.error(`[campaign] ${summary}`);
  process.exit(code);
}

// ---------- campaign file ---------------------------------------------------
function resolveCampaignFile() {
  if (A.values.campaign) return path.resolve(A.values.campaign);
  const dir = path.join(process.cwd(), ".pi-supervisor");
  if (A.values.name) return path.join(dir, `${A.values.name}.json`);
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    if (files.length === 1) return path.join(dir, files[0]);
  } catch { /* no .pi-supervisor in cwd */ }
  return null;
}

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

function loadCampaign() {
  const file = resolveCampaignFile();
  if (!file) emit({ ok: false, reason: "no campaign — pass --name <n> or --campaign <path> (or run from the project dir holding a single .pi-supervisor/*.json); create one with: campaign.mjs init --name <n> --goal \"…\"" }, 1, "no campaign");
  if (!existsSync(file)) emit({ ok: false, reason: `no campaign file at ${file}` }, 1, "no campaign file");
  const c = readJson(file);
  if (!c || !c.v) emit({ ok: false, reason: `campaign file unreadable or not a campaign: ${file}` }, 1);
  c.__file = file;
  c.__dir = path.dirname(file);
  return c;
}

function saveCampaign(c) {
  c.updatedAt = new Date().toISOString();
  const { __file, __dir, ...body } = c;
  writeFileSync(__file, JSON.stringify(body, null, 2) + "\n");
}

// Is a pid alive? Unlike stop.mjs's check, an UNKNOWN pid means NOT alive here:
// the guard nulls the pids in its final status write, so a null pid is positive
// evidence the run exited (a stale "running" file with live pids is the
// killed-on-Windows shape — caught by the pid check below).
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === "win32") {
    try {
      const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", timeout: 5000 });
      if (r.status !== 0) return true; // tasklist itself failed — cannot conclude
      if (/INFO:/.test(r.stdout)) return false;
      return r.stdout.split("\n").some((l) => l.trim().split(/\s+/)[1] === String(pid));
    } catch { return true; }
  }
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }
}

// Live view of a recorded run: re-reads the status file + pid liveness +
// manifest (the plan's F4 replacement — never trust the recorded snapshot).
function inspectRun(c, run) {
  const out = {
    id: run.id, outDir: run.outDir, session: run.session || null, brief: run.brief || null,
    launchedAt: run.launchedAt || null, deadline: run.deadline || null, timeoutMin: run.timeoutMin ?? null,
    recordedStatus: run.status || null, exitReason: run.exitReason || null, note: run.note || null,
    outDirPresent: existsSync(run.outDir),
    live: false, statusFile: null, manifest: null,
  };
  const st = out.outDirPresent ? readJson(path.join(run.outDir, "pi-child-status.json")) : null;
  if (st) {
    out.statusFile = { status: st.status ?? null, exitReason: st.exitReason ?? null, guardPid: st.guardPid ?? null, toolCalls: st.toolCalls ?? null, at: st.at ?? null, sessionId: st.sessionId ?? null };
    if (!TERMINAL.has(st.status)) out.live = pidAlive(st.guardPid);
  }
  const mf = out.outDirPresent ? readJson(path.join(run.outDir, "pi-child-result.json")) : null;
  if (mf && mf.result) {
    const r = mf.result;
    out.manifest = {
      status: r.status ?? null, exitReason: r.exitReason ?? null, elapsedMs: r.elapsedMs ?? null,
      toolCalls: st?.toolCalls ?? null, // the manifest has no total; the status file does
      finalText: (r.finalText || "").slice(0, 2000),
      finalTextTruncated: !!r.finalTextTruncated,
      finalTextFile: r.finalTextFile || null,
      sessionFile: r.sessionFile || null,
    };
  }
  if (!out.outDirPresent) out.note = [run.note, "out dir gone (reboot wipes /tmp — the run's artifacts are lost, its history lives here)"].filter(Boolean).join(" | ");
  return out;
}

// Per-run deadline = min(campaign deadline, override if given, now + runTimeoutMin).
function perRunDeadline(c, overrideRaw, now) {
  let cap = Infinity;
  if (c.deadline) cap = Math.min(cap, new Date(c.deadline).getTime());
  if (overrideRaw) {
    const P = parseDeadline(overrideRaw);
    if (!P.ok) return { ok: false, why: P.why };
    cap = Math.min(cap, P.ts.getTime());
  }
  const windowEnd = now.getTime() + (c.runTimeoutMin ?? 40) * 60000;
  const ts = new Date(Math.min(cap, windowEnd));
  return { ok: true, ts, label: fmtLocal(ts) };
}

// ---------- brief assembly (shared by scaffold + next; pure — no writes) ----
function assembleBrief(c, { runNum, goalOverride = null, acceptOverride = null, outDir = null, now = new Date() }) {
  const next = c.next || {};
  const goal = goalOverride || next.goal || null;
  const accepts = (acceptOverride && acceptOverride.length) ? acceptOverride : (next.acceptance || []);
  const last = c.runs[c.runs.length - 1] || null;
  const lastInsp = last ? inspectRun(c, last) : null;
  const dl = perRunDeadline(c, null, now);
  const sized = sizeDeadline({ ts: dl.ts, finalizeMin: FINALIZE_MIN, now });
  const minsLeft = c.deadline ? Math.floor((new Date(c.deadline).getTime() - now.getTime()) / 60000) : null;
  let statusTail = null;
  if (c.statusFile && existsSync(c.statusFile)) {
    statusTail = readFileSync(c.statusFile, "utf8").trimEnd().split(/\r?\n/).slice(-40).join("\n");
  }
  const L = [];
  L.push(`# Run ${runNum} — campaign "${c.name}"`, "");
  L.push(`> Mechanically assembled by campaign.mjs v0.16.0 from ${c.__file}. The parent may edit this file before launching; this text is what the child receives as its task.`, "");
  L.push(`## Campaign goal (durable)`);
  L.push(c.goal, "");
  L.push(`## This run's goal`);
  L.push(goal || "(none set — the parent must fill this in before launching)", "");
  L.push(`## Acceptance for this run`);
  if (accepts.length) accepts.forEach((a) => L.push(`- ${a}`)); else L.push("- (none set)");
  L.push("");
  if ((c.acceptance || []).length) {
    L.push(`## Final campaign acceptance (parent-checked, context only)`);
    (c.acceptance).forEach((a) => L.push(`- ${a.criterion}`));
    L.push("");
  }
  L.push(`## VERIFIED FACTS — do not re-derive`);
  if ((c.ledger || []).length) c.ledger.forEach((l) => L.push(`- [run ${l.run ?? "?"}, ${l.verifiedBy}] ${l.fact}`));
  else L.push(`- (none recorded yet — the parent records verified findings with \`campaign record\` after each run)`);
  L.push("");
  L.push(last ? `## Last run: run ${last.id}` : `## Previous runs`);
  if (last) {
    const sf = lastInsp.statusFile;
    L.push(`- final: ${sf ? `status=${sf.status}${sf.exitReason ? ` exitReason=${sf.exitReason}` : ""} toolCalls=${sf.toolCalls ?? "?"}` : "no status file (out dir gone?)"}`);
    L.push(`- out dir: ${last.outDir} — ${lastInsp.outDirPresent ? "present" : "GONE (reboot wipes /tmp — artifacts lost, history survives in the campaign file)"}`);
    if (lastInsp.manifest?.finalText) {
      L.push(`- final text (tail, ≤2000 chars):`);
      lastInsp.manifest.finalText.split("\n").forEach((l) => L.push(`  > ${l}`));
    }
  } else L.push(`- (none — this is the first run)`);
  L.push("");
  L.push(`## STATUS.md tail (child-maintained — where the child left off)`);
  if (statusTail !== null) statusTail.split("\n").forEach((l) => L.push(`  ${l}`));
  else L.push(`  (no STATUS.md at ${c.statusFile || "(not configured)"} — create and maintain it from the first milestone)`);
  L.push("");
  L.push(`## Budget`);
  L.push(`- campaign deadline: ${c.deadline ? `${c.deadline} (${fmtLocal(new Date(c.deadline))}) — ${minsLeft >= 0 ? `${minsLeft} min left` : `${Math.abs(minsLeft)} min OVERDUE`}` : "(none set — the per-run window only)"}`);
  if (sized.ok) L.push(`- this run: deadline ${dl.ts.toISOString()} (${dl.label}) — guard budget: --timeout ${sized.timeoutMin} min + ${FINALIZE_MIN} min finalization window`);
  else L.push(`- this run: WARNING — ${dl.label} ${sized.why} (\`campaign next\` will refuse without --force)`);
  L.push(`- budget rule: when ~${FINALIZE_MIN} min remain, stop starting new items; finish the current one and write the final status into STATUS.md`);
  L.push("");
  L.push(`## Where to work`);
  L.push(`- project dir (your cwd): ${c.project}`);
  L.push(`- STATUS.md to maintain: ${c.statusFile || "(none configured — create it in the project root)"}`);
  L.push(`- run artifacts (supervisor-managed, do not edit): ${outDir || path.join(os.tmpdir(), `pi-sup-${c.name}-r${runNum}-<time>`)} → pi-child-progress.log, pi-child-status.json, pi-child-result.json`);
  L.push("");
  L.push(`## Parent notes`);
  L.push(next.notes || "(none)", "");
  L.push(`## Invariants`);
  L.push(`- This is run ${runNum} of a multi-run campaign. The VERIFIED FACTS above are settled — do not re-derive them.`);
  L.push(`- Small verifiable steps; max 3 attempts per approach, then record the finding and move on.`);
  L.push(`- Update STATUS.md at every milestone: what is done (with evidence paths), what is blocked and why, what remains.`);
  L.push(`- Never stop with only internal thinking — end with a written status update.`);
  return {
    brief: L.join("\n") + "\n",
    deadline: { perRunDeadline: dl.ts.toISOString(), perRunDeadlineLocal: dl.label, timeoutMin: sized.ok ? sized.timeoutMin : null, sizedOk: sized.ok, why: sized.ok ? null : sized.why, campaignMinsLeft: minsLeft },
  };
}

// ---------- subcommands ------------------------------------------------------
function cmdInit() {
  if (!A.values.name) usageError("init requires --name <n>");
  if (!A.values.goal) usageError("init requires --goal \"<objective>\"");
  if (!/^[A-Za-z0-9._-]+$/.test(A.values.name)) emit({ ok: false, reason: `--name must be [A-Za-z0-9._-] (got "${A.values.name}")` }, 2);
  const project = path.resolve(A.values.project || process.cwd());
  if (!existsSync(project)) emit({ ok: false, reason: `project dir not found: ${project}` }, 1);
  const dir = path.join(project, ".pi-supervisor");
  const file = path.join(dir, `${A.values.name}.json`);
  if (existsSync(file) && !A.force) emit({ ok: false, reason: `campaign already exists: ${file} (use --force to overwrite it)` }, 1);
  let deadline = null;
  if (A.values.deadline) {
    const P = parseDeadline(A.values.deadline);
    if (!P.ok) emit({ ok: false, reason: `--deadline: ${P.why}` }, 1);
    deadline = P.ts.toISOString();
  }
  const statusFile = A.values.statusFile
    ? path.resolve(A.values.statusFile)
    : (existsSync(path.join(project, "STATUS.md")) ? path.join(project, "STATUS.md") : null);
  const runTimeoutMin = A.values.runTimeoutMin !== undefined ? Number(A.values.runTimeoutMin) : 40;
  if (!Number.isInteger(runTimeoutMin) || runTimeoutMin < 1) emit({ ok: false, reason: `--run-timeout-min must be a positive integer (got ${A.values.runTimeoutMin})` }, 2);
  const c = {
    v: 2, name: A.values.name, project, statusFile,
    goal: A.values.goal, deadline, runTimeoutMin,
    acceptance: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    runs: [], ledger: [],
    next: { goal: null, acceptance: [], briefFile: null, notes: null },
    status: "active",
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(c, null, 2) + "\n");
  let gitignoreHint = null;
  const gi = path.join(project, ".gitignore");
  if (existsSync(gi)) {
    const lines = readFileSync(gi, "utf8").split(/\r?\n/).map((l) => l.trim());
    if (!lines.includes(".pi-supervisor/") && !lines.includes(".pi-supervisor")) {
      gitignoreHint = `add ".pi-supervisor/" to ${gi} — campaign state is not for git`;
    }
  }
  emit({ ok: true, campaign: c.name, campaignFile: file, project, statusFile, deadline, runTimeoutMin, ...(gitignoreHint ? { gitignoreHint } : {}) }, 0, `campaign "${c.name}" created at ${file}${gitignoreHint ? ` — ${gitignoreHint}` : ""}`);
}

function cmdStatus() {
  const c = loadCampaign();
  const last = c.runs[c.runs.length - 1] || null;
  const lastInsp = last ? inspectRun(c, last) : null;
  const now = Date.now();
  const out = {
    ok: true,
    name: c.name,
    campaignFile: c.__file,
    status: c.status || "active",
    goal: c.goal,
    project: c.project,
    deadline: c.deadline || null,
    deadlineLocal: c.deadline ? fmtLocal(new Date(c.deadline)) : null,
    minsLeft: c.deadline ? Math.max(0, Math.floor((new Date(c.deadline).getTime() - now) / 60000)) : null,
    runTimeoutMin: c.runTimeoutMin ?? 40,
    runsSoFar: c.runs.length,
    lastRun: lastInsp,
    acceptance: c.acceptance || [],
    verifiedFacts: (c.ledger || []).map((l) => l.fact),
    next: c.next || { goal: null, acceptance: [], briefFile: null, notes: null },
  };
  const mins = out.minsLeft === null ? "no campaign deadline" : `${out.minsLeft} min left`;
  const lastPart = lastInsp
    ? `; last run ${last.id} ${lastInsp.live ? "LIVE" : lastInsp.outDirPresent ? `not live (file: ${lastInsp.statusFile ? lastInsp.statusFile.status : "no status file"})` : "not live (out dir gone)"}`
    : "; no runs yet";
  emit(out, 0, `"${c.name}" — ${out.status}, ${c.runs.length} run(s), ${mins}${lastPart}`);
}

function cmdScaffold() {
  const c = loadCampaign();
  const runNum = c.runs.length + 1;
  const { brief, deadline } = assembleBrief(c, { runNum });
  const briefPath = path.join(c.__dir, `brief-run${runNum}.md`);
  writeFileSync(briefPath, brief);
  const cmd = `${process.execPath} "${path.join(HERE, "campaign.mjs")}" next --brief-file "${briefPath}"`;
  emit({ ok: true, run: runNum, briefPath, brief, deadline, launchCmd: cmd }, 0, `run ${runNum} brief written to ${briefPath} — edit it (parent judgment), then: ${cmd}`);
}

function spawnLaunch(args) {
  const r = spawnSync(process.execPath, [LAUNCH, ...args], { encoding: "utf8", timeout: 240000 });
  let j = null;
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  if (lines.length) { try { j = JSON.parse(lines[lines.length - 1]); } catch { /* not JSON */ } }
  return { code: r.status, json: j, errTail: (r.stderr || "").slice(-500) };
}

function cmdNext() {
  const c = loadCampaign();
  const runNum = c.runs.length + 1;
  const now = new Date();
  if ((c.status || "active") === "completed" && !A.force) {
    emit({ ok: false, reason: `campaign "${c.name}" is marked completed — nothing to launch (init a new campaign, or --force to keep going)` }, 1);
  }
  if (A.values.briefFile && (A.values.goal || A.values.accept)) usageError("--brief-file is mutually exclusive with --goal/--accept");

  // 1. Brief source precedence: --brief-file > --goal > next.briefFile > next.goal
  let brief = null, briefPath = null, source = null;
  if (A.values.briefFile) {
    briefPath = path.resolve(A.values.briefFile);
    if (!existsSync(briefPath)) emit({ ok: false, reason: `brief file not found: ${briefPath}` }, 1);
    brief = readFileSync(briefPath, "utf8"); source = "brief-file";
  } else if (A.values.goal) {
    source = "goal-flag";
  } else if (c.next?.briefFile) {
    briefPath = path.isAbsolute(c.next.briefFile) ? c.next.briefFile : path.join(c.project, c.next.briefFile);
    if (!existsSync(briefPath)) emit({ ok: false, reason: `next.briefFile not found: ${briefPath}` }, 1);
    brief = readFileSync(briefPath, "utf8"); source = "next.briefFile";
  } else if (c.next?.goal) {
    source = "next.slot";
  } else {
    emit({ ok: false, reason: `nothing to launch — pass --brief-file <f> or --goal "…" [--accept "c1,c2"], or set the campaign next slot (next.goal / next.acceptance / next.briefFile in ${c.__file})` }, 1, "nothing to launch");
  }

  // 2. Deadline gate + sizing (shared lib — the same math as launch.mjs --deadline)
  if (c.deadline && now.getTime() >= new Date(c.deadline).getTime() && !A.force) {
    emit({ ok: false, reason: `campaign deadline ${c.deadline} (${fmtLocal(new Date(c.deadline))}) has passed — a new run cannot finish before it (use --force to override)` }, 1);
  }
  const dl = perRunDeadline(c, A.values.deadline, now);
  if (!dl.ok) emit({ ok: false, reason: `cannot parse --deadline: ${dl.why}` }, 1);
  const sized = sizeDeadline({ ts: dl.ts, finalizeMin: FINALIZE_MIN, now });
  if (!sized.ok) emit({ ok: false, reason: `cannot size run budget — ${dl.label} ${sized.why}` }, 1);

  // 3. Live-run gate — a campaign is sequential: one live run at a time
  const last = c.runs[c.runs.length - 1] || null;
  const lastInsp = last ? inspectRun(c, last) : null;
  if (lastInsp?.live && !A.force) {
    emit({ ok: false, reason: `run ${last.id} is still LIVE (guard pid ${lastInsp.statusFile?.guardPid}) — stop it first (campaign stop) or pass --force to run in parallel` }, 1);
  }

  // 4. Fresh out-dir + the brief file (assembled sources are written for inspection)
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const outDir = path.join(os.tmpdir(), `pi-sup-${c.name}-r${runNum}-${stamp}`);
  const briefFile = path.join(c.__dir, `brief-run${runNum}.md`);
  if (source === "goal-flag" || source === "next.slot") {
    const asm = assembleBrief(c, {
      runNum,
      goalOverride: A.values.goal || null,
      acceptOverride: A.values.accept ? A.values.accept.split(",").map((s) => s.trim()).filter(Boolean) : null,
      outDir, now,
    });
    brief = asm.brief;
    briefPath = briefFile;
    if (!A.dryRun) writeFileSync(briefFile, brief);
  }

  // 5. The exact launch command — --dry-run stops here (no spawn, no record,
  //    no brief written for assembled sources)
  const launchArgs = ["--task-file", briefPath, "--out-dir", outDir, "--deadline", dl.ts.toISOString()];
  if (A.values._guard) launchArgs.push("--guard", A.values._guard); // hidden test hook (fake guard, no model)
  if (A.values._verifySec) launchArgs.push("--verify-sec", String(A.values._verifySec)); // hidden test hook
  const launchCmd = [process.execPath, LAUNCH, ...launchArgs].join(" ");
  if (A.dryRun) {
    emit({ ok: true, dryRun: true, run: runNum, source, brief, briefPath: source === "goal-flag" || source === "next.slot" ? briefFile : briefPath, outDir, deadline: { perRunDeadline: dl.ts.toISOString(), perRunDeadlineLocal: dl.label, timeoutMin: sized.timeoutMin, hardStopAt: sized.hardStopAt, finalizeAt: sized.finalizeAt }, launchCmd }, 0, `dry run — no spawn, no record. Launch with: ${launchCmd}`);
  }

  // 6. Spawn (delegate to launch.mjs — the proven detached path) + record
  if (A.noSpawn) { // hidden test hook: everything except the actual spawn
    const rec = { id: runNum, outDir, session: null, brief: briefPath, launchedAt: now.toISOString(), deadline: dl.ts.toISOString(), timeoutMin: sized.timeoutMin, status: "recorded-no-spawn", exitReason: null, keyCommits: [], note: null };
    c.runs.push(rec);
    saveCampaign(c);
    return emit({ ok: true, launched: false, noSpawn: true, run: rec, launchCmd, campaignFile: c.__file }, 0, `no-spawn test hook — run ${runNum} recorded without spawning`);
  }
  const L = spawnLaunch(launchArgs);
  const lj = L.json;
  if (!lj || lj.launched === false) {
    const reason = (lj?.reason || `launch failed (exit ${L.code})`) + (L.errTail ? ` — ${L.errTail}` : "");
    emit({ ok: false, reason, launch: lj }, 1, "launch failed — nothing recorded");
    return;
  }
  const rec = {
    id: runNum, outDir,
    session: lj.status?.sessionId ?? null,
    brief: briefPath,
    launchedAt: now.toISOString(),
    deadline: dl.ts.toISOString(),
    timeoutMin: sized.timeoutMin,
    status: lj.launched === true ? "launched" : "launch-unknown",
    exitReason: null,
    keyCommits: [],
    note: lj.launched === true ? null : "launch reported unknown (alive but silent) — verify before relaunching",
  };
  c.runs.push(rec);
  saveCampaign(c);
  emit({ ok: true, launched: lj.launched, run: rec, launch: lj, campaignFile: c.__file }, 0, `run ${runNum} ${lj.launched === true ? "launched" : "reported unknown"} — out dir ${outDir}, deadline ${dl.ts.toISOString()}, timeout ${sized.timeoutMin} min`);
}

function cmdRecord() {
  const c = loadCampaign();
  const fact = A.positionals.join(" ").trim();
  if (!fact) emit({ ok: false, reason: `record needs a fact: campaign.mjs record "<fact>" [--run N] [--verified-by parent|manifest|probe]` }, 2);
  if (A.values.run !== undefined && !Number.isInteger(Number(A.values.run))) emit({ ok: false, reason: `--run must be an integer (got "${A.values.run}")` }, 2);
  const vb = A.values.verifiedBy || "parent";
  if (!["parent", "manifest", "probe"].includes(vb)) emit({ ok: false, reason: `--verified-by must be parent|manifest|probe (got "${vb}")` }, 2);
  c.ledger = c.ledger || [];
  c.ledger.push({ fact, run: A.values.run !== undefined ? Number(A.values.run) : null, verifiedBy: vb, at: new Date().toISOString() });
  saveCampaign(c);
  emit({ ok: true, fact, ledger: c.ledger, count: c.ledger.length }, 0, `recorded: "${fact.length > 80 ? fact.slice(0, 80) + "…" : fact}" (ledger now ${c.ledger.length})`);
}

function cmdStop() {
  const c = loadCampaign();
  const last = c.runs[c.runs.length - 1] || null;
  if (!last) emit({ ok: false, reason: "no runs recorded — nothing to stop" }, 1);
  if (!existsSync(last.outDir)) {
    last.status = "gone";
    last.note = [last.note, "out dir gone (reboot wiped /tmp) — nothing to stop"].filter(Boolean).join(" | ");
    saveCampaign(c);
    return emit({ ok: true, stop: { note: "out dir gone — nothing to stop" }, run: { id: last.id, outDir: last.outDir } }, 0, `run ${last.id}: out dir gone, marked gone (nothing to stop)`);
  }
  const args = [STOP, "--out-dir", last.outDir];
  if (A.values.graceSec) args.push("--grace-sec", String(A.values.graceSec));
  const r = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 180000 });
  let sj = null;
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  if (lines.length) { try { sj = JSON.parse(lines[lines.length - 1]); } catch { /* not JSON */ } }
  if (sj?.finalStatusStatus) {
    const fs = sj.finalStatusStatus;
    // The guard's file status is not updated on SIGTERM (known Windows gotcha),
    // so a "running" file after a confirmed kill is stale — record OUR outcome.
    if (sj.stopped) last.status = "stopped";
    else if (TERMINAL.has(fs)) last.status = fs;
    else last.status = "dead"; // pid gone but file non-terminal (killed without a final write)
    last.exitReason = sj.finalStatusExitReason ?? last.exitReason ?? null;
    last.note = [last.note, sj.stopped ? `stopped via ${sj.stoppedVia}` : `stop: ${sj.stoppedVia || "no-op"}${sj.reason ? ` — ${sj.reason}` : ""}`].filter(Boolean).join(" | ");
    saveCampaign(c);
  }
  emit({ ok: r.status === 0, stop: sj, run: { id: last.id, outDir: last.outDir } }, r.status === 0 ? 0 : 1, sj ? `stop: ${sj.stopped ? sj.stoppedVia : (sj.reason || "no-op")}` : `stop exited ${r.status}`);
}

function renderDone(c, rows) {
  const L = [];
  L.push(`# Campaign "${c.name}" — final acceptance report`, "");
  L.push(`- at: ${new Date().toISOString()}`);
  L.push(`- runs: ${c.runs.length}`);
  L.push(`- goal: ${c.goal}`);
  if (c.deadline) L.push(`- deadline: ${c.deadline} (${fmtLocal(new Date(c.deadline))})`);
  L.push(``, `## Acceptance`);
  rows.forEach((r, i) => L.push(`${i + 1}. **${r.criterion}** — ${r.pass ? "PASS" : "FAIL"} (${r.via === "check" ? `check: \`${r.check}\`` : "parent-confirmed"}${r.output ? ` — ${r.output}` : ""})`));
  L.push(``, `All acceptance criteria passed → campaign marked **completed**.`, "");
  return L.join("\n");
}

function cmdDone() {
  const c = loadCampaign();
  // Live check first: a running child beats any setup error — the parent should
  // stop it before final acceptance regardless of the acceptance state.
  const last = c.runs[c.runs.length - 1] || null;
  const lastInsp = last ? inspectRun(c, last) : null;
  if (lastInsp?.live && !A.force) emit({ ok: false, reason: `run ${last.id} is still LIVE — stop it before final acceptance (campaign stop), or --force` }, 1);
  const accs = c.acceptance || [];
  if (!accs.length) emit({ ok: false, reason: `no acceptance criteria — set acceptance[] in ${c.__file} (entries: {criterion, check} — check = shell command run in the project dir, null = parent confirms)` }, 1);
  const confirms = (A.values.confirm || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const rows = [];
  for (const acc of accs) {
    const row = { criterion: acc.criterion, check: acc.check || null, via: acc.check ? "check" : "parent", pass: false, output: null };
    if (acc.check) {
      const isWin = process.platform === "win32";
      const r = spawnSync(isWin ? "cmd" : "sh", isWin ? ["/c", acc.check] : ["-c", acc.check], { cwd: c.project, encoding: "utf8", timeout: 300000 });
      row.pass = r.status === 0;
      row.output = ((r.stdout || "") + (r.stderr || "")).trim().slice(-500) || null;
    } else {
      const crit = acc.criterion.toLowerCase();
      row.pass = confirms.some((s) => crit.includes(s) || s.includes(crit));
      row.output = row.pass ? "confirmed by parent (--confirm)" : "needs parent confirmation — re-run: campaign.mjs done --confirm \"<criterion>\"";
    }
    rows.push(row);
  }
  const allPass = rows.every((r) => r.pass);
  const out = { ok: allPass, allPass, name: c.name, rows, lastRun: lastInsp ? { id: lastInsp.id, live: lastInsp.live } : null };
  if (!allPass) {
    return emit(out, 1, `${rows.filter((r) => !r.pass).length}/${rows.length} acceptance criterion(s) not passing — campaign stays "${c.status || "active"}"`);
  }
  c.status = "completed";
  saveCampaign(c);
  const report = path.join(c.__dir, "done.md");
  writeFileSync(report, renderDone(c, rows));
  out.doneReport = report;
  emit(out, 0, `campaign "${c.name}" COMPLETE — ${rows.length}/${rows.length} acceptance criteria pass — report: ${report}`);
}

const SUBS = { init: cmdInit, status: cmdStatus, scaffold: cmdScaffold, next: cmdNext, record: cmdRecord, stop: cmdStop, done: cmdDone };
if (!A.sub) usageError("missing subcommand");
const fn = SUBS[A.sub];
if (!fn) usageError(`unknown subcommand: ${A.sub}`);
fn();
