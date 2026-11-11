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
// v0.35.7 (spec 7.8): the banner renders deadlines in LOCAL time (shortIso in
// node.mjs) — derive the expected string from the host TZ, don't hardcode the
// UTC rendering (the old "11-05 06:00" only matched on a UTC host).
const loc = (iso) => {
  const d = new Date(iso);
  const p = (x) => String(x).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const DL_SHORT = loc(DL);

// Empty project: just the root, state unknown (no node.json yet is not an
// error — the banner must never throw).
let t = M.renderTree(projectDir, { now: NOW });
check("empty: renders root line", /\(root\)/.test(t) && /UNKNOWN/i.test(t), t);
{
  const lines = t.split("\n");
  check("empty: box shape", lines[0].startsWith("╭") && lines.at(-1).startsWith("╰") && lines.every((l) => l.length === lines[0].length), JSON.stringify(lines.map((l) => l.length)));
}

// Fixture: root active, auth has a LIVE run-1 (guardPid = this test process,
// which is alive), docs is paused waiting on root. (v2: sub-runs are
// projects — the registry entries live in the root's dot-dir node.json, the
// per-node state in each sub-project's own node.json.)
M.ensureRootNode(projectDir, { deadline: DL });
M.registerChild(projectDir, "auth", "auth");
M.registerChild(projectDir, "docs", "docs");
fs.mkdirSync(path.join(projectDir, "auth", ".pi-supervisor"), { recursive: true });
fs.mkdirSync(path.join(projectDir, "docs", ".pi-supervisor"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "auth", ".pi-supervisor", "node.json"), JSON.stringify({ v: 2, name: "auth", path: "auth", parent: "(root)", deadline: DL, state: "active", children: [], createdAt: "x" }));
fs.writeFileSync(path.join(projectDir, "docs", ".pi-supervisor", "node.json"), JSON.stringify({ v: 2, name: "docs", path: "docs", parent: "(root)", deadline: DL, state: "paused(waiting:root)", children: [], createdAt: "x" }));
const wd = path.join(projectDir, "auth", ".pi-supervisor", "runs", "run-1");
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
  return l && /ACTIVE/.test(l) && new RegExp(`deadline ${DL_SHORT}`).test(l);
})());
check("fixture: auth line is live (run-1 + 2h age)", (() => {
  const l = t.split("\n").find((l) => l.includes("auth"));
  return l && /ACTIVE/.test(l) && /run-1, 2h 0m in/.test(l) && new RegExp(`deadline ${DL_SHORT}`).test(l);
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
fs.mkdirSync(path.join(projectDir, "docs", ".pi-supervisor", "runs", "run-1"), { recursive: true });
fs.mkdirSync(path.join(projectDir, "docs", ".pi-supervisor", "runs", "run-2"), { recursive: true });
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
