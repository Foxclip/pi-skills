#!/usr/bin/env node
// harvest.mjs — ralph.sh v0.19.0: turn a run dir into a permanent, self-contained,
// findable evidence folder. Idempotent — safe to re-run (entries are upserted,
// the transcript is re-copied, everything refreshed with a fresh timestamp).
//
//   node harvest.mjs <run-dir> [interrupted=0|1] [monitorRc=0]
//
// Does (all best-effort, NEVER throws — exit is always 0 so it cannot break
// the caller):
//   1. copies the child's pi session transcript (pi-<childPid>.jsonl from
//      ~/.pi/agent/sessions/** — the ONE artifact that lived in a temp-ish
//      per-session location) into <run-dir>/child-transcript.jsonl
//   2. writes <run-dir>/RUN-REPORT.md        (human: what happened, last cycle,
//                                             decisions, log tail, artifact list)
//   3. writes <run-dir>/run-summary.json     (machine: key fields + status)
//   4. upserts one entry in <runs-root>/INDEX.json (the per-project run index)
//
import fs from "fs";
import os from "os";
import path from "path";

// every harvest message is timestamped in LOCAL time (terminal = human-facing;
// matches ralph.sh's ts() — the log files keep ISO-8601 UTC)
// terminal-facing: short local [HH:MM:SS] like the rest of the ralph terminal
// (files stay ISO-8601 UTC); ts dimmed like the monitor's lines (same tty/NO_COLOR guard)
// v0.24.0: glyphed status lines (· info, ! warn, ✓ success, ✗ failure) — the
// `harvest:` source prefix is gone (the glyph language is shared with
// ralph.sh/ralph-monitor, so the tag was redundant)
const tty = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const C = (code) => (tty ? `\x1b[${code}m` : "");
const sayG = (glyph, color, msg) => {
  const d = new Date(); const p = (n) => String(n).padStart(2, "0");
  console.error(`${C(2)}[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]${C(0)} ${C(color)}${glyph} ${msg}${C(0)}`);
};

const [runDir, interruptedRaw = "0", rcRaw = "0"] = process.argv.slice(2);
if (!runDir || !fs.existsSync(runDir)) {
  sayG("✗", 31, `run dir not found: ${runDir ?? "(none)"}`);
  process.exit(0);
}
const interrupted = interruptedRaw === "1";
const monitorRc = Number.parseInt(rcRaw, 10) || 0;

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const status = readJson(path.join(runDir, "pi-child-status.json")) || {};
const result = readJson(path.join(runDir, "pi-child-result.json")) || {};
const ralphState = readJson(path.join(runDir, "ralph-monitor-state.json")) || {};
const runsRoot = path.dirname(runDir);
const runName = path.basename(runDir);
const projectDir = ralphState.projectDir || status.cwd || result.cwd || "(unknown)";

// ---- 1. child transcript -------------------------------------------------
function findTranscript(childPid) {
  if (!childPid) return null;
  const root = path.join(os.homedir(), ".pi", "agent", "sessions");
  const hits = [];
  const walk = (dir, depth) => {
    if (depth > 2) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
      else if (e.name === `pi-${childPid}.jsonl`) hits.push(path.join(dir, e.name));
    }
  };
  walk(root, 0);
  if (!hits.length) return null;
  hits.sort((a, b) => (fs.statSync(b).mtimeMs || 0) - (fs.statSync(a).mtimeMs || 0));
  return hits[0];
}
let transcript = { copied: false, lines: 0, bytes: 0, note: "" };
try {
  // 1) authoritative: the guard records the exact session path in status
  // 2) fallback: locate pi-<childPid>.jsonl under ~/.pi/agent/sessions/**
  let src = (status.sessionFile && fs.existsSync(status.sessionFile)) ? status.sessionFile : null;
  if (!src) {
    const childPid = status.childPid || result.pid || null;
    if (childPid) src = findTranscript(childPid);
  }
  if (src) {
    const dest = path.join(runDir, "child-transcript.jsonl");
    fs.copyFileSync(src, dest);
    const txt = fs.readFileSync(dest, "utf8");
    transcript = { copied: true, lines: txt.split("\n").filter(Boolean).length, bytes: fs.statSync(dest).size, note: `from ${src}` };
  } else {
    transcript.note = "session file not found (status.sessionFile absent/stale and pid search missed)";
  }
} catch (e) { transcript.note = String(e.message || e); }

