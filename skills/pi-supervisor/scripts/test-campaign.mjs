#!/usr/bin/env node
// test-campaign.mjs — tests for the v0.16.0 campaign primitive.
//
// Fake guard (same pattern as test-deadline-stop.mjs) + a fake project with a
// STATUS.md. Covers the plan's test matrix:
//   C0 init        creates <proj>/.pi-supervisor/<name>.json, .gitignore hint
//   C2 next        nothing to launch → exit 1 + reason
//   C1 next --goal launches (fake guard), run recorded, deadline math (window
//                  min + finalize reserve) — one JSON line on stdout
//   C4a status     latest run LIVE (pid check)
//   C4b next       while a run is live → refused
//   C4c record     ledger entry appended
//   C5 stop        delegates to stop.mjs, run's final status recorded in file
//   C3 status      post-stop → not live, manifest/status-file fields present
//   C7a scaffold   brief-run2.md contains last-run manifest tail + verified
//                  facts + STATUS.md tail + budget block
//   C7b next       --brief-file (edited) → run 2 launched, recorded
//   C6 done        1 check passes, 1 needs --confirm → exit 1; then --confirm
//                  → all pass → status=completed + done.md
//
// Run:  node test-campaign.mjs [--keep]
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const CAMPAIGN = path.join(HERE, "campaign.mjs");
const KEEP = process.argv.includes("--keep");
const root = path.join(os.tmpdir(), `pi-sup-camp-${Date.now()}`);
const proj = path.join(root, "proj");
mkdirSync(proj, { recursive: true });
const node = process.execPath;

