#!/usr/bin/env node
// test-e2e.mjs — v0.26.0 sub-runs E2E acceptance (plan §7).
//
// The full chain through the REAL chain.mjs + node.mjs, with only launch.mjs
// stubbed (it spawns a detached `sleep` as the fake guard) and the child's
// WORK simulated by writing the guard's terminal status + the monitor's
// FINAL-REPORT.md — exactly the artifacts the chain reads on disk:
//
//   root/run-1 (stub writes a spawn-request, exits clean)
//     ⇒ chain spawns auth/run-1 (sub brief, task verbatim)
//     ⇒ auth/run-1 meets the goal (FINAL-REPORT carries AUTH-GOAL-MET)
//     ⇒ chain launches root/run-2 re-entry (brief embeds auth's report +
//       the spawn decision that launched it)
//     ⇒ re-entry declares done ⇒ chain idle, active.json cleared
//
// Asserts (per the plan): node tree, STATE.md trails, spawn decisions,
// INDEX.json, the active.json lifecycle, idempotent re-step.
// v0.30.0: the re-entry RESUMES root's pre-spawn session (launch-args
// carry --session, the brief is the resume hand-off, not bookkeeping).
//
// Run:  node test-e2e.mjs [--keep]
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const KEEP = process.argv.includes("--keep");
const root = path.join(os.tmpdir(), `pi-sup-e2e-${Date.now()}`);
mkdirSync(root, { recursive: true });

let failures = 0;
const R = [];
function r(name, ok, detail = "") { R.push([name, ok, detail]); }   // failures counted at the end

// ---- sandbox: real chain/node/harvest, stub launch.mjs ---------------------
const sbx = path.join(root, "sbx");
cpSync(HERE, sbx, { recursive: true });
const stubLaunch = path.join(sbx, "launch.mjs");
writeFileSync(stubLaunch, `
import fs from "fs"; import path from "path"; import { spawn } from "child_process";
const a = process.argv.slice(2);
const get = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
const out = get("--out-dir"); const project = get("--project"); const node = get("--node");
const dl = Number(get("--deadline"));
fs.writeFileSync(path.join(out, "launch-args.json"), JSON.stringify({
  taskFile: get("--task-file"), node, deadline: get("--deadline"),
  idleTimeout: get("--idle-timeout"), turnStall: get("--turn-stall"), finalize: get("--finalize"),
  session: get("--session"),
}, null, 2));
const s = spawn("sleep", ["300"], { detached: true, stdio: "ignore" }); s.unref();
fs.writeFileSync(path.join(out, "pi-child-status.json"), JSON.stringify({
  v: 2, at: new Date().toISOString(), status: "running", exitReason: null,
  guardPid: s.pid, childPid: s.pid, attempt: 1, rewinds: 0, toolCalls: 0, elapsedMs: 0,
  deadlineIso: new Date(dl * 1000).toISOString(),
}, null, 2));
const base = path.basename(out);
// v2: --project is the WINDOW's own project — the pointer goes there
fs.writeFileSync(path.join(project, ".pi-supervisor", "active.json"), JSON.stringify({
  run_dir: out, node, guard_pid: s.pid, window: /^run-\\d+$/.test(base) ? base : null,
  started_at: new Date().toISOString(), deadline: new Date(dl * 1000).toISOString(),
}, null, 2));
console.log(JSON.stringify({ launched: true, guardPid: s.pid }));
`);
const { step } = await import(path.join(sbx, "lib", "chain.mjs"));
const M = await import(path.join(sbx, "lib", "node.mjs"));

