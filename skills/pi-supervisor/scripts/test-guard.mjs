// test-guard.mjs — static regression tests for guard.mjs
//
// Runs the real guard.mjs against a FAKE RpcClient: PI_PACKAGE_DIR points
// at a scratch package whose dist/index.js exports a RpcClient that replays
// scripted child events (no model, no network). Deterministic and fast.
//
// Usage: node test-guard.mjs
//
// Event script format (PI_TEST_JSON env → path to JSON file):
//   { phases: [ [events...], [events...], ... ] }
//   prompt() consumes phase 0 (the task response); each later prompt()/steer()
//   (fork re-prompts, corrective steers) consumes the next phase. A missing
//   phase = "silent" (nothing more happens).
//   Event items:
//     { "msg": [ {thinking}, {text}, {toolCall:"bash",args:{...}} ] }
//         → assistant message entry + text deltas + tool_execution_start
//     { "toolEnd": { isError?, durationMs?, result? } }
//         → tool_execution_end for the open call
//     { "writeFile": "report.md" }   → creates that file (cwd = test tmp dir)
//     { "settled": { "aborted": false } }
//     { "abortSettled": true }       → agent_settled {aborted:true} (external)
//     { "pauseMs": 1500 }            → silence (for stall tests)

// Sanitize: must run from INSIDE a supervised window too — inherited PI_SUP_*
// would flip the guard into protected-child mode (PI_SUP_CHILD_USER ⇒ exit 49
// verification abort) and point window logic at the outer run dir.
for (const k of ["PI_SUP_RUN_DIR", "PI_SUP_CHILD", "PI_SUP_PROJECT", "PI_SUP_NODE", "PI_SUP_CHILD_USER"]) delete process.env[k];

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const supervisorPath = join(here, "guard.mjs");
const TASK = "task with enough length to pass the short-task warning threshold for tests";

// ---------------------------------------------------------------------------
// Fake pi package (PI_PACKAGE_DIR override)
// ---------------------------------------------------------------------------
const FAKE_INDEX = `
import { readFileSync, writeFileSync as wfs, appendFileSync as aws } from "node:fs";
const spec = process.env.PI_TEST_JSON ? JSON.parse(readFileSync(process.env.PI_TEST_JSON, "utf8")) : { phases: [] };
class RpcClient {
  constructor(opts) {
    this.opts = opts;
    this.handlers = [];
    this.entries = [];
    this.lastText = "";
    this.phase = 0;
    this.forkCalls = [];
    this.abortCalls = 0;
    this.steers = [];
    this.prompts = [];
    this.tcSeq = 0;
    this.openToolIds = [];
    try { wfs("pi-test-args.json", JSON.stringify(opts.args)); } catch {}
  }
  onEvent(cb) { this.handlers.push(cb); }
  emit(ev) { for (const h of this.handlers) h(ev); }
  async start() {
    // No replay here: nothing happens until the supervisor prompts the task.
    // preEntries (spec) = session history already present at start (resumes).
    this.entries.push({ type: "session", id: "session-0", sessionId: "fake-session" });
    for (const e of spec.preEntries ?? []) this.entries.push(e);
    this.emit({ type: "session_start", sessionId: "fake-session" });
  }
  async prompt(text) {
    this.prompts.push(text);
    try { aws("pi-test-prompts.txt", "===PROMPT===\\n" + text + "\\n", "utf8"); } catch {}
    // spec.rejectPromptsAfter: reject prompt #N+1 and later with the real pi
    // "already processing" error (tests guard.mjs promptChild → steer fallback).
    if (spec.rejectPromptsAfter !== undefined && this.prompts.length > spec.rejectPromptsAfter) {
      throw new Error(spec.rejectPromptMessage || "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
    const id = "user-" + this.entries.length;
    const last = this.entries[this.entries.length - 1];
    this.entries.push({ type: "message", id, parentId: last ? last.id : null, message: { role: "user", content: [{ type: "text", text }] } });
    this.replay();
    return "accepted";
  }
  async steer(msg) {
    this.steers.push(msg);
    try { aws("pi-test-prompts.txt", "===STEER===\\n" + msg + "\\n", "utf8"); } catch {}
    const id = "user-" + this.entries.length;
    const last = this.entries[this.entries.length - 1];
    this.entries.push({ type: "message", id, parentId: last ? last.id : null, message: { role: "user", content: [{ type: "text", text: msg }] } });
    this.replay();
    return "accepted";
  }
  replay() {
    if (this.phase >= spec.phases.length) return;
    const events = spec.phases[this.phase++] ?? [];
    let i = 0;
    const next = () => {
      if (i >= events.length) return;
      const ev = events[i++];
      this.play(ev);
      // pauseMs keeps the event stream silent (stall tests); everything else
      // plays back as fast as the event loop allows.
      if (ev.pauseMs) setTimeout(next, ev.pauseMs);
      else setImmediate(next);
    };
    next();
  }
  play(ev) {
    if (ev.msg) {
      const blocks = [];
      for (const b of ev.msg) {
        if (b.thinking !== undefined) blocks.push({ type: "thinking", thinking: b.thinking });
        if (b.text !== undefined) {
          blocks.push({ type: "text", text: b.text });
          this.lastText = b.text;
          this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: b.text } });
        }
        if (b.toolCall !== undefined) {
          // Deterministic ids (tc-1, tc-2, ...) so a script can reference the
          // id in a later toolEnd item; toolCallId is carried on both events,
          // like pi's real tool_execution_start/end.
          const tcId = "tc-" + ++this.tcSeq;
          blocks.push({ type: "toolCall", id: tcId, name: b.toolCall, arguments: b.args });
          this.openToolIds.push(tcId);
          this.emit({ type: "tool_execution_start", toolCallId: tcId, toolName: b.toolCall, args: b.args ?? {} });
        }
      }
      const last = this.entries[this.entries.length - 1];
      this.entries.push({ type: "message", id: "asst-" + this.entries.length, parentId: last ? last.id : null, message: { role: "assistant", content: blocks } });
    } else if (ev.toolEnd) {
      // toolEnd.id (optional): end a specific open call (parallel-tool
      // scripts); default: LIFO (calls end in reverse start order).
      const tcId = ev.toolEnd.id ?? this.openToolIds.pop();
      this.emit({ type: "tool_execution_end", toolCallId: tcId, isError: !!ev.toolEnd.isError, durationMs: ev.toolEnd.durationMs ?? 5, result: ev.toolEnd.result ?? "ok" });
    } else if (ev.writeFile) {
      wfs(ev.writeFile, "artifact\\n", "utf8");
    } else if (ev.settled) {
      this.emit({ type: "agent_settled", aborted: !!ev.settled.aborted });
    } else if (ev.abortSettled) {
      this.emit({ type: "agent_settled", aborted: true });
    } else if (ev.errorStop !== undefined) {
      // v0.30.0 P5b: an assistant message that settled on stopReason "error"
      // (a provider failure that survived pi's own retries). The message text
      // is the errorMessage (string) or { errorMessage: ... }.
      const last = this.entries[this.entries.length - 1];
      const errText = typeof ev.errorStop === "string" ? ev.errorStop : (ev.errorStop.errorMessage ?? "request failed");
      this.entries.push({ type: "message", id: "asst-" + this.entries.length, parentId: last ? last.id : null, message: { role: "assistant", content: [], stopReason: "error", errorMessage: errText } });
    }
    // pauseMs is handled by replay() scheduling, not by play()
  }
  async abort() { this.abortCalls++; }
  async clearQueue() {}
  async fork(entryId) {
    this.forkCalls.push(entryId);
    // Faithful to pi's RPC fork(): only user-message entries are accepted
    // (the branch is made BEFORE them); anything else throws.
    const e = this.entries.find((x) => x.id === entryId);
    if (!e || e.type !== "message" || e.message?.role !== "user") {
      throw new Error("Invalid entry ID for forking");
    }
    return { sessionId: "fake-forked", sessionFile: "/tmp/fake-forked.jsonl", checkpointId: entryId, cancelled: false };
  }
  async getState() { return { sessionId: "fake-session", sessionFile: (spec.sessionFile ?? "/tmp/fake-session.jsonl"), entries: this.entries }; }
  async getEntries() {
    const last = this.entries[this.entries.length - 1];
    // spec.entriesTextAt: per-index override of what entries report for the
    // LAST assistant message's text blocks (chars to keep; 0 = none). The
    // v0.35.6 test uses it to model the divergence where entries report no
    // text while the RPC view has it (run48's production direction was the
    // mirror image — entries full, RPC empty — covered by the
    // "stall -> L2 fork -> completed" test). Only text blocks are affected;
    // thinking blocks keep replaying normally.
    const ov = spec.entriesTextAt;
    let entries = this.entries;
    if (ov) {
      let lastAsstIdx = -1;
      for (let i = this.entries.length - 1; i >= 0; i--) {
        if (this.entries[i]?.type === "message" && this.entries[i].message?.role === "assistant") { lastAsstIdx = i; break; }
      }
      if (lastAsstIdx >= 0) {
        entries = this.entries.map((e, i) => {
          if (i !== lastAsstIdx) return e;
          const chars = ov[i];
          return {
            ...e,
            message: {
              ...e.message,
              content: e.message.content.map((b) => (b.type === "text" ? { ...b, text: b.text.slice(0, chars) } : b)),
            },
          };
        });
      }
    }
    return { entries, leafId: last ? last.id : null };
  }
  // v0.35.6: mirror the real RpcClient (pi 1.5.1) — the LAST assistant
  // message's concatenated text blocks, trimmed, or undefined. A plain
  // string, not a {text} object — the old object shape was the exact API
  // mismatch that masked the run48 bug in tests. spec.rpcText overrides the
  // view for divergence tests.
  async getLastAssistantText() {
    if (spec.rpcText !== undefined) return spec.rpcText.trim() || undefined;
    const last = [...this.entries].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
    if (!last) return undefined;
    let text = "";
    for (const b of last.message?.content ?? []) if (b.type === "text") text += b.text;
    return text.trim() || undefined;
  }
  async getMessages() {
    // v0.30.0 P5b: mirrors pi's RPC get_messages (session messages; assistant
    // messages may carry stopReason/errorMessage — see the errorStop item).
    return { sessionId: "fake-session", messages: this.entries.filter((e) => e.type === "message").map((e) => e.message) };
  }
  async stop() {}
}
export { RpcClient };
`;

