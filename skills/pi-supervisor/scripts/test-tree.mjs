#!/usr/bin/env node
// test-tree.mjs — stage 4 banner tests (plan T9). renderTree(): box shape
// (equal-width lines, corners, title), one line per node in bookkeep order,
// live windows name their window + age, paused nodes name the child they wait
// on, deadlines render short. Rendered output is append-only terminal
// decoration — nothing here mutates state.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as M from "./lib/node.mjs";

const R = [];
let fails = 0;
function check(name, cond, extra = "") {
  R.push([cond ? "PASS" : "FAIL", name, extra]);
  if (!cond) fails++;
}

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sup-tree-"));
const NOW = new Date("2026-11-04T08:00:00Z");
const DL = "2026-11-05T06:00:00Z";

// Empty project: just the root, state unknown (no node.json yet is not an
// error — the banner must never throw).
let t = M.renderTree(projectDir, { now: NOW });
check("empty: renders root line", /\(root\)/.test(t) && /UNKNOWN/i.test(t), t);
{
  const lines = t.split("\n");
  check("empty: box shape", lines[0].startsWith("╭") && lines.at(-1).startsWith("╰") && lines.every((l) => l.length === lines[0].length), JSON.stringify(lines.map((l) => l.length)));
}

// Fixture: root active, auth has a LIVE run-1 (guardPid = this test process,
// which is alive), docs is paused waiting on root.
M.ensureNode(projectDir, "", { deadline: DL, name: "(root)" });
M.ensureNode(projectDir, "auth", { deadline: DL, name: "auth" });
M.ensureNode(projectDir, "docs", { deadline: DL, name: "docs", state: "paused(waiting:root)" });
const wd = path.join(M.nodeDir(projectDir, "auth"), "run-1");
fs.mkdirSync(wd, { recursive: true });
fs.writeFileSync(path.join(wd, "pi-child-status.json"), JSON.stringify({ guardPid: process.pid, at: new Date(NOW - 2 * 3600e3).toISOString(), phase: "running" }));

t = M.renderTree(projectDir, { now: NOW });
console.log(t + "\n");
check("fixture: box shape (equal width, corners)", (() => {
  const lines = t.split("\n");
  return lines[0].startsWith("╭") && lines.at(-1).startsWith("╰") && lines.every((l) => l.length === lines[0].length);
})(), JSON.stringify(t.split("\n").map((l) => l.length)));
check("fixture: title has project basename", t.split("\n")[0].includes(path.basename(projectDir)), t.split("\n")[0]);
check("fixture: root line ACTIVE + deadline", (() => {
  const l = t.split("\n").find((l) => l.includes("(root)") && !l.startsWith("╭"));
  return l && /ACTIVE/.test(l) && /deadline 11-05 06:00/.test(l);
})());
check("fixture: auth line is live (run-1 + 2h age)", (() => {
  const l = t.split("\n").find((l) => l.includes("auth"));
  return l && /ACTIVE/.test(l) && /run-1, 2h 0m in/.test(l) && /deadline 11-05 06:00/.test(l);
})(), (t.split("\n").find((l) => l.includes("auth")) || ""));
check("fixture: docs line PAUSED waiting root", (() => {
  const l = t.split("\n").find((l) => l.includes("docs"));
  return l && /PAUSED waiting root/.test(l);
})());
check("fixture: node order root,auth,docs (bookkeep order)", (() => {
  const i = (s) => t.indexOf(s);
  return i("(root)") < i("auth") && i("auth") < i("docs");
})());
check("fixture: every row inside the box", t.split("\n").every((l, i) => (i === 0 || i === t.split("\n").length - 1) ? !l.startsWith("│") : l.startsWith("│")));

// A node with >1 windows and no live one shows the window count.
M.allocWindow(projectDir, "docs"); // creates run-1
fs.mkdirSync(path.join(M.nodeDir(projectDir, "docs"), "run-2"));
t = M.renderTree(projectDir, { now: NOW });
check("windows: docs line shows '2 windows'", (() => {
  const l = t.split("\n").find((l) => l.includes("docs"));
  return l && /2 windows/.test(l);
})(), (t.split("\n").find((l) => l.includes("docs")) || ""));

// The CLI entry prints the same box (ralph.sh attach mode + the monitor use
// `node node.mjs tree <dir>`).
import { execFileSync } from "node:child_process";
const cli = execFileSync(process.execPath, [new URL("./lib/node.mjs", import.meta.url).pathname, "tree", projectDir], { encoding: "utf8" });
check("cli: `node node.mjs tree` prints the box (age is live-clock, not frozen)", cli.includes("sub-runs") && cli.includes("run-1,") && cli.includes("PAUSED waiting root"), cli.slice(0, 120));

console.log(R.map(([s, n, e]) => `${s}  ${n}${e ? "  — " + e : ""}`).join("\n"));
console.log(`\n${R.length - fails}/${R.length} passed${fails ? " — FAILURES" : " — ALL PASS"}`);
try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(fails ? 1 : 0);
