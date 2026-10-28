#!/usr/bin/env node
// test-deadline-stop.mjs — tests for the v0.15.0 additions:
//   - launch.mjs --deadline  (size --timeout from a wall-clock deadline)
//   - stop.mjs               (graceful group SIGTERM → SIGKILL, verify, report)
//
// Like test-launch-monitor.mjs, a fake guard stands in for guard.mjs (no model
// needed). The fake guard always dumps its argv to <out>/argv.json (so we can
// assert what the guard actually received) and, in mode "stop", spawns a child
// sleeper in its own process group (simulating the pi RPC child) so we can
// verify the group kill takes down the whole tree, not just the leader.
//
// Run:  node test-deadline-stop.mjs [--keep]
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const KEEP = process.argv.includes("--keep");
const root = path.join(os.tmpdir(), `pi-sup-ds-${Date.now()}`);
mkdirSync(root, { recursive: true });
const node = process.execPath;

const FAKE = path.join(root, "fake-guard.mjs");
writeFileSync(FAKE, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const argv = process.argv.slice(2);
let outDir = process.cwd();
let mode = "idle";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out-dir") outDir = argv[++i];
  if (argv[i] === "--mode") mode = argv[++i];
}
writeFileSync(join(outDir, "argv.json"), JSON.stringify(argv));
const st = (status, extra = {}) => writeFileSync(
  join(outDir, "pi-child-status.json"),
  JSON.stringify({ v: 2, at: new Date().toISOString(), status, guardPid: process.pid, childPid: null, attempt: 1, sessionId: "fake-ds", toolCalls: 1, ...extra }, null, 2)
);
st("starting");
if (mode === "stop") {
  const c = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 600000)"], { stdio: "ignore" });
  writeFileSync(join(outDir, "childPid.json"), String(c.pid));
  c.unref();
}
setTimeout(() => st("running"), 200);
setTimeout(() => process.exit(0), 600000); // stay alive until killed
`);

let failures = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// launch the fake guard; return the last JSON line of launch.mjs
function launch(outDir, extra = []) {
  const r = spawnSync(node, [
    path.join(HERE, "launch.mjs"), "--guard", FAKE, "fake task",
    "--out-dir", outDir, ...extra, "--verify-sec", "4",
  ], { encoding: "utf8", timeout: 40000 });
  let j = null;
  try { j = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  return { code: r.status, json: j, raw: (r.stdout + r.stderr).slice(0, 400) };
}

function guardTimeoutArg(outDir) {
  try {
    const argv = JSON.parse(readFileSync(path.join(outDir, "argv.json"), "utf8"));
    const i = argv.indexOf("--timeout");
    return i >= 0 ? Number(argv[i + 1]) : null;
  } catch { return null; }
}

function runStop(outDir, extra = []) {
  const r = spawnSync(node, [
    path.join(HERE, "stop.mjs"), "--out-dir", outDir, "--grace-sec", "8", ...extra,
  ], { encoding: "utf8", timeout: 40000 });
  let j = null;
  try { j = JSON.parse(r.stdout.trim().split("\n").pop()); } catch {}
  return { code: r.status, json: j, raw: (r.stdout + r.stderr).slice(0, 400) };
}

// ---- --deadline math -------------------------------------------------------
// Use 47.5 min ahead: the floor is stable at 47 against any sub-minute clock
// skew between the test process and launch.mjs.
{
  const d = path.join(root, "d1");
  mkdirSync(d);
  const D = new Date(Date.now() + 47.5 * 60000);
  const L = launch(d, ["--mode", "idle", "--deadline", D.toISOString()]);
  const dl = L.json?.deadline;
  const guardTo = guardTimeoutArg(d);
  report("D1 deadline→timeout sized (finalize 10)",
    L.code === 0 && L.json?.launched === true && dl && dl.finalizeMin === 10
    && dl.timeoutMin >= 1 && guardTo === dl.timeoutMin
    && Math.abs(new Date(dl.finalizeAt).getTime() - D.getTime()) < 90000,
    `timeout=${dl?.timeoutMin} finalize=${dl?.finalizeMin} guardGot=${guardTo} |Δfinalize|=${dl ? Math.round((new Date(dl.finalizeAt) - D) / 1000) : "?"}s`);
}
{
  const d = path.join(root, "d2");
  mkdirSync(d);
  const D = new Date(Date.now() + 47.5 * 60000);
  const L = launch(d, ["--mode", "idle", "--deadline", D.toISOString(), "--finalize", "5"]);
  const dl = L.json?.deadline;
  const guardTo = guardTimeoutArg(d);
  report("D2 deadline honors --finalize 5",
    L.code === 0 && dl && dl.finalizeMin === 5 && guardTo === dl.timeoutMin
    && Math.abs(new Date(dl.finalizeAt).getTime() - D.getTime()) < 90000,
    `timeout=${dl?.timeoutMin} finalize=${dl?.finalizeMin} guardGot=${guardTo}`);
}
{
  const d = path.join(root, "d3");
  mkdirSync(d);
  const D = new Date(Date.now() + 3 * 60000); // too close: 3min < 10min finalize
  const L = launch(d, ["--mode", "idle", "--deadline", D.toISOString()]);
  report("D3 deadline too close → refused",
    L.code === 1 && L.json?.launched === false && /no work time/.test(L.json?.reason || ""),
    `code=${L.code} reason=${(L.json?.reason || "").slice(0, 60)}`);
}
{
  const d = path.join(root, "d4");
  mkdirSync(d);
  const L = launch(d, ["--mode", "idle", "--deadline", "not-a-time"]);
  report("D4 unparseable deadline → refused",
    L.code === 1 && L.json?.launched === false && /parse --deadline/.test(L.json?.reason || ""),
    `code=${L.code} reason=${(L.json?.reason || "").slice(0, 60)}`);
}
{
  // --deadline must be CONSUMED (never forwarded to the guard)
  const d = path.join(root, "d5");
  mkdirSync(d);
  const D = new Date(Date.now() + 47.5 * 60000);
  const L = launch(d, ["--mode", "idle", "--deadline", D.toISOString()]);
  let guardArgs = [];
  try { guardArgs = JSON.parse(readFileSync(path.join(d, "argv.json"), "utf8")); } catch {}
  report("D5 --deadline not forwarded to guard",
    L.json?.launched === true && !guardArgs.some((a) => a === "--deadline"),
    `guard argv=${JSON.stringify(guardArgs).slice(0, 80)}`);
}

// ---- stop.mjs --------------------------------------------------------------
{
  const d = path.join(root, "s1");
  mkdirSync(d);
  const L = launch(d, ["--mode", "stop"]);
  const S = runStop(d);
  let childPid = null;
  try { childPid = Number(readFileSync(path.join(d, "childPid.json"), "utf8").trim()); } catch {}
  const guardDead = !pidAlive(L.json?.guardPid);
  const childDead = childPid ? !pidAlive(childPid) : null;
  report("S1 stop kills guard + child group (SIGTERM)",
    L.json?.launched === true && S.code === 0 && S.json?.stopped === true
    && /SIGTERM-group/.test(S.json?.stoppedVia || "") && S.json?.confirmedDead?.guard === true
    && guardDead && childDead === true,
    `via=${S.json?.stoppedVia} guardDead=${guardDead} childDead=${childDead} file=${S.json?.finalStatusStatus}`);
}
{
  // S2: stopping an already-dead run (reuse the S1 dir whose guard is gone)
  const d = path.join(root, "s2");
  mkdirSync(d);
  writeFileSync(path.join(d, "pi-child-status.json"), JSON.stringify({
    v: 2, at: new Date().toISOString(), status: "running", guardPid: 99999999, childPid: null, attempt: 1,
  }));
  const S = runStop(d);
  report("S2 stop already-dead → already-dead, exit 0",
    S.code === 0 && S.json?.stopped === false && S.json?.stoppedVia === "already-dead",
    `via=${S.json?.stoppedVia} code=${S.code}`);
}
{
  // S3: no status file → exit 1, ambiguous (verify)
  const d = path.join(root, "s3");
  mkdirSync(d);
  const S = runStop(d);
  report("S3 stop no-status-file → exit 1 + verify",
    S.code === 1 && S.json?.stopped === false && /no status file/.test(S.json?.reason || ""),
    `code=${S.code} reason=${(S.json?.reason || "").slice(0, 50)}`);
}
{
  // S4: --force straight to SIGKILL
  const d = path.join(root, "s4");
  mkdirSync(d);
  const L = launch(d, ["--mode", "stop"]);
  const S = runStop(d, ["--force"]);
  report("S4 stop --force → SIGKILL-group",
    L.json?.launched === true && S.code === 0 && S.json?.stopped === true
    && /SIGKILL-group/.test(S.json?.stoppedVia || ""),
    `via=${S.json?.stoppedVia} code=${S.code}`);
}

// cleanup any leftover fake processes
for (const sub of ["d1", "d2", "d5", "s1", "s4"]) {
  try {
    const p = Number(readFileSync(path.join(root, sub, "pi-child-status.json"), "utf8").match(/"guardPid": ?(\d+)/)?.[1]);
    if (p && pidAlive(p)) { try { process.kill(-p, "SIGKILL"); } catch { try { process.kill(p, "SIGKILL"); } catch {} } }
  } catch {}
}

if (KEEP) console.log(`(kept artifacts in ${root})`);
else rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