const fakePkg = mkdtempSync(join(tmpdir(), "pi-fake-pkg-"));
mkdirSync(join(fakePkg, "dist"), { recursive: true });
writeFileSync(join(fakePkg, "dist", "cli.js"), "// dummy cli entry\n");
writeFileSync(join(fakePkg, "dist", "index.js"), FAKE_INDEX);

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passCount = 0;
let failCount = 0;

function run({ name, args = [], phases, expect = [], expectExit = 0, expectNot = [], setup = null, assertFiles = [], extra = null, env: extraEnv = null }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sup-test-"));
  const specFile = join(dir, "script.json");
  writeFileSync(specFile, JSON.stringify({ phases, ...(extra ?? {}) }));
  if (setup) setup(dir);
  // spawnSync (not execFileSync): [supervisor]/[info] lines go to STDERR and
  // must be included in the assertions.
  const r = spawnSync("node", [supervisorPath, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PI_PACKAGE_DIR: fakePkg,
      PI_TEST_JSON: specFile,
      PI_PROVIDER: "fake",
      PI_MODEL: "fake/model",
      NO_COLOR: "1",
      // v0.35.16: per-test env override (object, or (dir) => object so the
      // test can reference its scratch dir, e.g. PI_SUP_PROJECT=dir).
      ...(typeof extraEnv === "function" ? extraEnv(dir) : extraEnv ?? {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
  const code = r.status ?? 1;
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).toString();
  const fileProblems = [];
  for (const f of assertFiles) {
    let content;
    try { content = readFileSync(join(dir, f.path), "utf8"); }
    catch { fileProblems.push(`missing file: ${f.path}`); continue; }
    for (const s of f.expect ?? []) if (!content.includes(s)) fileProblems.push(`${f.path} missing ${JSON.stringify(s)}`);
  }
  const ok =
    code === expectExit &&
    expect.every((s) => out.includes(s)) &&
    expectNot.every((s) => !out.includes(s)) &&
    fileProblems.length === 0;
  if (ok) {
    passCount++;
    console.log(`PASS: ${name}`);
  } else {
    failCount++;
    console.log(`FAIL: ${name}`);
    console.log(`  exit=${code} (expected ${expectExit})`);
    for (const s of expect) if (!out.includes(s)) console.log(`  missing: ${JSON.stringify(s)}`);
    for (const s of expectNot) if (out.includes(s)) console.log(`  unexpected: ${JSON.stringify(s)}`);
    for (const p of fileProblems) console.log(`  ${p}`);
    console.log("--- output (last 40 lines) ---");
    console.log(out.split("\n").slice(-40).join("\n"));
  }
  return { out, dir, code };
}

// tool start+end pair helper
const tool = (name, args, isError = false) => [
  { msg: [{ toolCall: name, args }] },
  { toolEnd: { isError, durationMs: 5 } },
];
const think = (t) => ({ msg: [{ thinking: t }] });
const say = (t) => ({ msg: [{ text: t }] });
const done = (t = "Done.") => [say(t), { settled: {} }];

// 0. v0.30.0 P2: --session passthrough — the chain's resume launch passes the
// guard --session <sessionFile>; the guard must hand pi --session (the resume
// flag), not --session-id (that would start a FRESH session with the same ID).
run({
  name: "v0.30.0: --session passthrough reaches pi as --session (resume)",
  args: [TASK, "--session", "/tmp/chain-resume-session.jsonl"],
  phases: [done("Done. Report written to report.md.")],
  expect: ["\"status\":\"completed\""],
  assertFiles: [
    { path: "pi-test-args.json", expect: ["--session", "/tmp/chain-resume-session.jsonl"] },
  ],
});

// 1. External abort (host repetition guard) → L2 fork → completed
run({
  name: "external abort → L2 fork → completed",
  args: ["task with enough length to pass the short-task warning threshold for tests"],
  phases: [
    [say("working on it"), ...tool("bash", { cmd: "ls" }), { abortSettled: true }],
    done("Done. Report written to report.md."),
  ],
  expect: ["L2 fork #1", "\"status\":\"completed\"", "\"exitReason\":\"completed\""],
  expectNot: ["degenerate settle"],
});

// 2. Stall (no events) → L2 fork → completed
run({
  name: "stall → L2 fork → completed",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--idle-timeout", "1", "--tool-timeout", "1"],
  phases: [
    [say("ok"), { pauseMs: 2500 }, { settled: {} }],
    done("Finished after fork."),
  ],
  expect: ["L2 fork #1", "stalled", "\"status\":\"completed\""],
});

// 2b. Turn-stall (v0.22.0, L0): the turn keeps "living" past --turn-stall
// (streaming-or-paused, never settling — the run3 degenerate-generation shape)
// → abort + L2 fork → recovery completes.
run({
  name: "turn-stall: overlong live turn → L0 abort + L2 fork → completed",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--turn-stall", "1"],
  phases: [
    [say("degenerate"), { pauseMs: 2500 }, { settled: {} }],
    done("Finished after turn-stall fork."),
  ],
  expect: ["L0 turn-stall", "turn alive for", "L2 fork #1", "\"status\":\"completed\""],
});

// 2c. Turn-stall with no fork budget: L0 warns once and FALLS THROUGH to the
// idle sensor (a `continue` here would skip idle every tick and leave the run
// bounded only by the deadline) → stuck-idle, exit 3.
run({
  name: "turn-stall, no fork budget → warn once, idle path bounds → stuck",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--turn-stall", "1", "--max-forks", "0", "--idle-timeout", "1"],
  phases: [
    [say("degenerate"), { pauseMs: 4000 }, { settled: {} }],
  ],
  expect: ["L0 turn-stall", "fork budget exhausted", "\"status\":\"stuck\""],
  expectExit: 3,
});

// 3. Error loop → L1 steer → recovery → completed
run({
  name: "error loop → L1 steer → recovery",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--max-errors", "3"],
  phases: [
    [...tool("bash", { cmd: "a" }, true), ...tool("bash", { cmd: "b" }, true), ...tool("bash", { cmd: "c" }, true)],
    [...tool("bash", { cmd: "d" }), ...done("Recovered; report saved.")],
  ],
  expect: ["L1 error-loop steer", "3 consecutive tool calls failed", "\"status\":\"completed\""],
  expectNot: ["L2 fork"],
});

// 4. Tool loop → L1 steer → model reports → completed (no fork)
run({
  name: "tool loop → L1 steer → completed",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--loop-threshold", "3"],
  phases: [
    [...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" })],
    done("Done, report saved to notes.txt"),
  ],
  expect: ["L1 steer", "loop on bash", "\"status\":\"completed\""],
  expectNot: ["L2 fork"],
});

// 5. Degenerate settle (empty stop: no text, no tool calls) → ladder → stuck (no budget)
run({
  name: "degenerate empty stop, no budget → stuck",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--max-steers", "1", "--max-forks", "0"],
  phases: [
    [think("hmm"), { settled: {} }],
    [think("still thinking"), { settled: {} }],
  ],
  expect: ["degenerate settle", "no text and no tool activity", "\"exitReason\":\"degenerate-settle\"", "\"status\":\"stuck\""],
  expectExit: 3,
});

// 6. Normal completion → no intervention
run({
  name: "normal completion → no intervention",
  args: ["task with enough length to pass the short-task warning threshold for tests"],
  phases: [
    [think("planning"), ...tool("bash", { cmd: "ls" }), ...done("All done. The report is in report.md.")],
  ],
  expect: ["\"status\":\"completed\"", "\"exitReason\":\"completed\""],
  expectNot: ["L1 steer", "L2 fork", "degenerate"],
});

// 6b. v0.25.13: --thinking is forwarded to the child pi's command line
run({
  name: "--thinking off → forwarded to the child pi",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--thinking", "off"],
  phases: [
    [think("planning"), ...tool("bash", { cmd: "ls" }), ...done("All done. Report written.")],
  ],
  expect: ["starting supervised child", "--thinking off", "\"status\":\"completed\""],
  expectNot: ["L1 steer", "L2 fork"],
});

// 7. Stray thinking-only tail AFTER a real answer → completed (regression:
//    2026-10-15 live test — local models end turns with stray thinking tails;
//    that must NOT trigger the degenerate ladder)
run({
  name: "stray thinking tail after real answer → completed",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--max-steers", "2", "--max-forks", "2"],
  phases: [
    [
      think("thinking about the task"),
      ...tool("bash", { cmd: "ls" }),
      say("The answer is 42. I verified it with the tool and everything looks fine."),
      think("ok now stop"),
      { settled: {} },
    ],
  ],
  expect: ["\"status\":\"completed\"", "\"exitReason\":\"completed\""],
  expectNot: ["degenerate settle", "L1 steer", "L2 fork"],
});

// 8. Unknown CLI flag → exit 2 with "unknown flag" (must NOT become task text)
run({
  name: "unknown CLI flag rejected",
  args: ["--bogus-flag", "x", "task with enough length to pass the short-task warning threshold for tests"],
  phases: [],
  expect: ["unknown flag", "--bogus-flag"],
  expectExit: 2,
});

// 9. Missing --expect-file at settle → steer → file created → completed
run({
  name: "missing expect-file → steer → completed after artifact",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--expect-file", "report.md"],
  phases: [
    [say("working on the report"), { settled: {} }],
    [{ writeFile: "report.md" }, ...done("Done, report.md written")],
  ],
  expect: ["missing expected file", "report.md", "\"status\":\"completed\""],
});

// 10. Autonomous text-loop (long text without tool calls) → L1 steer → back on task
//     (the "thinking loop" — invisible to every other sensor)
run({
  name: "autonomous text-loop → L1 steer → completed",
  args: [
    "task with enough length to pass the short-task warning threshold for tests",
    "--max-text", "200",
    "--max-steers", "2", "--max-forks", "2",
  ],
  phases: [
    [say("A".repeat(300))], // no settle: the sensor fires mid-stream
    [...tool("bash", { cmd: "ls" }), ...done("Back on task. Finished.")],
  ],
  expect: ["L1 text-loop steer", "thinking loop", "\"status\":\"completed\""],
  expectNot: ["L2 fork"],
});

// 11. Stagnation sensor: N consecutive SUCCESSFUL calls with no usable
//     content (killed client / HTTP 400 / permission denied) → L1 steer
//     (the failure shape --max-errors never sees: those calls do not fail)
run({
  name: "stagnation sensor → L1 steer → recovery",
  args: [TASK, "--stagnation", "3", "--max-errors", "0"],
  phases: [
    [
      { msg: [{ toolCall: "bash", args: { cmd: "probe1" } }] },
      { toolEnd: { durationMs: 5, result: "killed at 270s (no output)" } },
      { msg: [{ toolCall: "bash", args: { cmd: "probe2" } }] },
      { toolEnd: { durationMs: 5, result: "400 Failed to load image or audio file (HTTP 400)" } },
      { msg: [{ toolCall: "bash", args: { cmd: "probe3" } }] },
      { toolEnd: { durationMs: 5, result: "Permission denied" } },
    ],
    [...tool("bash", { cmd: "next" }), ...done("Switched approach; report saved.")],
  ],
  expect: ["L1 stagnation steer", "3 consecutive tool calls returned no usable content", "\"status\":\"completed\""],
  expectNot: ["L2 fork"],
});

// 12. Hard timeout WITH finalization (v0.23.0): the turn is still live at the
//     wall clock (it never settled) → the guard ABORTS it (a steer would sit
//     in the queue forever) and delivers the finalization as a FRESH prompt.
//     Fake-client note: abort() emits nothing — the phase supplies the
//     abortSettled the real pi RPC would deliver; the budget-warning steer
//     (8.1s) opens phase 1, the deadline (9s) lands mid-pause with no event
//     queued, and the abort settle (9.6s) triggers the finalize prompt.
run({
  name: "hard timeout → finalization window → completed-finalized",
  args: [TASK, "--timeout", "0.15", "--finalize", "0.5"],
  phases: [
    [{ pauseMs: 7000 }], // task run (silence; idle-timeout is 300s, no stall)
    [{ pauseMs: 1500 }, { abortSettled: true }], // budget-warning steer (8.1s) opens this
    [
      say("FINAL REPORT: partial — items 1-2 done, item 3 unfinished (out of time)."),
      { writeFile: "report.md" },
      { settled: {} },
    ],
  ],
  expect: [
    "BUDGET WARNING",
    "HARD TIMEOUT",
    "deadline reached mid-turn",
    "finalization window",
    "\"status\":\"completed\"",
    "\"exitReason\":\"completed-finalized\"",
  ],
  expectExit: 0,
});

// 13. Hard timeout with --finalize 0 (legacy behavior) → immediate hard-timeout
run({
  name: "hard timeout, --finalize 0 → immediate hard-timeout",
  args: [TASK, "--timeout", "0.1", "--finalize", "0"],
  phases: [
    [{ pauseMs: 12000 }],
  ],
  expect: ["\"exitReason\":\"hard-timeout\"", "\"status\":\"stuck\""],
  expectNot: ["finalization window", "BUDGET WARNING"],
  expectExit: 3,
});

// 13b. v0.23.0: hard timeout with a LIVE (degenerate) turn — the finalization
//      prompt cannot steer a turn that will not settle, so the guard ABORTS
//      the turn and delivers the finalization as a FRESH prompt (the run4
//      shape: one turn outlived the whole deadline; with parallel=1 the
//      parent was starved for the entire run).
run({
  name: "finalize over live degenerate turn → abort + fresh finalize prompt → completed-finalized",
  args: [TASK, "--timeout", "0.15", "--finalize", "0.5"],
  phases: [
    [{ pauseMs: 9500 }], // degenerate turn: alive well past the 9s deadline
    [{ pauseMs: 1500 }, { abortSettled: true }], // budget-warning steer (8.1s) opens this; deadline abort (9s) settles it at 9.6s
    [say("FINAL REPORT: partial — items 1-2 done, item 3 unfinished (out of time)."), { writeFile: "report.md" }, { settled: {} }],
  ],
  expect: [
    "deadline reached mid-turn",
    "aborting for a clean finalize turn",
    "finalization window",
    "\"exitReason\":\"completed-finalized\"",
    "\"status\":\"completed\"",
  ],
  expectExit: 0,
});

// 13c. v0.23.0: the re-prompted FINALIZE turn degenerates too — L0 stays
//      active inside the window: abort + re-prompt (bounded at 3), then the
//      window end bounds the run → hard-timeout, exit 3.
//      Fake-client choreography: --max-forks 0 keeps the pre-deadline L0
//      (turn-stall 1s) from forking before the 3s deadline; phase 1 absorbs
//      the budget-warning steer as a no-op; each turn's phase supplies its
//      own timed abortSettled (the fake's abort() emits nothing — the phase
//      emulates pi's post-abort settle), 1.5s after the prompt so the
//      in-window L0 (1s) fires first and sets the pending re-prompt.
run({
  name: "finalize re-prompt ladder: degenerate finalize turns → 3 re-prompts → window end → hard-timeout",
  args: [TASK, "--timeout", "0.05", "--finalize", "0.25", "--turn-stall", "1", "--max-forks", "0"],
  phases: [
    [{ pauseMs: 9500 }, { abortSettled: true }], // 0: degenerate task turn; the 9.5s settle emulates the post-abort settle that delivers the finalize prompt
    [], // 1: budget-warning steer (2.7s) — no-op
    [say("finalize 1"), { pauseMs: 1500 }, { abortSettled: true }], // 2: finalize prompt (9.5s) → degenerates → re-prompt 1
    [say("finalize 2"), { pauseMs: 1500 }, { abortSettled: true }], // 3: re-prompt 1 → degenerates → re-prompt 2
    [say("finalize 3"), { pauseMs: 1500 }, { abortSettled: true }], // 4: re-prompt 2 → degenerates → re-prompt 3
    [say("finalize 4"), { pauseMs: 6000 }], // 5: re-prompt 3 → re-prompts exhausted (warn); the window end (18s) bounds
  ],
  expect: [
    "deadline reached mid-turn",
    "finalize re-prompt 1/3",
    "finalize re-prompt 2/3",
    "finalize re-prompt 3/3",
    "re-prompts exhausted",
    "\"exitReason\":\"hard-timeout\"",
  ],
  expectExit: 3,
});

// 14. Run manifest: pi-child-result.json in the cwd (always, every outcome)
{
  const r = run({
    name: "manifest written (pi-child-result.json)",
    args: [TASK],
    phases: [[...tool("bash", { cmd: "ls" }), ...done("All done, report saved.")]],
    expect: ["\"status\":\"completed\""],
  });
  const mf = join(r.dir, "pi-child-result.json");
  let m = null;
  try { m = JSON.parse(readFileSync(mf, "utf8")); } catch { /* missing/invalid */ }
  const okm = !!m && m.v === 1 && m.result?.status === "completed" &&
    typeof m.result?.manifest === "string" && m.result.manifest.endsWith("pi-child-result.json") &&
    typeof m.startedAt === "string" && typeof m.finishedAt === "string";
  if (okm) { passCount++; console.log("PASS: manifest fields"); }
  else {
    failCount++;
    console.log(`FAIL: manifest fields (exists=${existsSync(mf)} m=${JSON.stringify(m)?.slice(0, 200)})`);
  }
}

// 15. --timeout 0 = unlimited (no wall clock): the run must NOT be cut by a
//     wall clock — with the pre-v0.10.1 semantics (--timeout 0 = "die now",
//     since elapsed > 0 on the first tick) this run would hard-timeout;
//     now it completes normally. No deadline note, no budget warning either.
run({
  name: "--timeout 0 = unlimited (completes, no wall clock)",
  args: [TASK, "--timeout", "0"],
  phases: [
    // phase 0 = the task prompt's response: 2.5s of silence (LONGER than the
    // pre-v0.10.1 die-now tick — elapsed > 0 fired on the first loop tick when
    // --timeout 0) — then normal work + settle. Must all fit in one phase: the
    // supervisor prompts only once, and steer/fork prompts consume later ones.
    [{ pauseMs: 2500 }, ...tool("bash", { cmd: "ls" }), ...done("Done, report saved.")],
  ],
  expect: ["\"status\":\"completed\"", "[warn] --timeout 0: no wall clock"],
  expectNot: ["HARD TIMEOUT", "BUDGET WARNING", "HARD DEADLINE", "\"exitReason\":\"hard-timeout\""],
  expectExit: 0,
});

// ---------------------------------------------------------------------------
// v0.11.0: --task-file + live status file
// ---------------------------------------------------------------------------
run({
  name: "--task-file: task read from file (sentinel echo + completed)",
  args: ["--task-file", "taskfile.md"],
  phases: [
    [...tool("bash", { cmd: "ls" }), ...done("Done. All items processed; report written to report.md.")],
  ],
  setup: (dir) => writeFileSync(join(dir, "taskfile.md"), "SENTINEL_TASKFILE_ALPHA " + "x".repeat(120) + "\n"),
  expect: ["SENTINEL_TASKFILE_ALPHA", "\"status\":\"completed\""],
  expectExit: 0,
});

run({
  name: "--task-file: conflicts with positional task",
  args: ["task with enough length to pass the short-task warning threshold for tests", "--task-file", "x.md"],
  phases: [],
  expect: ["--task-file conflicts with a positional/--task task argument"],
  expectExit: 2,
});

run({
  name: "--task-file: unreadable path → usage error",
  args: ["--task-file", "does-not-exist.md"],
  phases: [],
  expect: ["cannot read --task-file"],
  expectExit: 2,
});

run({
  name: "task text that is an existing file path → --task-file hint",
  args: ["notes.md"],
  phases: [
    [...tool("bash", { cmd: "cat notes.md" }), ...done("Read notes.md: it says hello.")],
  ],
  setup: (dir) => writeFileSync(join(dir, "notes.md"), "hello\n"),
  expect: ["suspiciously short", "did you mean --task-file notes.md"],
  expectExit: 0,
});

run({
  name: "status file: per-tool-call updates, final state, expectedFiles tracked",
  args: [
    "task with enough length to pass the short-task warning threshold for tests",
    "--expect-file", "report.md",
  ],
  phases: [
    [...tool("bash", { cmd: "ls" }), { writeFile: "report.md" }, ...done("Done. report written to report.md.")],
  ],
  expectExit: 0,
  assertFiles: [{
    path: "pi-child-status.json",
    expect: [
      '"status": "completed"',
      '"exitReason": "completed"',
      '"toolCalls": 1',
      '"lastTool": "bash"',
      '"report.md": true',
    ],
  }],
});

// ---------------------------------------------------------------------------
// v0.13.0: L1.5 auto-rewind (branch right after the task message) + --action rewind
// ---------------------------------------------------------------------------
run({
  name: "tool loop → steer → loop again → L1.5 rewind → completed",
  args: [TASK, "--loop-threshold", "3", "--max-steers", "1", "--max-rewinds", "1"],
  phases: [
    [...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" })],
    [...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" })],
    [...tool("bash", { cmd: "y" }), ...done("Recovered after rewind; report saved.")],
  ],
  expect: ["L1 steer", "L1.5 rewind #1/1", "\"rewinds\":1", "\"status\":\"completed\""],
  expectNot: ["L2 fork #"],
});

run({
  name: "--max-rewinds 0 → loop falls through to L2 fork",
  args: [TASK, "--loop-threshold", "3", "--max-steers", "0", "--max-rewinds", "0"],
  phases: [
    [...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" })],
    [...tool("bash", { cmd: "y" }), ...done("Done after fork.")],
  ],
  expect: ["L2 fork #1/2", "\"status\":\"completed\""],
  expectNot: ["L1.5 rewind"],
});

run({
  name: "consult mode: loop parks and advertises rewind",
  args: [TASK, "--consult", "--loop-threshold", "3"],
  phases: [
    [...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" }), ...tool("bash", { cmd: "x" })],
  ],
  expect: ["CONSULT (loop)"],
  expectExit: 4,
  assertFiles: [{
    path: "pi-child-consult.json",
    expect: ['"trigger": "loop"', '"rewindsUsed": 0', '"maxRewinds": 1', '"rewind"', '"taskEntryId"'],
  }],
});

run({
  name: "--consult-file --action rewind → branch after task + re-prompt",
  args: ["--consult-file", "c.json", "--action", "rewind", "--message", "RESENT_AFTER_REWIND"],
  phases: [
    [...done("Resumed after rewind.")],
  ],
  expect: ["rewind re-prompt", "\"rewinds\":1", "\"status\":\"completed\""],
  expectExit: 0,
  setup: (dir) => writeFileSync(join(dir, "c.json"), JSON.stringify({
    v: 1, at: new Date().toISOString(), trigger: "loop",
    allowedActions: ["rewind", "fork", "continue"],
    task: TASK, attempt: 1, steersUsed: 1, forksUsed: 0, rewindsUsed: 0, loopsSeen: 1,
    maxSteers: 3, maxForks: 2, maxRewinds: 1,
    startTs: Date.now(), hardTimeoutMs: 0,
    sessionId: "fake-session", sessionFile: "/tmp/fake-session.jsonl",
    taskEntryId: "user-pre-1",
  })),
  extra: {
    preEntries: [
      { type: "message", id: "user-pre-1", parentId: "session-0", message: { role: "user", content: [{ type: "text", text: TASK }] } },
      { type: "message", id: "asst-pre-2", parentId: "user-pre-1", message: { role: "assistant", content: [{ type: "text", text: "looping on the same call" }] } },
    ],
  },
});

// ---------------------------------------------------------------------------
// v0.6.0: --out-dir, [settle] progress line, context-overflow pivot
// ---------------------------------------------------------------------------
run({
  name: "--out-dir: artifacts land in the out dir; [settle] line carries last text",
  args: [TASK, "--out-dir", "sup"],
  phases: [
    [...tool("bash", { cmd: "ls" }), ...done("Done, report saved.")],
  ],
  expect: ["\"status\":\"completed\""],
  assertFiles: [
    { path: "sup/pi-child-result.json", expect: ['"status": "completed"'] },
    { path: "sup/pi-child-status.json", expect: ['"status": "completed"'] },
    { path: "sup/pi-child-progress.log", expect: ["[start]", "[settled]", "[settle]", 'last="Done, report saved."', "[result]"] },
  ],
});

run({
  name: "overflow stall: large resumed session, first prompt, zero tools → stuck-overflow + brief + relaunch (no fork)",
  args: [
    TASK,
    "--session", "big-session.jsonl",
    "--overflow-threshold-mb", "0.5",
    "--idle-timeout", "1",
  ],
  phases: [
    [{ pauseMs: 4000 }], // silence on the first prompt — the overflow signature
  ],
  setup: (dir) => writeFileSync(join(dir, "big-session.jsonl"), "x".repeat(1_500_000)),
  extra: { sessionFile: "big-session.jsonl" },
  expect: [
    "RESUME PREFLIGHT",
    "OVERFLOW STALL",
    "\"exitReason\":\"stuck-overflow\"",
    "\"status\":\"stuck\"",
    "pi-child-brief.md",
    "pi-child-relaunch.json",
  ],
  expectNot: ["L2 fork", "L1 steer", "L1.5 rewind"],
  expectExit: 3,
  assertFiles: [
    { path: "pi-child-brief.md", expect: ["Distilled brief", "CLEAN session", "Original task (verbatim)"] },
    { path: "pi-child-relaunch.json", expect: ["stuck-overflow", "--task-file", "--relayed-from"] },
    { path: "pi-child-result.json", expect: ['"exitReason": "stuck-overflow"', "briefFile", "relaunchFile"] },
  ],
});

run({
  name: "overflow stall: small resumed session → normal stall → fork (classifier must NOT fire)",
  args: [
    TASK,
    "--session", "small-session.jsonl",
    "--overflow-threshold-mb", "0.5",
    "--idle-timeout", "1",
  ],
  phases: [
    [{ pauseMs: 2500 }],
    done("Recovered after fork.")],
  setup: (dir) => writeFileSync(join(dir, "small-session.jsonl"), "x".repeat(10_000)),
  extra: { sessionFile: "small-session.jsonl" },
  expect: ["L2 fork #1", "\"status\":\"completed\""],
  expectNot: ["OVERFLOW STALL", "stuck-overflow"],
  expectExit: 0,
});

run({
  name: "overflow pivot with --pivot-relaunch: relay is spawned and its exit code is forwarded",
  args: [
    TASK,
    "--session", "big-session.jsonl",
    "--overflow-threshold-mb", "0.5",
    "--idle-timeout", "1",
    "--pivot-relaunch",
  ],
  phases: [
    // Shared spec: the FIRST run stalls at t≈1s (idle-timeout 1) DURING the
    // 1.5s pause → overflow pivot → relay. The RELAY (fresh process, fresh
    // fake client, same spec) consumes the same phase 0 from its start: the
    // pause ends, it says its report and settles → completed (exit 0).
    // With no --session the overflow classifier cannot fire in the relay.
    [{ pauseMs: 1500 }, say("Relay finished the job; all items complete."), { settled: {} }],
  ],
  setup: (dir) => writeFileSync(join(dir, "big-session.jsonl"), "x".repeat(1_500_000)),
  extra: { sessionFile: "big-session.jsonl" },
  expect: ["OVERFLOW STALL", "spawning the relay", "\"exitReason\":\"completed\""],
  expectNot: ["\"exitReason\":\"stuck-overflow\""],
  expectExit: 0,
  assertFiles: [
    // Final manifest belongs to the RELAY (it overwrote the pivot manifest)
    { path: "pi-child-result.json", expect: ['"status": "completed"', "relayedFrom"] },
  ],
});

// v0.14.0: out-dir ownership (the 2026-10-26 toposort review, F2: a second
// guard pointed at a live run's out-dir silently truncated its progress log
// and clobbered its status file)
{
  const liveOwnerStatus = {
    v: 2, at: new Date().toISOString(), status: "running",
    guardPid: process.pid, sessionId: "owner-run",
  };
  run({
    name: "out-dir owned by a live guard → refuse without --force (exit 2)",
    args: [TASK],
    phases: [],
    expectExit: 2,
    expect: ["is owned by a live guard", "different --out-dir", "--force"],
    expectNot: ["[start]"],
    setup: (dir) => writeFileSync(join(dir, "pi-child-status.json"), JSON.stringify(liveOwnerStatus)),
  });
  run({
    name: "--force → starts in a live-guard dir and APPENDS to its progress log",
    args: [TASK, "--force"],
    phases: [done("forced ok")],
    expect: ["--force: overwriting artifacts", "\"status\":\"completed\""],
    expectExit: 0,
    setup: (dir) => {
      writeFileSync(join(dir, "pi-child-status.json"), JSON.stringify(liveOwnerStatus));
      writeFileSync(join(dir, "pi-child-progress.log"), "sentinel-from-owner\n");
    },
    assertFiles: [
      { path: "pi-child-progress.log", expect: ["sentinel-from-owner", "[start]", "pid="] },
    ],
  });
  run({
    name: "stale owner (dead pid) → overwrites without --force",
    args: [TASK],
    phases: [done("stale ok")],
    expect: ["\"status\":\"completed\""],
    expectNot: ["is owned by a live guard"],
    expectExit: 0,
    setup: (dir) => writeFileSync(join(dir, "pi-child-status.json"), JSON.stringify({
      ...liveOwnerStatus, guardPid: 99999999, sessionId: "dead-owner",
    })),
  });
}

// ---------------------------------------------------------------------------
// v0.17.0: workspace invariants, empty-final settle, --preamble, parent steer
// ---------------------------------------------------------------------------
run({
  name: "v0.17 invariant fail → L1 steer → recovery → completed",
  args: [TASK, "--invariant", "test -f good.txt"],
  phases: [
    [...tool("bash", { cmd: "work" })],
    [{ writeFile: "good.txt" }, ...tool("bash", { cmd: "fix" }), ...done("Fixed; report saved.")],
  ],
  expect: ["L1 invariant steer", "workspace invariant(s) failing", "test -f good.txt", "\"status\":\"completed\""],
  expectNot: ["L2 fork"],
  assertFiles: [{ path: "pi-child-progress.log", expect: ["[invariant]"] }],
});

run({
  name: "v0.17 invariant fail, no budget → stuck-invariant (exit 3)",
  args: [TASK, "--invariant", "test -f never-created.txt", "--max-steers", "0", "--max-forks", "0"],
  phases: [[...tool("bash", { cmd: "work" })]],
  expect: ["\"exitReason\":\"stuck-invariant\"", "\"status\":\"stuck\""],
  expectExit: 3,
});

run({
  name: "v0.17 consult mode: invariant parks with trigger=invariant (exit 4)",
  args: [TASK, "--consult", "--invariant", "test -f never-created.txt"],
  phases: [[...tool("bash", { cmd: "work" })]],
  expect: ["CONSULT (invariant)"],
  expectExit: 4,
  assertFiles: [{ path: "pi-child-consult.json", expect: ['"trigger": "invariant"'] }],
});

run({
  name: "v0.17 passing invariant → no intervention",
  args: [TASK, "--invariant", "true"],
  phases: [[...tool("bash", { cmd: "work" }), ...done("Done, report saved.")]],
  expect: ["\"status\":\"completed\""],
  expectNot: ["L1 invariant steer", "WORKSPACE INVENTORY VIOLATION"],
});

run({
  name: "v0.17 empty final after activity, no budget → empty-final (exit 3)",
  args: [TASK, "--max-steers", "0", "--max-forks", "0"],
  phases: [[...tool("bash", { cmd: "work" }), { settled: {} }]],
  expect: ["EMPTY", "\"exitReason\":\"empty-final\"", "\"status\":\"stuck\""],
  expectExit: 3,
});
// v0.35.6 (run48): the old inspectSettle read RpcClient.getLastAssistantText()
// as an OBJECT (`.text` on the string pi 1.5.1 returns) → textChars was always
// 0 → a healthy final (text + toolCall blocks; entries view full, 2722 chars
// in run48) was misclassified empty-final: 3 steers, 2 forks, stuck halt.
// Regression: the attempt-scoped entries view must drive completion. The
// phase below settles on a toolCall-only LAST message, so the RPC view is
// empty while the attempt's entries carry the text — entries must win.
run({
  name: "v0.35.6 (run48) text→toolCall→settle: entries view drives completion, not empty-final",
  args: [TASK, "--max-steers", "0", "--max-forks", "0"],
  phases: [[say("Done, report saved."), ...tool("bash", { cmd: "work" }), { settled: {} }]],
  expect: ["\"status\":\"completed\"", "settle text-source divergence"],
  expectNot: ["empty-final", "EMPTY final message"],
  expectExit: 0,
});
// The opposite divergence: entries report no text for the attempt while the
// RPC view carries some — the RPC view must be accepted (never steer a
// healthy completion either way).
run({
  name: "v0.35.6 divergence: entries empty, RPC view full → RPC accepted, completed",
  // run() serializes { phases, ...extra } into the spec — the stub hook goes in `extra`, not spec.
  extra: { rpcText: "Status: task done, report saved to report.md." },
  args: [TASK, "--max-steers", "0", "--max-forks", "0"],
  phases: [[...tool("bash", { cmd: "work" }), { settled: {} }]],
  expect: ["\"status\":\"completed\"", "settle text-source divergence"],
  expectNot: ["empty-final"],
  expectExit: 0,
});

run({
  name: "v0.17 empty final → corrective prompt → proper status → completed",
  args: [TASK, "--max-steers", "1", "--max-forks", "0"],
  phases: [
    [...tool("bash", { cmd: "work" }), { settled: {} }],
    [say("Status: task done, report saved to report.md."), { settled: {} }],
  ],
  expect: ["empty final message", "\"status\":\"completed\""],
});

run({
  name: "v0.17 --preamble standard injects the bundled contract before the task",
  args: [TASK, "--preamble", "standard"],
  phases: [[...tool("bash", { cmd: "work" }), ...done("Done, report saved.")]],
  expect: ["\"status\":\"completed\""],
  expectExit: 0,
  assertFiles: [{ path: "pi-test-prompts.txt", expect: ["Standard task contract", TASK] }],
});

run({
  name: "v0.17 --preamble <custom> used verbatim",
  args: [TASK, "--preamble", "CUSTOM_PREAMBLE_SENTINEL"],
  phases: [[...tool("bash", { cmd: "work" }), ...done("Done, report saved.")]],
  expect: ["\"status\":\"completed\""],
  expectExit: 0,
  assertFiles: [{ path: "pi-test-prompts.txt", expect: ["CUSTOM_PREAMBLE_SENTINEL", TASK] }],
});

run({
  name: "v0.17 parent steer inbox: delivered to live child, logged, counted, archived",
  args: [TASK],
  phases: [
    [...tool("bash", { cmd: "work" })],
    [...done("Got the steer; done.")],
  ],
  setup: (dir) => {
    const inbox = join(dir, ".steer-inbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "steer-test.txt"), "PARENT_STEER_SENTINEL: also write a summary file\n");
  },
  expect: ["L1 parent-steer", "\"status\":\"completed\""],
  expectExit: 0,
  assertFiles: [
    { path: "pi-child-progress.log", expect: ["[steer-inbox]", "disposition="] },
    { path: "pi-child-result.json", expect: ['"parentSteers": 1'] },
    { path: ".steer-inbox/processed/steer-test.txt", expect: ["PARENT_STEER_SENTINEL"] },
    { path: "pi-test-prompts.txt", expect: ["PARENT_STEER_SENTINEL"] },
  ],
});

run({
  name: "prompt rejected 'already processing' → steer fallback delivers (run1 21:20Z regression)",
  args: [TASK],
  // spec.rejectPromptsAfter=0: the fake's prompt() rejects with pi's real
  // "already processing" error. promptChild (guard.mjs) must fall back to
  // client.steer() — the queueing path — instead of dropping the task. The
  // steer replays this single phase; without the fallback the run could not
  // complete (the task would never reach the child).
  phases: [
    [...tool("bash", { cmd: "work" }), ...done("Done. Report written to report.md.")],
  ],
  extra: { rejectPromptsAfter: 0 },
  expect: ["\"status\":\"completed\"", "\"exitReason\":\"completed\""],
  expectExit: 0,
  assertFiles: [
    // Task was attempted as a prompt (logged before the reject) and then
    // actually DELIVERED via steer — without the fallback, no ===STEER===
    // line would exist.
    { path: "pi-test-prompts.txt", expect: ["===PROMPT===", "===STEER===", TASK] },
  ],
});

// run32 2026-11-05 07:19Z: the settle of the turn the guard itself aborted
// (L0 → L2 fork) is ALWAYS consumed AFTER the fork's re-prompt (the event
// loop is suspended while doFork re-prompts). The old settle handler cleared
// turnActive anyway — the re-prompted turn went unsupervised (L0 blind) and
// the second turn-stall never fired. With the late-settle guard the second
// fork fires and the run completes. Pre-fix, this run hangs (no settle ever
// lands for the live turn) and fails on the harness timeout.
run({
  name: "late settle of aborted turn does not desync turn tracking (run32 07:19Z regression)",
  args: [TASK, "--turn-stall", "1"],
  phases: [
    [say("degenerate"), { pauseMs: 1500 }, { abortSettled: true }],
    [say("degenerate again"), { pauseMs: 1500 }, { abortSettled: true }],
    done("Recovery complete."),
  ],
  expect: ["L0 turn-stall", "L2 fork #1", "L2 fork #2", "\"status\":\"completed\""],
  assertFiles: [
    { path: "pi-child-progress.log", expect: ["late — the aborted turn"] },
  ],
});

// run32 2026-11-05: the manifest's recentToolCalls was args/result-mispaired
// for parallel tool calls (the open-calls stack was popped LIFO). pi's events
// carry toolCallId — pair by ID. Pre-fix, bash carried fetch's result.
{
  const r = run({
    name: "parallel tool calls: recentToolCalls paired by toolCallId (run32 regression)",
    args: [TASK],
    phases: [
      [
        { msg: [{ toolCall: "bash", args: { cmd: "ls" } }, { toolCall: "fetch_content", args: { url: "u" } }] },
        { toolEnd: { id: "tc-1", result: "RES-A", durationMs: 7 } },
        { toolEnd: { id: "tc-2", result: "RES-B", durationMs: 9 } },
        ...done("Done with both."),
      ],
    ],
    expect: ["\"status\":\"completed\""],
  });
  let okm = false;
  try {
    const m = JSON.parse(readFileSync(join(r.dir, "pi-child-result.json"), "utf8"));
    const rc = m?.result?.recentToolCalls ?? [];
    const bash = rc.find((c) => c.tool === "bash");
    const fetch = rc.find((c) => c.tool === "fetch_content");
    okm =
      bash?.callId === "tc-1" && bash?.args.includes('"cmd":"ls"') && bash?.result === "RES-A" &&
      fetch?.callId === "tc-2" && fetch?.args.includes('"url":"u"') && fetch?.result === "RES-B";
  } catch { okm = false; }
  if (okm) { passCount++; console.log("PASS: recentToolCalls pairing fields"); }
  else {
    failCount++;
    console.log("FAIL: recentToolCalls pairing fields");
  }
}

// sticky-abortedByMe regression: the self-fork's LATE settle is consumed
// (skipped) after the re-prompt. The "expecting my own settle" state must not
// survive that consumption — a LATER external abort (host repetition guard;
// the fake's abortSettled) must take the external-abort recovery path. Pre-fix
// abortedByMe stayed true, the external settle was mis-skipped as "late", and
// recovery happened only via L0 (wrong fork reason; no "aborted mid-run by the host").
run({
  name: "external abort after a self-fork takes the external-abort path (sticky abortedByMe)",
  args: [TASK, "--turn-stall", "1"],
  phases: [
    [say("t1"), { pauseMs: 1500 }, { abortSettled: true }], // turn 1: L0 aborts at ~1s; this settle is the LATE one
    [say("t2"), { pauseMs: 700 }, { abortSettled: true }], // turn 2: host abort at ~t2+0.7 (before L0 at ~t2+1.0)
    done("Recovered from the external abort."),
  ],
  expect: ["L0 turn-stall", "aborted mid-run by the host", "L2 fork #2", "\"status\":\"completed\""],
  assertFiles: [{ path: "pi-child-progress.log", expect: ["late — the aborted turn"] }],
});

// openCalls-clear regression: a tool call in flight when the guard forks belongs
// to the dead turn. Its START was already logged, but it must not leak into the
// new attempt's state: the fork clears openCalls and the stale end (whose ID
// matches nothing) is DROPPED instead of paired + recorded. Pre-fix the start
// stayed in openCalls → the stale end paired → phantom bash entry in the
// manifest's recentToolCalls.
{
  const r = run({
    name: "fork clears openCalls: the aborted turn's stale tool end is dropped (not recorded)",
    args: [TASK, "--turn-stall", "1"],
    phases: [
      [
        { msg: [{ toolCall: "bash", args: { cmd: "long-job" } }] }, // in flight when L0 forks at ~1s
        { pauseMs: 1500 },
        { toolEnd: { result: "STALE-RES", durationMs: 1500 } }, // stale end after the fork
      ],
      [say("t2"), { pauseMs: 800 }, { settled: {} }], // turn 2 settles normally before its L0
    ],
    expect: ["L0 turn-stall", "L2 fork #1", "\"status\":\"completed\""],
  });
  let okm = false;
  try {
    const m = JSON.parse(readFileSync(join(r.dir, "pi-child-result.json"), "utf8"));
    const rc = m?.result?.recentToolCalls ?? [];
    okm = rc.length === 0;
  } catch { okm = false; }
  if (okm) { passCount++; console.log("PASS: fork clears openCalls (no stale tool in manifest)"); }
  else {
    failCount++;
    console.log("FAIL: fork clears openCalls (no stale tool in manifest)");
  }
}

// ---------------------------------------------------------------------------
// v0.30.0 P5a: parent-judged context rot. The parent (ralph-monitor's
// per-cycle judgment) drops parent-distill.json in the out dir; the guard
// consumes it (rename-aside) and runs the pivot machinery: distilled brief +
// relaunch record + (with --pivot-relaunch) a fresh-session relay carrying
// the remaining wall clock.
// ---------------------------------------------------------------------------
run({
  name: "v0.30.0 P5a: parent-distill.json + --pivot-relaunch → relay (fresh session) completes",
  args: [TASK, "--pivot-relaunch"],
  phases: [
    // consumed by the RELAY (its fresh fake client replays phase 0 at start)
    done("Relay finished from the clean brief."),
  ],
  setup: (dir) => writeFileSync(join(dir, "parent-distill.json"), JSON.stringify({
    v: 1, at: new Date().toISOString(), reason: "child is repeating a refuted premise", source: "parent-judgment", cycle: 3,
  })),
  expect: ["PARENT DISTILL", "spawning the relay", '"exitReason":"completed"'],
  expectNot: ['"exitReason":"parent-distill"'],
  expectExit: 0,
  assertFiles: [
    { path: "pi-child-brief.md", expect: ["ROTTED", "refuted premise", "Original task (verbatim)"] },
    { path: "pi-child-relaunch.json", expect: ["parent-distill", "--task-file", "--relayed-from"] },
    { path: "pi-child-result.json", expect: ['"status": "completed"', "relayedFrom"] },
  ],
});

{
  const r = run({
    name: "v0.30.0 P5a: parent-distill.json without --pivot-relaunch → exit 3, request consumed once",
    args: [TASK],
    phases: [],
    setup: (dir) => writeFileSync(join(dir, "parent-distill.json"), JSON.stringify({ v: 1, reason: "context rotted" })),
    expect: ["PARENT DISTILL", '"status":"stuck"', '"exitReason":"parent-distill"'],
    expectExit: 3,
    assertFiles: [
      { path: "pi-child-brief.md", expect: ["ROTTED", "context rotted"] },
      { path: "pi-child-relaunch.json", expect: ["parent-distill"] },
      { path: "pi-child-result.json", expect: ['"exitReason": "parent-distill"'] },
    ],
  });
  // rename-aside: the request file must be GONE (consumed exactly once),
  // preserved under a .received-<ts> suffix.
  const gone = !existsSync(join(r.dir, "parent-distill.json"));
  let received = false;
  try {
    received = readdirSync(r.dir).some((f) => f.startsWith("parent-distill.json.received-"));
  } catch { received = false; }
  if (gone && received) { passCount++; console.log("PASS: parent-distill request consumed (rename-aside)"); }
  else { failCount++; console.log(`FAIL: parent-distill request consumed (gone=${gone}, received=${received})`); }
}

// ---------------------------------------------------------------------------
// v0.30.0 P5b: model-server failure at settle. pi retries retryable provider
// errors itself (backoff); a settle whose last assistant message carries
// stopReason "error" means those retries were exhausted. The guard then
// mechanically re-issues the request — transient server classes only (timeout,
// rate limit, overload, connection); context overflow and deterministic errors
// are NOT retried (they belong to the distill machinery / the ladder).
// ---------------------------------------------------------------------------
run({
  name: "v0.30.0 P5b: server-timeout settle → mechanical retry → completed",
  args: [TASK, "--idle-timeout", "2"],
  phases: [
    [{ errorStop: "request to the model server timed out after 120000ms" }, { settled: {} }],
    done("Recovered after the server error."),
  ],
  expect: ["P5b error-stop retry 1/3", '"status":"completed"', '"errorRetries":1'],
  assertFiles: [
    { path: "pi-child-result.json", expect: ['"errorRetries": 1'] },
    { path: "pi-child-progress.log", expect: ["[error-retry]"] },
  ],
});

run({
  name: "v0.30.0 P5b: --max-error-retries 0 → no retry, normal classification (degenerate → ladder)",
  args: [TASK, "--max-error-retries", "0", "--idle-timeout", "1"],
  phases: [
    [{ errorStop: "request to the model server timed out after 120000ms" }, { settled: {} }],
  ],
  expect: ["degenerate settle"],
  expectNot: ["P5b error-stop retry"],
  expectExit: 3,
});

run({
  name: "v0.30.0 P5b: context-overflow error is NOT mechanically retried",
  args: [TASK, "--max-error-retries", "3", "--idle-timeout", "1"],
  phases: [
    [{ errorStop: "Context window exceeded: 150000 tokens in a 32768-token window" }, { settled: {} }],
  ],
  expect: ["degenerate settle"],
  expectNot: ["P5b error-stop retry"],
  expectExit: 3,
});

// ---------------------------------------------------------------------------
// v0.35.16 (run89): the transient 143 first-prompt death strikes AFTER
// protection verification (1 s after launch, zero tool calls — run89's
// subrun67 window), so the startup retry loop must relaunch THROUGH it (the
// old retry window ended at verification), and the terminal error path must
// run the chain step — pre-fix the error path skipped it, the tree kept
// claiming the window, and the monitor ping-ponged 68+ minutes on the
// dangling window (no chain-done.json, no hand-back, no run report).
// ---------------------------------------------------------------------------
run({
  name: "v0.35.16: first-prompt child death → relaunch budget + chain finalization (exit 1)",
  args: [TASK, "--out-dir", "sup"],
  phases: [],
  extra: {
    rejectPromptsAfter: 0,
    rejectPromptMessage: "Agent process exited (code=143 signal=null). Stderr: Warning: No project session found with that id",
  },
  env: (dir) => ({ PI_SUP_PROJECT: dir }),
  setup: (dir) => {
    mkdirSync(join(dir, ".pi-supervisor"), { recursive: true });
    writeFileSync(join(dir, ".pi-supervisor", "node.json"), JSON.stringify({
      v: 2, name: "(root)", path: "/", parent: null, deadline: null,
      state: "active", children: [], createdAt: new Date().toISOString(),
    }));
  },
  expectExit: 1,
  expect: ["first-prompt child death", "startup attempt 2/3", "startup attempt 3/3"],
  assertFiles: [
    { path: "sup/pi-child-status.json", expect: ["\"status\": \"error\""] },
    { path: "sup/chain-done.json", expect: ["\"next\": \"halted\""] },
    { path: "sup/chain-halt.json", expect: ["human attention needed"] },
    { path: ".pi-supervisor/node.json", expect: ["blocked"] },
  ],
});

console.log(`\n=== ${passCount} passed, ${failCount} failed ===`);
process.exit(failCount === 0 ? 0 : 1);