// ---- ralph-monitor log tail + state fields --------------------------------
let logTail = "";
try {
  const lines = fs.readFileSync(path.join(runDir, "ralph-monitor.log"), "utf8").trim().split("\n");
  logTail = lines.slice(-15).join("\n");
} catch { logTail = "(no ralph-monitor.log)"; }

// ---- artifact list ---------------------------------------------------------
let files = [];
try {
  files = fs.readdirSync(runDir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => ({ name: e.name, bytes: fs.statSync(path.join(runDir, e.name)).size }))
    .filter((f) => !["RUN-REPORT.md", "run-summary.json", "child-transcript.jsonl"].includes(f.name))
    .sort((a, b) => a.name.localeCompare(b.name));
} catch { files = []; }

const exitReason = result.exitReason || status.exitReason || null;
const alive = status.guardPid != null;
let finalStatus = result.status || status.status || (exitReason ? exitReason : "unknown");
// v0.32.0 (5.1): a pending SPAWN request is a PAUSE, not an end — the run
// re-activates when the child comes back (chain reentry). The re-activated
// run's final termination re-harvests and upserts the true terminal status.
// A REJECTED decision is not a pause (the run ended normally).
{
  let dec = null;
  if (fs.existsSync(path.join(runDir, "spawn-request.json"))) {
    try { dec = JSON.parse(fs.readFileSync(path.join(runDir, "spawn-decision.json"), "utf8")); } catch { dec = null; }
    if (!dec || dec.ok !== false) finalStatus = "paused";
  }
}

// ---- 2. RUN-REPORT.md ------------------------------------------------------
const L = [];
L.push(`# RUN REPORT — ${runName}`);
L.push("");
L.push(`- Harvested: ${new Date().toISOString()} (re-runnable — latest harvest wins)`);
L.push(`- Project: ${projectDir}`);
L.push(`- Run dir: ${runDir}`);
L.push(`- Child: status=${finalStatus} exitReason=${exitReason ?? "n/a"} guardPid=${status.guardPid ?? "n/a"} childPid=${status.childPid ?? "n/a"} attempt=${status.attempt ?? "n/a"} rewinds=${status.rewinds ?? "n/a"}`);
L.push(`- Deadline: ${status.deadlineIso ?? ralphState.deadlineIso ?? "n/a"}`);
L.push(`- Last activity: ${status.lastTool ?? "(none)"} at ${status.lastToolStartedAt ?? "(never)"} (${status.lastToolFinishedAt ? "finished " + status.lastToolFinishedAt : "still running at harvest time"})`);
L.push(`- Ralph monitor: cycles=${ralphState.cycle ?? "n/a"} interventions=${ralphState.interventions ?? "n/a"} llmFailures=${ralphState.llmFailures ?? "n/a"} lastNudge=${ralphState.lastNudgeDisposition ?? "n/a"} session=${ralphState.session ?? "n/a"}`);
L.push(`- Monitor exit: rc=${monitorRc}${interrupted ? " (interrupted by user — SIGINT/SIGTERM)" : ""}`);
L.push(`- Child transcript: ${transcript.copied ? `child-transcript.jsonl (${transcript.lines} lines, ${Math.round(transcript.bytes / 1024)} KB)` : "not copied — " + transcript.note}`);
L.push("");
L.push("## Artifacts in this run dir");
L.push("");
if (files.length) {
  L.push("| file | size |");
  L.push("|---|---|");
  for (const f of files) L.push(`| ${f.name} | ${f.bytes} B |`);
} else L.push("(none)");
if (fs.existsSync(path.join(runDir, "FINAL-REPORT.md"))) {
  L.push("");
  L.push("## Final report (written by the parent)");
  L.push("");
  L.push(fs.readFileSync(path.join(runDir, "FINAL-REPORT.md"), "utf8").trimEnd());
}
L.push("");
L.push(`## Ralph monitor log (last 15 lines)`);
L.push("");
L.push("```");
L.push(logTail);
L.push("```");
L.push("");
L.push("## How to read this");
L.push("");
L.push("- `child-transcript.jsonl` is the child agent's FULL session (every message/tool call) — the ground truth.");
L.push("- `ralph-monitor.log` lines: `[iso] cycle=N decision=OK|NUDGE|STOP ...` — one per ralph cycle.");
L.push("- `FINAL-REPORT.md` (if present) — the parent's final report: what was requested, what was done, outcome, remaining. Also printed to the terminal by ralph.sh when the run ends.");
L.push("- The pointer file `ralph-run-dir` in the runs root and `INDEX.json` point here.");
L.push("");
try { fs.writeFileSync(path.join(runDir, "RUN-REPORT.md"), L.join("\n")); } catch (e) { sayG("✗", 31, `RUN-REPORT.md failed: ${e.message}`); }