// ---- project ---------------------------------------------------------------
const proj = path.join(root, "proj");
mkdirSync(path.join(proj, "tasks"), { recursive: true });
const taskFile = path.join(proj, "tasks", "auth-task.md");
writeFileSync(taskFile, "AUTH_TASK_BODY — implement the auth sub-project (stub goal).");
const runs = M.runsRoot(proj);           // the root's windows dir
const DL_ROOT = new Date(Date.now() + 2 * 3600e3).toISOString();
M.ensureRootNode(proj, { deadline: DL_ROOT });
const DL_AUTH = new Date(Date.now() + 3600e3).toISOString();
const projOf = (nodePath) => nodePath === M.ROOT ? proj : M.projectOfNode(proj, nodePath).dir;
const active = (nodePath) => M.activePath(projOf(nodePath));
const jread = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const CFG = {   // mirrors the guard hook's cfg (guard.mjs v0.26.0 block)
  repair: false,
  launch: { preamble: "standard", idleTimeoutSec: 300, turnStallSec: 900, finalizeMin: 10, runtimeMin: 90 },
  log: () => {},
};
function launch(wdir, nodePath, taskText, deadlineEpoch) {
  writeFileSync(path.join(wdir, "TASK.md"), taskText);
  const r = spawnSync(NODE, [stubLaunch,
    "--task-file", path.join(wdir, "TASK.md"), "--out-dir", wdir,
    "--project", proj, "--node", nodePath, "--deadline", String(deadlineEpoch),
    "--idle-timeout", "300", "--turn-stall", "900", "--finalize", "10"], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`stub launch failed: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
}
// One simulated child: (optionally) a spawn request while alive, then a clean
// terminal status + the monitor's FINAL-REPORT.md.
function endChild(wdir, { request = null, report = null } = {}) {
  const st = jread(path.join(wdir, "pi-child-status.json"));
  if (request) writeFileSync(path.join(wdir, "spawn-request.json"), JSON.stringify(request, null, 2));
  if (report) writeFileSync(path.join(wdir, "FINAL-REPORT.md"), report);
  try { process.kill(st.guardPid, "SIGKILL"); } catch { /* already gone */ }
  writeFileSync(path.join(wdir, "pi-child-status.json"), JSON.stringify({
    ...st, status: "completed", exitReason: "completed", guardPid: null,
    at: new Date().toISOString(),
  }, null, 2));
}

// ================= W1: root/run-1 spawns auth =================
const wa1 = M.allocWindowIn(runs);
const w1 = wa1.window; const w1d = path.join(runs, w1);
launch(w1d, M.ROOT, "ROOT_TASK_BODY — parent's work; spawn the auth sub-project when ready.", Math.floor(Date.now() / 1000) + 7200);
// v0.30.0: simulate the guard recording this window's session file (small —
// under the resume gate), so the re-entry after auth has something to resume.
const sessRoot1 = path.join(w1d, "pi-child-session.jsonl");
writeFileSync(sessRoot1, JSON.stringify({ type: "message", role: "assistant", content: "root run-1 session marker" }) + "\n");
{
  const st = jread(path.join(w1d, "pi-child-status.json"));
  st.sessionFile = sessRoot1; st.sessionId = "e2e-root-run-1";
  writeFileSync(path.join(w1d, "pi-child-status.json"), JSON.stringify(st, null, 2));
}
endChild(w1d, {
  request: { kind: "spawn", node: "auth", task: taskFile, deadline: DL_AUTH },
  report: "Parent window 1: paused to spawn auth. Parent work so far recorded in STATE.md.",
});
const step1 = await step(proj, w1d, CFG);
const authDir = M.projectOfNode(proj, "auth").dir;
const authW1 = path.join(authDir, ".pi-supervisor", "runs", "run-1");
const authBrief = existsSync(path.join(authW1, "TASK.md")) ? readFileSync(path.join(authW1, "TASK.md"), "utf8") : "";
r("W1 step → spawned auth/run-1", step1?.outcome?.next === "spawned" && step1.outcome.node_path === "auth" && step1.outcome.window === "run-1" && step1.outcome.run_dir === authW1,
  JSON.stringify(step1?.outcome ?? step1));
r("W1 auth/run-1 sub brief: header + task verbatim + sub rules + budget",
  authBrief.startsWith("# SUB-PROJECT — auth") && authBrief.includes("AUTH_TASK_BODY") && /Sub-run rules/.test(authBrief) && /minutes/.test(authBrief),
  authBrief.split("\n")[0] || "(missing)");
const dec1 = jread(path.join(w1d, "spawn-decision.json"));
r("W1 spawn-decision.json ok (node auth, deadline ≈ request)", Boolean(dec1?.ok) && dec1.node_path === "auth" && dec1.window === "run-1", JSON.stringify(dec1 || null).slice(0, 140));
const rootNode1 = jread(path.join(proj, ".pi-supervisor", "node.json"));
r("W1 root node paused(waiting:auth)", rootNode1?.state === "paused(waiting:auth)", `state=${rootNode1?.state}`);
const act1 = jread(active("auth"));
r("W1 active.json → auth/run-1 (live guard, in the sub-project)", act1?.run_dir === authW1 && act1?.node === "auth" && alive(act1?.guard_pid), JSON.stringify(act1 || null).slice(0, 140));
const stRoot1 = readFileSync(path.join(proj, "STATE.md"), "utf8");
r("W1 root STATE.md spawn entry", /child auth spawned — window run-1 launched/.test(stRoot1), stRoot1.trim().split("\n").slice(-1)[0]?.slice(0, 120));
const authNode1 = jread(path.join(authDir, ".pi-supervisor", "node.json"));
r("W1 auth node exists, deadline inherited from request", authNode1 && authNode1.state === "active" && new Date(authNode1.deadline).getTime() === new Date(DL_AUTH).getTime(), JSON.stringify(authNode1 || null).slice(0, 140));

// ================= W2: auth/run-1 meets the goal =================
endChild(authW1, { report: "Auth sub-project complete.\nAUTH-GOAL-MET\nCredentials module tested; see STATE.md." });
const step2 = await step(proj, authW1, CFG);
const rootW2 = path.join(runs, "run-2");
const reentryBrief = existsSync(path.join(rootW2, "TASK.md")) ? readFileSync(path.join(rootW2, "TASK.md"), "utf8") : "";
r("W2 step → reentry root/run-2", step2?.outcome?.next === "reentry" && step2.outcome.node_path === M.ROOT && step2.outcome.window === "run-2" && step2.outcome.run_dir === rootW2, JSON.stringify(step2?.outcome ?? step2));
const reLaunch = jread(path.join(rootW2, "launch-args.json"));
r("W2 re-entry RESUMED root's pre-spawn session (v0.30.0)", reLaunch?.session === sessRoot1, JSON.stringify(reLaunch || null).slice(0, 160));
r("W2 re-entry brief is the resume hand-off (full context, no bookkeeping-only rule)", reentryBrief.includes("RE-ENTRY (resume)") && reentryBrief.includes("RESUMES your own session") && !reentryBrief.includes("BOOKKEEPING"), reentryBrief.split("\n")[0] || "(missing)");
r("W2 outcome flags resumed (v0.30.0)", step2?.outcome?.resumed === true, JSON.stringify(step2?.outcome ?? {}));
r("W2 re-entry brief embeds auth's FINAL-REPORT (AUTH-GOAL-MET)", reentryBrief.includes("# RE-ENTRY") && reentryBrief.includes("AUTH-GOAL-MET") && /child node `auth` has ended \(state: done\)/.test(reentryBrief), reentryBrief.split("\n").slice(0, 4).join(" | ").slice(0, 160));
r("W2 re-entry brief embeds the spawn decision that launched auth", reentryBrief.includes('"node_path": "auth"') && reentryBrief.includes('"window": "run-1"'), (reentryBrief.match(/spawn decision[\s\S]{0,120}/) || ["(no decision section)"])[0].slice(0, 160));
const authNode2 = jread(path.join(authDir, ".pi-supervisor", "node.json"));
r("W2 auth node done + STATE.md trail", authNode2?.state === "done" && /window run-1 completed — node done/.test(readFileSync(path.join(authDir, "STATE.md"), "utf8")), `state=${authNode2?.state}`);
const act2 = jread(active(M.ROOT));
r("W2 active.json → root/run-2 (live guard)", act2?.run_dir === rootW2 && alive(act2?.guard_pid), JSON.stringify(act2 || null).slice(0, 140));
r("W2 harvest ran (RUN-REPORT + INDEX) without clobbering FINAL-REPORT",
  existsSync(path.join(authW1, "RUN-REPORT.md"))
  && readFileSync(path.join(authW1, "FINAL-REPORT.md"), "utf8").includes("AUTH-GOAL-MET")
  && existsSync(path.join(authDir, ".pi-supervisor", "runs", "INDEX.json")),
  `RUN-REPORT=${existsSync(path.join(authW1, "RUN-REPORT.md"))} INDEX(auth)=${existsSync(path.join(authDir, ".pi-supervisor", "runs", "INDEX.json"))}`);

// ================= W3: root/run-2 declares the node done =================
endChild(rootW2, { report: "Re-entry: auth outcome distilled into STATE.md. Node (root) declares done.\nROOT-DONE" });
const step3 = await step(proj, rootW2, CFG);
r("W3 step → idle (root-done)", step3?.outcome?.next === "idle" && step3.outcome.reason === "root-done", JSON.stringify(step3?.outcome ?? step3));
r("W3 active.json cleared (unlinked)", !existsSync(active(M.ROOT)), existsSync(active(M.ROOT)) ? "still present" : "gone");
const rootNode3 = jread(path.join(proj, ".pi-supervisor", "node.json"));
r("W3 root node done + STATE.md trail", rootNode3?.state === "done" && /window run-2 completed — node done/.test(readFileSync(path.join(proj, "STATE.md"), "utf8")), `state=${rootNode3?.state}`);

// ================= invariants: idempotency, INDEX, tree =================
const s1b = await step(proj, w1d, CFG);
const s2b = await step(proj, authW1, CFG);
r("re-step is a no-op (chain-done marker, both windows)", s1b?.skipped === "chain-done" && s2b?.skipped === "chain-done", JSON.stringify({ s1b, s2b }));
const idxRoot = existsSync(path.join(runs, "INDEX.json")) ? readFileSync(path.join(runs, "INDEX.json"), "utf8") : "";
const idxAuth = existsSync(path.join(authDir, ".pi-supervisor", "runs", "INDEX.json")) ? readFileSync(path.join(authDir, ".pi-supervisor", "runs", "INDEX.json"), "utf8") : "";
r("INDEX.json: runs/ has run-1+run-2, the auth sub-project has run-1",
  /run-1/.test(idxRoot) && /run-2/.test(idxRoot) && /run-1/.test(idxAuth), `root=${idxRoot.length}B auth=${idxAuth.length}B`);
const tree = M.renderTree(proj, { now: new Date() });
console.log("\n" + tree + "\n");
r("node tree: root (2 windows, done) + auth (done)",
  tree.includes("(root)") && tree.includes("auth") && /2 windows/.test(tree) && /DONE/.test(tree), tree.split("\n").map((l) => l.trim()).join(" | ").slice(0, 200));
r("chain.log trail per window (step start + done)",
  [w1d, authW1, rootW2].every((d) => /step start:/.test(readFileSync(path.join(d, "chain.log"), "utf8")) && /step done:/.test(readFileSync(path.join(d, "chain.log"), "utf8"))), "");

// ---- print + exit ----------------------------------------------------------
for (const [name, ok, detail] of R) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
  if (!ok) failures++;
}
console.log(`\n${R.length - failures}/${R.length} passed${failures ? " — FAILURES" : " — ALL PASS"}`);
if (KEEP) console.log(`(kept artifacts in ${root})`);
process.exit(failures ? 1 : 0);