const FAKE = path.join(root, "fake-guard.mjs");
writeFileSync(FAKE, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
let outDir = process.cwd();
for (let i = 0; i < argv.length; i++) { if (argv[i] === "--out-dir") outDir = argv[++i]; }
writeFileSync(join(outDir, "argv.json"), JSON.stringify(argv));
const st = (status, extra = {}) => writeFileSync(
  join(outDir, "pi-child-status.json"),
  JSON.stringify({ v: 2, at: new Date().toISOString(), status, guardPid: process.pid, childPid: null, attempt: 1, sessionId: "fake-camp", toolCalls: 3, ...extra }, null, 2)
);
st("starting");
setTimeout(() => st("running"), 200);
setTimeout(() => process.exit(0), 600000); // stay alive until killed
`);

writeFileSync(path.join(proj, "STATUS.md"), "# STATUS\n\n- r0.1: project bootstrapped\n- r0.2: world gen working\n");
writeFileSync(path.join(proj, ".gitignore"), "node_modules/\n");

let failures = 0;
const report = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

function sh(args, { cwd = proj, timeout = 120000 } = {}) {
  const r = spawnSync(node, [CAMPAIGN, ...args], { encoding: "utf8", cwd, timeout });
  let j = null;
  const lines = (r.stdout || "").trim().split("\n").filter(Boolean);
  if (lines.length) { try { j = JSON.parse(lines[lines.length - 1]); } catch {} }
  return { code: r.status, json: j, raw: (r.stdout + r.stderr).slice(0, 600) };
}

const CAMPFILE = path.join(proj, ".pi-supervisor", "demo.json");
const readCamp = () => { try { return JSON.parse(readFileSync(CAMPFILE, "utf8")); } catch { return null; } };
const deadline = new Date(Date.now() + 60 * 60000).toISOString(); // 1h from now

// ---------- C0 init ----------
let r = sh(["init", "--name", "demo", "--goal", "Build and demo the 10-slot hotbar", "--deadline", deadline, "--run-timeout-min", "40"]);
report("C0 init", r.code === 0 && r.json?.ok === true && existsSync(CAMPFILE), `code=${r.code} gitignoreHint=${!!r.json?.gitignoreHint}`);

// ---------- C2 next: nothing to launch ----------
r = sh(["next"]);
report("C2 next nothing-to-launch → refused", r.code === 1 && /nothing to launch/.test(r.json?.reason || ""), `code=${r.code}`);

// ---------- C1 next --goal → launches + records + deadline math ----------
const t0 = Date.now();
r = sh(["next", "--goal", "Implement the 10-slot hotbar + record a demo video", "--accept", "hotbar has 10 slots", "demo video renders", "--_guard", FAKE, "--_verify-sec", "4"]);
{
  const run = r.json?.run;
  const perRunMs = run ? new Date(run.deadline).getTime() : NaN;
  const mathOk = run && Math.abs(perRunMs - (t0 + 40 * 60000)) < 3 * 60000 && run.deadline < deadline && run.timeoutMin >= 25 && run.timeoutMin <= 30;
  const outBase = run ? path.basename(run.outDir) : "";
  report("C1 next --goal → launched + recorded + deadline math",
    r.code === 0 && r.json?.launched === true && /^pi-sup-demo-r1-\d{8}-\d{6}$/.test(outBase) && mathOk,
    `code=${r.code} outDir=${outBase} deadline=${run?.deadline} timeout=${run?.timeoutMin}`);
}

// ---------- C4a status → live ----------
r = sh(["status"]);
report("C4a status → latest run LIVE", r.code === 0 && r.json?.lastRun?.live === true && r.json?.runsSoFar === 1, `live=${r.json?.lastRun?.live} status=${r.json?.lastRun?.statusFile?.status}`);

// ---------- C4b next while live → refused (also proves --campaign resolution) ----------
r = sh(["next", "--goal", "second run attempt", "--campaign", CAMPFILE], { cwd: root });
report("C4b next while live → refused", r.code === 1 && /still LIVE/.test(r.json?.reason || ""), `code=${r.code}`);

// ---------- C4c record ----------
r = sh(["record", "hotbar texture-atlas slicing is done (commit abc123)", "--run", "1", "--verified-by", "manifest"]);
report("C4c record → ledger", r.code === 0 && r.json?.count === 1 && (readCamp().ledger || []).length === 1, `count=${r.json?.count}`);

// ---------- C5 stop (delegate) + C5b recorded ----------
r = sh(["stop", "--grace-sec", "0"]);
report("C5 campaign stop → kills fake guard", r.code === 0 && r.json?.ok === true, `via=${r.json?.stop?.stoppedVia}`);
{
  const f = readCamp();
  const note = f?.runs?.[0]?.note || "";
  report("C5b stop recorded in campaign file", /stopped via/.test(note), `note=${note.slice(0, 60)}`);
}

// ---------- C3 status post-stop ----------
r = sh(["status"]);
{
  const lr = r.json?.lastRun;
  report("C3 status post-stop → not live + fields", r.code === 0 && lr?.live === false && lr?.statusFile?.status === "running" && lr?.recordedStatus === "stopped" && lr?.session === "fake-camp",
    `live=${lr?.live} file=${lr?.statusFile?.status} recorded=${lr?.recordedStatus} session=${lr?.session}`);
}

// ---------- C7a scaffold ----------
r = sh(["scaffold"]);
{
  const bp = path.join(proj, ".pi-supervisor", "brief-run2.md");
  const brief = existsSync(bp) ? readFileSync(bp, "utf8") : "";
  const ok = r.code === 0 && existsSync(bp) && brief.includes("# Run 2") && brief.includes("## VERIFIED FACTS — do not re-derive")
    && brief.includes("hotbar texture-atlas slicing is done") && brief.includes("## This run's goal")
    && brief.includes("(none set — the parent must fill this in before launching)")
    && brief.includes("r0.2: world gen working") && brief.includes("## Budget") && brief.includes("campaign deadline");
  report("C7a scaffold → brief-run2.md", ok, `brief=${bp}`);
}

// ---------- C7b next --brief-file (edited) ----------
{
  const bp = path.join(proj, ".pi-supervisor", "brief-run2.md");
  const brief = readFileSync(bp, "utf8");
  writeFileSync(bp, brief.replace("(none set — the parent must fill this in before launching)", "Parent-edited run-2 goal: record the demo video"));
  r = sh(["next", "--brief-file", bp, "--_guard", FAKE, "--_verify-sec", "4"]);
  report("C7b next --brief-file → run 2 launched", r.code === 0 && r.json?.launched === true && r.json?.run?.id === 2 && r.json?.run?.brief === bp,
    `run=${r.json?.run?.id} out=${path.basename(r.json?.run?.outDir || "")}`);
}

// ---------- C6 done ----------
r = sh(["done"]);
report("C6a done while run live → refused", r.code === 1 && /still LIVE/.test(r.json?.reason || ""), `code=${r.code}`);

r = sh(["stop", "--grace-sec", "0"]); // stop run 2 before final acceptance
{
  const f = readCamp();
  f.acceptance = [
    { criterion: "demo.txt exists", check: "test -f demo.txt" },
    { criterion: "video shows 10 hotbar slots", check: null },
  ];
  writeFileSync(CAMPFILE, JSON.stringify(f, null, 2) + "\n");
  writeFileSync(path.join(proj, "demo.txt"), "demo");
}

r = sh(["done"]);
report("C6b done 1/2 (parent check missing) → exit 1",
  r.code === 1 && r.json?.rows?.length === 2 && r.json.rows[0]?.pass === true && r.json.rows[1]?.pass === false,
  `rows=${JSON.stringify(r.json?.rows?.map((x) => x.pass))}`);

r = sh(["done", "--confirm", "video shows 10 hotbar slots"]);
{
  const f = readCamp();
  const dm = existsSync(path.join(proj, ".pi-supervisor", "done.md"));
  report("C6c done --confirm → completed + done.md", r.code === 0 && r.json?.allPass === true && f?.status === "completed" && dm,
    `status=${f?.status} done.md=${dm}`);
}

// ---------- cleanup: kill any surviving fake guards, remove root ----------
for (const run of readCamp()?.runs || []) {
  const stf = path.join(run.outDir, "pi-child-status.json");
  try {
    if (!existsSync(stf)) continue;
    const pid = JSON.parse(readFileSync(stf, "utf8")).guardPid;
    if (Number.isInteger(pid) && pid > 0) {
      if (process.platform === "win32") spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      else { try { process.kill(-pid, "SIGKILL"); } catch {} }
    }
  } catch {}
}
if (!KEEP) rmSync(root, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILURE(S)` : "ALL PASS");
process.exit(failures ? 1 : 0);
