#!/usr/bin/env node
// test-launch-monitor.mjs — end-to-end smoke test for launch.mjs + monitor.mjs.
//
// No model needed: a fake guard (written to a temp dir) mimics guard.mjs v0.13.0's
// status-file contract (v:2 payload, "starting" before spawn, 2s heartbeat).
// Verifies:
//   T1 launch   launch.mjs verifies (process alive + status appeared) and reports
//   T2 settle   monitor returns reason=settle well before the --cycle-min cap
//   T3 manifest  monitor returns reason=settled-manifest when the result
//                 manifest appears while the status still says running
//   T3b expected regression — expectedFiles no longer trigger an early
//                 return (the report file is usually scaffolded early); with a
//                 dead guardPid the monitor must fall through to reason=liveness
//   T4 liveness kill the guard's process tree; monitor returns reason=liveness
//                (guard-pid-dead) fast — the stale "running" file must NOT hold it
//   T5 stale     a v:1 file with an old `at` → reason=liveness (status-stale)
//
// Run:  node test-launch-monitor.mjs [--keep]
import { spawnSync, execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync as existsSync0, readdirSync as readdirSync0 } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEEP = process.argv.includes("--keep");
const root = path.join(os.tmpdir(), `pi-sup-lm-${Date.now()}`);
mkdirSync(root, { recursive: true });

const FAKE_GUARD = path.join(root, "fake-guard.mjs");
writeFileSync(
  FAKE_GUARD,
  `#!/usr/bin/env node
// fake guard: mimics the v:2 status contract of guard.mjs v0.13.0
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
let outDir = process.cwd();
let mode = "complete";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out-dir") outDir = argv[++i];
  if (argv[i] === "--mode") mode = argv[++i];
}
const st = (status, extra = {}) =>
  writeFileSync(
    join(outDir, "pi-child-status.json"),
    JSON.stringify({
      v: 2,
      at: new Date().toISOString(),
      status,
      guardPid: process.pid,
      childPid: null,
      attempt: 1,
      sessionId: "fake-1",
      toolCalls: 1,
      ...extra,
    }, null, 2)
  );
st("starting");
setTimeout(() => st("running", {
  expectedFiles: mode === "expected" ? { "done.txt": true } : undefined,
}), 500);
const hb = setInterval(() => {
  if (mode === "complete" || mode === "idle" || mode === "expected")
    st("running", { expectedFiles: mode === "expected" ? { "done.txt": true } : undefined });
}, 2000);
if (mode === "complete") {
  setTimeout(() => { st("completed", { exitReason: "completed" }); clearInterval(hb); process.exit(0); }, 3000);
} else {
  setTimeout(() => process.exit(0), 120000); // idle / expected: run until killed
}
`
);

const node = process.execPath;
let failures = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

