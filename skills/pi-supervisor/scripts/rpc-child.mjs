#!/usr/bin/env node
// rpc-child.mjs — spawn a child pi agent (RPC mode) and hold a multi-turn
// conversation with it. Bundled with the pi-supervisor skill.
//
// Usage:
//   node rpc-child.mjs "one-shot prompt"
//   node rpc-child.mjs --turn "..." --turn "..."
//   node rpc-child.mjs --provider llama.cpp --model <model> --timeout 600000 --turn "..."
//
// Behavior:
//   - The child matches the parent session's model by default: --provider /
//     --model flags > PI_PROVIDER / PI_MODEL env vars (set by pi on its own
//     tools) > the parent session file (PI_SESSION_FILE, else the most
//     recently modified session jsonl). Without any of those a bare child
//     uses the configured default model.
//   - Excludes the ask_user_question tool by default: dialog tools make the
//     child block on an extension_ui_request until the client answers it.
//     --keep-question-tool disables the exclusion (then the client MUST answer
//     dialogs via extension_ui_response, see docs/rpc-extension-ui.md).
//   - Streams the child's live text to stdout; tool activity + diagnostics go
//     to stderr.
//   - Prints [reply-N] blocks and a final machine-readable line:
//       === RESULT === {"replies":["...", "..."]}
//   - Exits non-zero on timeout or child failure.
//   - Strict CLI: unknown --flags are an error (exit 2) — they used to be
//     silently swallowed into the prompt text. A bare -- ends flag parsing.
//   - Sessions: --no-session (throwaway) by default. --session-id <id> persists
//     the session under a stable ID (created if missing); later runs with the
//     same ID and working directory resume the conversation. --session
//     <path|id> resumes an existing session. --session-dir / --name pass
//     through. The resolved session (id + file) is printed to stderr.
//
// Run from the directory the child should work in (it inherits this cwd).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `Usage:
  node rpc-child.mjs "one-shot prompt"
  node rpc-child.mjs --turn "prompt 1" --turn "prompt 2" ...