// ---- 3. run-summary.json ----------------------------------------------------
const summary = {
  v: 1, at: new Date().toISOString(), run: runName, runDir, projectDir,
  status: finalStatus, exitReason, interrupted, monitorRc,
  childPid: status.childPid ?? null, guardPid: status.guardPid ?? null,
  sessionId: status.sessionId ?? null, sessionFile: status.sessionFile ?? null,
  attempt: status.attempt ?? null, rewinds: status.rewinds ?? null,
  deadlineIso: status.deadlineIso ?? null,
  lastTool: status.lastTool ?? null, lastToolStartedAt: status.lastToolStartedAt ?? null,
  ralph: { cycle: ralphState.cycle ?? null, interventions: ralphState.interventions ?? null, llmFailures: ralphState.llmFailures ?? null, lastNudge: ralphState.lastNudgeDisposition ?? null, session: ralphState.session ?? null },
  transcript,
  files,
  pointer: path.join(runsRoot, "ralph-run-dir"),
};
try { fs.writeFileSync(path.join(runDir, "run-summary.json"), JSON.stringify(summary, null, 2)); } catch (e) { sayG("✗", 31, `run-summary.json failed: ${e.message}`); }

// ---- 4. INDEX.json in the runs root ----------------------------------------
let indexUpdated = false;
try {
  const indexPath = path.join(runsRoot, "INDEX.json");
  let index = readJson(indexPath);
  if (!index || typeof index !== "object" || !Array.isArray(index.runs)) index = { v: 1, updated: null, runs: [] };
  index.updated = new Date().toISOString();
  const entry = {
    run: runName, dir: runDir, projectDir, at: summary.at,
    status: finalStatus, exitReason,
    transcriptLines: transcript.lines || null,
    report: "RUN-REPORT.md", summary: "run-summary.json",
  };
  const i = index.runs.findIndex((r) => r.run === runName);
  if (i >= 0) index.runs[i] = entry; else index.runs.push(entry);
  index.runs.sort((a, b) => a.run.localeCompare(b.run, undefined, { numeric: true }));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  indexUpdated = true;
} catch (e) { sayG("✗", 31, `INDEX.json failed: ${e.message}`); }

sayG("✓", 32, `${runName} — status=${finalStatus} transcript=${transcript.copied ? transcript.lines + " lines" : "n/a"} index=${indexUpdated ? "updated" : "failed"} → ${path.join(runDir, "RUN-REPORT.md")}`);
process.exit(0);