async function runLaunch(outDir, extra = []) {
  const r = spawnSync(node, [
    path.join(HERE, "launch.mjs"), "--guard", FAKE_GUARD, "fake task",
    "--out-dir", outDir, ...extra, "--verify-sec", "6",
  ], { encoding: "utf8", timeout: 30000 });
  let j = null;
  try { j = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  return { code: r.status, json: j, raw: r.stdout + r.stderr };
}

async function runMonitor(statusPath, extra = []) {
  const t0 = Date.now();
  const r = spawnSync(node, [
    path.join(HERE, "monitor.mjs"), "--status", statusPath, "--poll", "5", ...extra,
  ], { encoding: "utf8", timeout: 60000 });
  const secs = Math.round((Date.now() - t0) / 100) / 10;
  let j = null;
  try { j = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  return { code: r.status, json: j, secs, raw: r.stdout + r.stderr };
}

// T1: launch verifies
{
  const d = path.join(root, "t1");
  mkdirSync(d);
  const L = await runLaunch(d, ["--mode", "idle"]);
  report("T1 launch verifies", L.json?.launched === true && Number.isInteger(L.json?.guardPid)
    && (L.json?.status?.status === "running" || L.json?.status?.status === "starting"),
    JSON.stringify(L.json || L.raw.slice(0, 200)));
  globalThis.T1_PID = L.json?.guardPid || null;
  globalThis.T1_DIR = d;
}

// T2: monitor settles early (cap 1 min, fake completes at 3s)
{
  const d = path.join(root, "t2");
  mkdirSync(d);
  const L = await runLaunch(d, ["--mode", "complete"]);
  const M = await runMonitor(path.join(d, "pi-child-status.json"), ["--cycle-min", "1"]);
  report("T2 monitor settle early", L.json?.launched === true
    && M.json?.reason === "settle" && M.json?.status === "completed" && M.secs < 30,
    `reason=${M.json?.reason} status=${M.json?.status} t=${M.secs}s`);
}

// T3: monitor returns on the result manifest (status still running)
{
  const d = path.join(root, "t3");
  mkdirSync(d);
  writeFileSync(path.join(d, "pi-child-status.json"), JSON.stringify({
    v: 2, at: new Date(Date.now() - 5000).toISOString(), status: "running",
    guardPid: process.pid, childPid: null, attempt: 1, sessionId: "fake-3", toolCalls: 1,
  }));
  writeFileSync(path.join(d, "pi-child-result.json"), JSON.stringify({
    v: 1, finishedAt: new Date().toISOString(), result: { status: "completed" },
  }));
  const M = await runMonitor(path.join(d, "pi-child-status.json"), ["--cycle-min", "1"]);
  report("T3 monitor settled-manifest", M.json?.reason === "settled-manifest",
    `reason=${M.json?.reason} t=${M.secs}s`);
}

// T3b: regression — expected files present + DEAD guardPid → liveness, not
// "expected" (the pre-v0.14.0 code returned reason=expected here, because a
// living-report file made the early-return fire on every cycle)
{
  const d = path.join(root, "t3b");
  mkdirSync(d);
  writeFileSync(path.join(d, "done.txt"), "artifact");
  writeFileSync(path.join(d, "pi-child-status.json"), JSON.stringify({
    v: 2, at: new Date().toISOString(), status: "running",
    guardPid: 99999999, childPid: null, attempt: 1, sessionId: "fake-3b", toolCalls: 1,
    expectedFiles: { "done.txt": true },
  }));
  const M = await runMonitor(path.join(d, "pi-child-status.json"), ["--cycle-min", "1", "--liveness-min", "1"]);
  report("T3b no expected early-return", M.json?.reason === "liveness" && M.json?.liveness === "guard-pid-dead",
    `reason=${M.json?.reason} liveness=${M.json?.liveness} t=${M.secs}s`);
}

// T4: killed run → liveness (stale "running" file must not hold the monitor)
{
  const d = globalThis.T1_DIR; // the T1 idle run
  const pid = globalThis.T1_PID;
  killTree(pid);
  const M = await runMonitor(path.join(d, "pi-child-status.json"), ["--cycle-min", "1", "--liveness-min", "1"]);
  report("T4 monitor liveness on kill", M.json?.reason === "liveness" && M.json?.liveness === "guard-pid-dead" && M.secs < 30,
    `reason=${M.json?.reason} liveness=${M.json?.liveness} t=${M.secs}s (file stayed: ${readFileSync(path.join(d, "pi-child-status.json"), "utf8").match(/"status":\s*"\w+"/)?.[0] || "?"})`);
}

// T5: v:1 stale freshness
{
  const d = path.join(root, "t5");
  mkdirSync(d);
  writeFileSync(path.join(d, "pi-child-status.json"), JSON.stringify({
    v: 1, status: "running", at: new Date(Date.now() - 10 * 60000).toISOString(),
  }));
  const M = await runMonitor(path.join(d, "pi-child-status.json"), ["--cycle-min", "1", "--liveness-min", "1"]);
  report("T5 v1 stale freshness", M.json?.reason === "liveness" && M.json?.liveness === "status-stale",
    `reason=${M.json?.reason} liveness=${M.json?.liveness} t=${M.secs}s`);
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      if (process.platform === "win32") execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
      else process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
}

// ---------------------------------------------------------------------------
// v0.17.0: launch aliases, epoch deadlines, monitor auto-tag + deadline
// countdown + --steer (the parent nudge channel)
// ---------------------------------------------------------------------------

// V1: --state-dir / --tag aliases map with a stderr warning (pre-v0.17.0:
// hard "unknown flag" failures after a silent 240-min fallback had confused a parent)
{
  const d = path.join(root, "v1");
  mkdirSync(d);
  const r = spawnSync(node, [
    path.join(HERE, "launch.mjs"), "--guard", FAKE_GUARD, "fake task",
    "--state-dir", d, "--tag", "v1name", "--mode", "idle", "--verify-sec", "6",
  ], { encoding: "utf8", timeout: 30000 });
  let j = null; try { j = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  const stExists = existsSync0(path.join(d, "pi-child-status.json"));
  report("V1 aliases --state-dir/--tag", r.status === 0 && j?.launched === true && stExists
    && /alias for --out-dir/.test(r.stderr) && /alias for --name/.test(r.stderr),
    `exit=${r.status} launched=${j?.launched} statusInDir=${stExists} err=${(r.stderr || "").split("\n").slice(0, 2).join(" | ")}`);
  killTree(j?.guardPid || null);
}

// V2: epoch deadlines (13 digits = ms exact, 10 digits = seconds ±2s)
{
  const d = path.join(root, "v2a");
  mkdirSync(d);
  const epochMs = Date.now() + 25 * 60000;
  const L1 = await runLaunch(d, ["--mode", "idle", "--deadline", String(epochMs)]);
  report("V2a epoch ms (13 digits) → exact deadlineMs",
    L1.code === 0 && L1.json?.deadline?.deadline === new Date(epochMs).toISOString(),
    `exit=${L1.code} deadline=${L1.json?.deadline?.deadline} want=${new Date(epochMs).toISOString()}`);
  killTree(L1.json?.guardPid || null);

  const d2 = path.join(root, "v2b");
  mkdirSync(d2);
  const epochS = Math.floor((Date.now() + 25 * 60000) / 1000);
  const L2 = await runLaunch(d2, ["--mode", "idle", "--deadline", String(epochS)]);
  const got = L2.json?.deadline ? Date.parse(L2.json.deadline.deadline) : NaN;
  report("V2b epoch seconds (10 digits) → deadlineMs within 2s",
    L2.code === 0 && Number.isFinite(got) && Math.abs(got - epochS * 1000) <= 2000
    && /\[epoch \d{10}\]/.test(L2.json?.deadline?.deadlineLocal || ""),
    `exit=${L2.code} got=${new Date(got || 0).toISOString()} want≈${new Date(epochS * 1000).toISOString()} local=${L2.json?.deadline?.deadlineLocal}`);
  killTree(L2.json?.guardPid || null);
}

// V3: monitor auto-tag (no --tag) + deadline countdown in the output
{
  const d = path.join(root, "v3");
  mkdirSync(d);
  writeFileSync(path.join(d, "pi-child-status.json"), JSON.stringify({
    v: 2, at: new Date().toISOString(), status: "completed", exitReason: "completed",
    guardPid: 99999999, attempt: 1, sessionId: "v3", toolCalls: 1,
    deadlineIso: new Date(Date.now() + 30 * 60000).toISOString(),
  }));
  const M = await runMonitor(path.join(d, "pi-child-status.json"), ["--cycle-min", "1"]);
  report("V3 monitor auto-tag + deadline countdown",
    M.json?.reason === "settle"
    && typeof M.json?.tag === "string" && M.json.tag.startsWith("auto-"),
    `reason=${M.json?.reason} tag=${M.json?.tag}`);
  const dl = M.json?.deadline;
  report("V3b deadline countdown", dl && typeof dl.remainingMin === "number" && dl.remainingMin >= 28 && dl.remainingMin <= 30,
    JSON.stringify(dl));
}

// V4: monitor --steer on a LIVE run → writes the inbox file (the parent nudge channel)
{
  const d = path.join(root, "v4");
  mkdirSync(d);
  writeFileSync(path.join(d, "pi-child-status.json"), JSON.stringify({
    v: 2, at: new Date().toISOString(), status: "running", guardPid: 1, attempt: 1, sessionId: "v4", toolCalls: 1,
  }));
  const r = spawnSync(node, [
    path.join(HERE, "monitor.mjs"), "--status", path.join(d, "pi-child-status.json"),
    "--steer", "PARENT_V4_MESSAGE: also check the self-test",
  ], { encoding: "utf8", timeout: 15000 });
  const inbox = path.join(d, ".steer-inbox");
  const files = existsSync0(inbox) ? readdirSync0(inbox).filter((f) => f.endsWith(".txt")) : [];
  const content = files.length ? readFileSync(path.join(inbox, files[0]), "utf8") : "";
  report("V4 monitor --steer live → inbox file written",
    r.status === 0 && JSON.parse(r.stdout.trim().split("\n").pop())?.steer === true
    && files.length === 1 && content === "PARENT_V4_MESSAGE: also check the self-test",
    `exit=${r.status} files=${JSON.stringify(files)} content=${JSON.stringify(content.slice(0, 60))}`);
}

// V5: monitor --steer on a DEAD run → exit 1, nothing written
{
  const d = path.join(root, "v5");
  mkdirSync(d);
  writeFileSync(path.join(d, "pi-child-status.json"), JSON.stringify({
    v: 2, at: new Date().toISOString(), status: "running", guardPid: 99999999, attempt: 1, sessionId: "v5", toolCalls: 1,
  }));
  const r = spawnSync(node, [
    path.join(HERE, "monitor.mjs"), "--status", path.join(d, "pi-child-status.json"),
    "--steer", "PARENT_V5_MESSAGE",
  ], { encoding: "utf8", timeout: 15000 });
  const inbox = path.join(d, ".steer-inbox");
  const files = existsSync0(inbox) ? readdirSync0(inbox).filter((f) => f.endsWith(".txt")) : [];
  report("V5 monitor --steer dead run → exit 1, nothing written",
    r.status === 1 && files.length === 0 && /no live run to steer/.test(r.stdout + r.stderr),
    `exit=${r.status} files=${JSON.stringify(files)}`);
}

if (KEEP) console.log(`(kept artifacts in ${root})`);
else rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