Options:
  --provider <p>      Provider for the child (default: parent session's provider)
  --model <m>         Model for the child (default: parent session's model)
  --timeout <ms>      Per-turn timeout (default: 300000 = 5 min; RpcClient's
                      own default is only 60000, too short for slow local models)
  --keep-question-tool  Do not exclude ask_user_question (child can then block
                      on extension-UI dialogs; you must answer them)
  --session-id <id>   Persist the child's session under this exact ID (created
                      if missing). Later runs with the same ID and working
                      directory resume the conversation.
  --session <path|id> Resume an existing session file or exact session ID
                      (e.g. from a TUI run). Mutually exclusive with
                      --session-id.
  --session-dir <dir> Override where sessions are stored/looked up (default:
                      ~/.pi/agent/sessions, grouped by project/cwd)
  --name <name>       Set the session display name (findable in pi --resume)
  -h, --help          Show this help`;

const argv = process.argv.slice(2);
const turns = [];
const positional = [];
let provider = "";
let model = "";
let timeoutMs = 5 * 60 * 1000;
let keepQuestionTool = false;
let sessionId = "";
let sessionRef = "";
let sessionDir = "";
let sessionName = "";

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--turn") turns.push(argv[++i]);
  else if (a === "--provider") provider = argv[++i];
  else if (a === "--model") model = argv[++i];
  else if (a === "--timeout") timeoutMs = Number(argv[++i]);
  else if (a === "--keep-question-tool") keepQuestionTool = true;
  else if (a === "--session-id") sessionId = argv[++i];
  else if (a === "--session") sessionRef = argv[++i];
  else if (a === "--session-dir") sessionDir = argv[++i];
  else if (a === "--name") sessionName = argv[++i];
  else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (a === "--") {
    positional.push(...argv.slice(i + 1));
    break;
  } else if (a.startsWith("--")) {
    console.error(`error: unknown flag "${a}" — unknown flags used to be silently treated as prompt text`);
    console.error(`valid flags: --turn --provider --model --timeout --keep-question-tool --session-id --session --session-dir --name -h --help`);
    console.error(`if your prompt starts with --, put a bare -- before it`);
    process.exit(2);
  } else positional.push(a);
}

for (const [flag, value] of [
  ["--provider", provider],
  ["--model", model],
  ["--session-id", sessionId],
  ["--session", sessionRef],
  ["--session-dir", sessionDir],
  ["--name", sessionName],
]) {
  if (value === undefined) {
    console.error(`error: ${flag} requires a value`);
    console.log(USAGE);
    process.exit(2);
  }
}
if (sessionId && sessionRef) {
  console.error("error: --session-id and --session are mutually exclusive");
  console.log(USAGE);
  process.exit(2);
}

// Best-effort parent-session discovery: the most recently modified session
// jsonl. Used only when PI_SESSION_FILE is absent (e.g. MCP-sandbox envs
// where pi exports no session vars).
function latestSessionFile() {
  try {
    const root = join(homedir(), ".pi", "agent", "sessions");
    const files = [];
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      for (const f of readdirSync(join(root, d.name))) {
        if (f.endsWith(".jsonl")) {
          const p = join(root, d.name, f);
          files.push({ p, m: statSync(p).mtimeMs });
        }
      }
    }
    files.sort((a, b) => b.m - a.m);
    return files.length > 0 ? files[0].p : "";
  } catch {
    return "";
  }
}

// The child matches the parent session's model by default. Per field:
// explicit flag > PI_PROVIDER/PI_MODEL env (pi sets these on its own tools)
// > the parent session file's last model-carrying message (PI_SESSION_FILE,
// else the most recently modified session jsonl). sourceFile is set only
// when both fields came from the session (used for the log line).
function discoverParentModel(flagProvider, flagModel) {
  const provider = flagProvider || process.env.PI_PROVIDER || "";
  const model = flagModel || process.env.PI_MODEL || "";
  if (provider && model) return { provider, model, sourceFile: "" };
  const sf = process.env.PI_SESSION_FILE || latestSessionFile();
  if (!sf) return { provider, model, sourceFile: "" };
  try {
    let last = null;
    for (const line of readFileSync(sf, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line).message;
        if (m && m.provider && m.model) last = m;
      } catch { /* non-message line */ }
    }
    if (!last) return { provider, model, sourceFile: "" };
    return {
      provider: provider || last.provider,
      model: model || last.model,
      sourceFile: provider || model ? "" : sf,
    };
  } catch {
    return { provider, model, sourceFile: "" };
  }
}

const pm = discoverParentModel(provider, model);
provider = pm.provider;
model = pm.model;

const prompts = turns.length > 0 ? turns : positional;
if (prompts.some((p) => p === undefined) || prompts.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

// Locate the installed @earendil-works/pi-coding-agent package:
// PI_PACKAGE_DIR > self-managed install (~/.pi/agent/install/releases/<ver>,
// per the current-version file) > npm root -g > %APPDATA%\npm.
function resolvePackageDir() {
  const candidates = [];
  if (process.env.PI_PACKAGE_DIR) candidates.push(process.env.PI_PACKAGE_DIR);
  try {
    const installRoot = join(homedir(), ".pi", "agent", "install");
    const version = readFileSync(join(installRoot, "current-version"), "utf8").trim();
    if (version) {
      candidates.push(
        join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent")
      );
    }
  } catch {
    // not a self-managed install — fall through
  }
  try {
    const root = execFileSync("npm", ["root", "-g", "--silent"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (root) candidates.push(join(root, "@earendil-works", "pi-coding-agent"));
  } catch {
    // npm not available or not installed globally — fall through
  }
  if (process.env.APPDATA) {
    candidates.push(
      join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent")
    );
  }
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, "dist", "index.js"))) return dir;
  }
  console.error(
    "error: could not locate @earendil-works/pi-coding-agent. " +
      "Set PI_PACKAGE_DIR to the directory containing dist/index.js."
  );
  process.exit(2);
}

const pkgDir = resolvePackageDir();
const cliPath = [join(pkgDir, "dist", "bundle", "cli.js"), join(pkgDir, "dist", "cli.js")].find(
  (p) => existsSync(p)
);
if (!cliPath) {
  console.error(`error: no cli entry found under ${pkgDir}/dist`);
  process.exit(2);
}

// Import RpcClient by absolute path (works without a local node_modules).
const { RpcClient } = await import(pathToFileURL(join(pkgDir, "dist", "index.js")).href);

const args = [];
if (sessionId) args.push("--session-id", sessionId);
else if (sessionRef) args.push("--session", sessionRef);
else args.push("--no-session");
if (sessionDir) args.push("--session-dir", sessionDir);
if (sessionName) args.push("--name", sessionName);
if (provider) args.push("--provider", provider);
if (model) args.push("--model", model);
if (!keepQuestionTool) args.push("--exclude-tools", "ask_user_question");

const client = new RpcClient({ cliPath, args });

const replies = [];
let turnText = "";
const off = client.onEvent((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
    turnText += event.assistantMessageEvent.delta;
  } else if (event.type === "tool_execution_start") {
    process.stderr.write(`\n[child tool: ${event.toolName}]\n`);
  } else if (event.type === "extension_ui_request") {
    // Only dialog methods block; fire-and-forget ones (notify, setStatus,
    // setWidget, setTitle, set_editor_text) expect no response.
    if (["select", "confirm", "input", "editor"].includes(event.method)) {
      process.stderr.write(
        `\n[WARN] child blocked on extension-UI dialog (method=${event.method}, id=${event.id}); ` +
          `it will hang until the client answers via extension_ui_response\n`
      );
    }
  }
});

let exitCode = 1;
try {
  if (provider && model) {
    process.stderr.write(`[info] child provider=${provider} model=${model}${pm.sourceFile ? ` (inherited from ${pm.sourceFile})` : ""}\n`);
  } else {
    process.stderr.write("[warn] no parent provider/model found (flags, PI_PROVIDER/PI_MODEL, or session file); child will use configured defaults\n");
  }
  process.stderr.write(`[info] starting child: ${cliPath} --mode rpc ${args.join(" ")}\n`);
  await client.start();

  // Print the resolved session so a later run can resume it (or so a human
  // can find the transcript). Best-effort: diagnostics only.
  try {
    const st = await client.getState();
    if (st && st.sessionFile) {
      process.stderr.write(
        `[info] session id=${st.sessionId ?? "?"} name=${st.sessionName ?? "-"} file=${st.sessionFile}\n`
      );
    }
  } catch { /* get_state failed — session info is diagnostic only */ }

  for (let i = 0; i < prompts.length; i++) {
    process.stdout.write(`\n--- turn ${i + 1} (parent → child) ---\n${prompts[i]}\n\n[child → parent]\n`);
    turnText = "";
    // 3rd arg = per-turn timeout in ms. Waits for agent_settled (agent_end alone
    // is not enough: retries/compaction/queued work can follow).
    await client.promptAndWait(prompts[i], undefined, timeoutMs);
    const reply = turnText.trim();
    replies.push(reply);
    process.stdout.write(`\n[reply-${i + 1}]\n${reply}\n`);
  }

  process.stdout.write(`\n=== RESULT === ${JSON.stringify({ replies })}\n`);
  exitCode = 0;
} catch (err) {
  process.stderr.write(`\n[error] ${err.message}\n`);
} finally {
  off();
  await client.stop().catch(() => {});
}
process.exit(exitCode);
