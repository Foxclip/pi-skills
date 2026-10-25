#!/usr/bin/env node
// test-launch-monitor.mjs — end-to-end smoke test for launch.mjs + monitor.mjs.
//
// No model needed: a fake guard (written to a temp dir) mimics guard.mjs v0.13.0's
// status-file contract (v:2 payload, "starting" before spawn, 2s heartbeat).
// Verifies:
//   T1 launch   launch.mjs verifies (process alive + status appeared) and reports
//   T2 settle   monitor returns reason=settle well before the --cycle-min cap
//   T3 expected monitor returns reason=expected when all expectedFiles are true
//   T4 liveness kill the guard's process tree; monitor returns reason=liveness
//                (guard-pid-dead) fast — the stale "running" file must NOT hold it
//   T5 stale     a v:1 file with an old `at` → reason=liveness (status-stale)
//
// Run:  node test-launch-monitor.mjs [--keep]
import { spawnSync, execSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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

// T3: monitor returns on expected files
{
  const d = path.join(root, "t3");
  mkdirSync(d);
  const L = await runLaunch(d, ["--mode", "expected"]);
  const M = await runMonitor(path.join(d, "pi-child-status.json"), ["--cycle-min", "1"]);
  report("T3 monitor expected-early", L.json?.launched === true
    && M.json?.reason === "expected", `reason=${M.json?.reason} t=${M.secs}s`);
  if (L.json?.guardPid) killTree(L.json.guardPid);
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

if (KEEP) console.log(`(kept artifacts in ${root})`);
else rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
