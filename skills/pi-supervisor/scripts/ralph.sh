#!/usr/bin/env bash
# ralph.sh — v0.26.0: run a supervised child with zero arguments.
# (v0.26.0 = sub-runs: spawn requests + the guard-driven chain step; see SKILL.md)
#
# ZERO-ARG MODE (the point of this script):
#   1. put a TASK.md in the current directory (your project)
#   2. ./ralph.sh
#   that's it — the script finds TASK.md, allocates a run dir IN THE PROJECT
#   (<project>/.pi-supervisor/runs/run-N — permanent: nothing lives in /tmp,
#   a reboot mid-run leaves every artifact on disk), copies TASK.md into it,
#   launches the guarded child via launch.mjs, then runs the ralph monitor loop
#   IN THE FOREGROUND.
#
#   Your terminal is the view: every ralph cycle is printed as it happens,
#   and Ctrl+C stops the WHOLE run — monitor + guard + child (graceful
#   SIGTERM, escalating to SIGKILL — the same kill stop.mjs does), then the
#   usual harvest.
#
#   When the monitor exits (success, failure, deadline, or Ctrl+C) the run
#   dir is HARVESTED: the child transcript is copied into the run dir,
#   RUN-REPORT.md + run-summary.json are written, and INDEX.json (one entry
#   per run) is updated. Every run ends as a self-contained, findable
#   evidence folder — even one killed by a reboot: the NEXT launch sees the
#   dead run in the pointer file and harvests it before starting fresh.
#
#   One-time setup (pick ONE, then plain `ralph.sh` works from any project):
#     A) PATH (recommended — zero per-project files):
#        echo 'export PATH="$HOME/.pi/agent/git/github.com/Foxclip/pi-skills/skills/pi-supervisor/scripts:$PATH"' >> ~/.bashrc
#     B) per-project symlink (visible in the repo):
#        ln -s ~/.pi/agent/git/github.com/Foxclip/pi-skills/skills/pi-supervisor/scripts/ralph.sh ralph.sh
#
# ENVIRONMENT (all optional; CLI flags in power-user mode override these):
#   TASK_FILE      task file in cwd           (default: TASK.md)
#   RUNS_DIR       run-dir root               (default: <project>/.pi-supervisor/runs)
#   PI             pi executable             (default: pi)
#   MODEL/PROVIDER   for BOTH child and parent (default: pi's default model —
#                the safe shared config on shared local model servers)
#   CHILD_MODEL/CHILD_PROVIDER    override the CHILD's model only
#   CHILD_THINKING   the CHILD's thinking level (off|minimal|low|medium|high)
#                — CLI: --child-thinking <level>. A model-spec suffix works too
#                (--child-model provider/id:off). Needed e.g. when a thinking
#                model loops in first-turn thinking on a task: level off makes
#                it act. (The PARENT's thinking level is not affected.)
#   PARENT_MODEL/PARENT_PROVIDER  override the PARENT's (ralph's) model only
#                (e.g. child on a big local model, parent on a fast/cloud one)
#   DEADLINE       ISO | "HH:MM" | epoch     (default: now + MAX_HOURS)
#   RUNTIME        relative deadline — bare minutes (90) or a duration
#                (45s/90m/2h/1h30m/1d); deadline = now + RUNTIME.
#                If both DEADLINE and RUNTIME are set, DEADLINE (absolute) wins.
#   MAX_HOURS      deadline horizon          (default: 12)
#   PREAMBLE       child preamble text       (default: standard)
#   IDLE_TIMEOUT   guard idle timeout, sec   (default: 300)
#   TURN_STALL_SEC guard turn-stall limit, sec — abort + fork a single turn still alive
#                after this long (degenerate-generation catch; default: 900, 0=off)
#   CYCLE_SEC (1200)  TIMEOUT_SEC (600)  MAX_INTERVENTIONS (3)
#   STUCK_SEC (3600)  STALE_SEC (180)  LLM_FAIL_MAX (6)
#   PROMPT_FILE  PROJECT_DIR  SESSION  LOG_FILE   (ralph-monitor passthrough)
#
# FLAGS (v0.19.3 — accepted anywhere in the argument list, in any mode;
# they map onto the env vars above, so FLAGS WIN OVER ENV):
#   --deadline <ISO|HH:MM|epoch>    = DEADLINE
#   --runtime <duration>            = RUNTIME (relative: 90 = 90min, or 45s/90m/2h/1h30m)
#   --child-model <spec>            = CHILD_MODEL   (the child's model)
#   --parent-model <spec>           = PARENT_MODEL  (ralph's judgment model)
#   --task <path>                   = TASK_FILE   (task file, any path; default TASK.md)
#   --cycle <duration>              parent's judgment period (45s/90m/2h/1h30m/2h30m;
#                                  default 20m; env CYCLE_SEC = bare seconds)
# Both `--flag value` and `--flag=value` forms work.
#
# EVERY message this wrapper prints is timestamped `[YYYY-MM-DD HH:MM:SS.mmm]`
# in LOCAL time (the terminal is for humans; the log FILES keep ISO-8601 UTC
# — the two differ only in the prefix, so a terminal line is still findable
# in the log by its text). Quoted output blocks (a launch failure,
# ralph-monitor's child-stderr) keep their body raw under a timestamped header.
#
# MODES:
#   ralph.sh                       zero-arg pipeline (above)
#   ralph.sh <run-dir> [args...]   attach to an existing run (power-user;
#                                  args go to ralph-monitor.mjs and win over
#                                  env vars — last occurrence wins)
#   ralph.sh --harvest <run-dir> [dest-dir]
#                                  post-mortem any run dir (idempotent); with
#                                  dest-dir the whole run dir is copied there
#                                  FIRST — use it to rescue a /tmp run to a
#                                  permanent home
#   ralph.sh stop [--all | <run-dir>] [--force]
#                                  stop EVERY process a run started (guard +
#                                  child, whole process group — graceful
#                                  SIGTERM, escalating to SIGKILL), then
#                                  harvest the stopped run. Target: --all =
#                                  every run in .pi-supervisor/runs; a
#                                  <run-dir>; default = the run in the pointer
#                                  file, else the newest run with a status file.
#                                  A still-running ralph.sh monitor notices the
#                                  dead child on its next pre-check (≤5s) and
#                                  exits by itself — no need to kill it.
#   ralph.sh spawn --name <node> --task <file> [--deadline <t>] [--runtime <m>]
#                                  [--reason <text>]     (v0.26.0 — THE CHILD'S
#                                  API, run from inside a supervised window:
#                                  writes spawn-request.json into this window's
#                                  run dir and prints a receipt. It NEVER
#                                  launches — the chain step launches the child
#                                  node when this window ends. A child's direct
#                                  launches (zero-arg ralph.sh) are DENIED via
#                                  the PI_SUP_CHILD gate; see SKILL.md
#                                  "Sub-runs (nodes, spawn requests, the chain)").
#
set -euo pipefail

# resolve our own real location so HERE finds launch.mjs/ralph-monitor.mjs:
# - $0 (not BASH_SOURCE[0] — the latter expands unreliably in this box's bash)
# - works for both invocation styles: `./ralph.sh` (symlink) and bare `ralph.sh`
#   via PATH (bash passes the full resolved path as $0 in both cases)
# - readlink -f: the entry may be a symlink — we want the scripts dir, not the project
HERE="$(cd "$(dirname "$(readlink -f "${0}")")" && pwd)"
PI_BIN="${PI:-pi}"
HARVEST_TARGET=""   # set once RUN_DIR is known; the EXIT trap harvests it

# ------------------------------------------------------------- kernel protection (v0.26.0)
# The child pi (and the parent's judgment/final-report turns) run as a separate
# OS user: the owner's 700 run tree is simply unreadable/unwritable to it —
# kernel-level DAC, enforced by the filesystem, not by prompts. protect.mjs
# installs the user + ACLs + scoped passwordless sudo + a self bind-mount on
# .pi-supervisor (closes the `mv` hole a DAC-only layout leaves). Idempotent;
# re-asserted on every window. PI_SUP_NO_PROTECT=1 opts out (test sandboxes).
PI_PROTECT_USER=""
if [ -z "${PI_SUP_NO_PROTECT:-}" ] && [ "$(uname -s)" = "Linux" ]; then
  PI_PROTECT_USER="${PI_SUP_CHILD_USER:-pichild}"
  PI_BIN_ABS="$(command -v -- "$PI_BIN" 2>/dev/null || true)"
  export PI_SUP_CHILD_USER="$PI_PROTECT_USER"   # monitor (pi-as-child) + chain repair inherit
fi
resolve_protection_paths() { # sets REAL_CLI / NODE_PATH / NODE_BIN_DIR / PI_ABS
  NODE_PATH="$(command -v node 2>/dev/null || true)"
  NODE_BIN_DIR="$(dirname "$NODE_PATH" 2>/dev/null || true)"
  REAL_CLI="$(node -e '
    const { existsSync, readFileSync } = require("fs");
    const { join } = require("path");
    const { homedir } = require("os");
    const cands = [];
    if (process.env.PI_PACKAGE_DIR) cands.push(join(process.env.PI_PACKAGE_DIR, "dist", "bundle", "cli.js"));
    try {
      const v = readFileSync(join(homedir(), ".pi", "agent", "install", "current-version"), "utf8").trim();
      for (const e of ["bundle", ""])
        cands.push(join(homedir(), ".pi", "agent", "install", "releases", v, "node_modules", "@earendil-works", "pi-coding-agent", "dist", e ? e + "/cli.js" : "cli.js"));
    } catch {}
    for (const p of cands) if (existsSync(p)) { console.log(p); break; }
  ' 2>/dev/null || true)"
  PI_ABS="${PI_BIN_ABS:-}"
}
protect_apply() { # $1=project dir  $2=live run dir (may be "")
  [ -n "$PI_PROTECT_USER" ] || return 0
  local proj="$1" live="${2:-}"
  case "$live" in ""|"$proj"/*) ;; *) live="" ;; esac   # only our own windows are rwx
  resolve_protection_paths
  if [ -z "$NODE_PATH" ]; then
    saye "${C_R}✗${C_N} kernel protection: node not found on PATH — cannot protect the run (set PI_SUP_NO_PROTECT=1 to opt out)"
    return 1
  fi
  if [ -z "$REAL_CLI" ]; then
    saye "${C_R}✗${C_N} kernel protection: cannot locate the pi CLI bundle — set PI_PACKAGE_DIR (or PI_SUP_NO_PROTECT=1 to opt out)"
    return 1
  fi
  if [ -z "$PI_ABS" ] || [ ! -f "$PI_ABS" ]; then
    saye "${C_R}✗${C_N} kernel protection: pi binary '${PI_BIN}' not found on PATH — cannot protect the run"
    return 1
  fi
  local out
  if out="$(node "$HERE/lib/protect.mjs" apply --project "$proj" ${live:+--live "$live"} \
      --user "$PI_PROTECT_USER" --pi-bin "$PI_ABS" --real-cli "$REAL_CLI" \
      --node "$NODE_PATH" --node-bin-dir "$NODE_BIN_DIR" \
      ${PI_SUP_WORK_DIRS:+--work-dirs "$PI_SUP_WORK_DIRS"} 2>&1)"; then
    printf '%s\n' "$out" | grep -q '"firstRun":true' 2>/dev/null \
      && saye "${C_G}✓${C_N} kernel protection on — child + parent sessions run as '$PI_PROTECT_USER'" \
      || saye "${C_D}·${C_N} kernel protection current (user=$PI_PROTECT_USER)"
  else
    saye "${C_R}✗${C_N} kernel protection FAILED (protect.mjs):"; printf '%s\n' "$out" | tail -5 >&2
    return 1
  fi
  # the pi-as-child wrapper (parent sessions) reads the real pi path from disk
  printf '%s\n' "$PI_ABS" > "$proj/.pi-supervisor/pi-abs" 2>/dev/null || true
  return 0
}
protect_unprotect() { # $1=project dir
  [ -n "$PI_PROTECT_USER" ] || { saye "${C_D}·${C_N} kernel protection is not in effect (PI_SUP_NO_PROTECT)"; return 0; }
  local proj="$1"
  resolve_protection_paths
  node "$HERE/lib/protect.mjs" unprotect --project "$proj" --user "$PI_PROTECT_USER" \
      ${PI_ABS:+--pi-bin "$PI_ABS"} ${REAL_CLI:+--real-cli "$REAL_CLI"} \
      ${NODE_BIN_DIR:+--node-bin-dir "$NODE_BIN_DIR"}
  rm -f "$proj/.pi-supervisor/pi-abs" 2>/dev/null || true
}

# every wrapper message is timestamped in LOCAL time (terminal = human-facing;
# the log files keep ISO-8601 UTC — see ts() format vs the monitor's log())
# ------------------------------------------------------------- terminal (v0.21.0, glyphs v0.24.0)
# human-facing terminal: short local ts [HH:MM:SS] (full precision lives in
# the log FILES, whose formats are unchanged), ANSI colors only when stderr is
# a tty and NO_COLOR is unset, a context banner at start, boxed final report.
# v0.24.0: EVERY terminal line starts with a status glyph (the same language
# ralph-monitor and harvest use): · info (dim)  … in progress (cyan)  ! warn
# (yellow)  ✓ success (green)  ✗ failure (red). No source prefixes (`ralph:`,
# `harvest:`) — the glyph language is shared, so they were redundant.
ts()   { date +"%Y-%m-%d %H:%M:%S.%3N"; }
ts_s() { date +"%H:%M:%S"; }
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  C_B=$(printf '\033[1m'); C_D=$(printf '\033[2m'); C_G=$(printf '\033[32m')
  C_Y=$(printf '\033[33m'); C_R=$(printf '\033[31m'); C_N=$(printf '\033[0m')
else C_B=""; C_D=""; C_G=""; C_Y=""; C_R=""; C_N=""; fi
say()  { printf '[%s] %s\n' "$(ts)" "$*"; }
saye() { printf '%s[%s]%s %s\n' "$C_D" "$(ts_s)" "$C_N" "$*" >&2; }
sayc() { printf '%s[%s]%s     %s\n' "$C_D" "$(ts_s)" "$C_N" "$*" >&2; }   # continuation: dim, indented under the glyph column
# v0.25.15: the wrapper's own on-disk record — <run-dir>/ralph.log. Before this,
# everything ralph.sh said lived only in terminal scrollback: the 2026-11-02 run
# that printed `✗ done · exit 127` left no trace of which shell waited on which
# monitor pid for how long, and the mechanism had to be proved from the bash
# source instead of read from a log. No-op until RUN_DIR is set; never fails.
rlog() {
  local rd="${RUN_DIR:-}"
  [ -n "$rd" ] && [ -d "$rd" ] || return 0
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$*" >> "$rd/ralph.log" 2>/dev/null || true
  return 0
}
human_secs() { local s=${1:-0} h m r; case "$s" in ''|*[!0-9]*) echo "${s}s"; return;; esac
  if [ "$s" -ge 3600 ]; then h=$((s / 3600)); m=$(( (s % 3600) / 60 )); [ "$m" -eq 0 ] && echo "${h}h" || echo "${h}h ${m}m";
  elif [ "$s" -ge 60 ]; then m=$((s / 60)); r=$((s % 60)); [ "$r" -eq 0 ] && echo "${m}m" || echo "${m}m ${r}s";
  else echo "${s}s"; fi; }
human_dl() { # $1 epoch|ISO|HH:MM → "YYYY-MM-DD HH:MM (in 11h 58m)"
  local sec now rel sign span
  case "$1" in
    ''|*[!0-9]*) sec=$(date -d "$1" +%s 2>/dev/null) || { echo "${1}"; return; } ;;  # ISO / HH:MM
    *) sec="$1" ;;                                                                 # bare epoch — date -d rejects it
  esac
  now=$(date +%s); rel=$(( sec - now )); sign="in"
  [ $rel -lt 0 ] && { rel=$(( -rel )); sign="ago"; }
  if [ $rel -ge 86400 ]; then span="$((rel / 86400))d $((rel % 86400 / 3600))h"
  elif [ $rel -ge 3600 ]; then span="$((rel / 3600))h $((rel % 3600 / 60))m"
  else span="$((rel / 60))m"; fi
  echo "$(date -d "@$sec" +'%Y-%m-%d %H:%M')   ($sign $span)"; }
rule() { printf '─%.0s' $(seq 1 50); }
banner() { # $1=mode: launch|attach — uses RUN_DIR, DEADLINE_EPOCH, PROJECT_DIR (all may be unset in attach)
  local runrel="$RUN_DIR" pd="${PROJECT_DIR:-}"
  case "$RUN_DIR" in "$pd"/*) [ -n "$pd" ] && runrel=".pi-supervisor/runs/$(basename "$RUN_DIR")" ;; esac
  {
  local mon
  mon="monitoring — cycle every $(human_secs "${CYCLE_SEC:-1200}") · Ctrl+C stops the whole run (monitor + guard + child)"
  if [ "$1" = attach ]; then mon="monitoring attached run — cycle every $(human_secs "${CYCLE_SEC:-1200}") · Ctrl+C stops the whole run (monitor + guard + child)"; fi
  printf '%s┌ ralph%s %s\n' "$C_B" "$C_N" "$(rule)"
  printf '│ project   %s\n' "$( [ -n "$pd" ] && basename "$pd" || echo unknown )"
  printf '│ run       %s\n' "$runrel"
  printf '│ deadline  %s\n' "$(human_dl "${DEADLINE_EPOCH:-}")"
  local _ct=""; [ -n "${CHILD_THINKING:-}" ] && _ct=" (think: ${CHILD_THINKING})"
  printf '│ models    child=%s%s · parent=%s\n' "${CHILD_MODEL_VAL:-pi-default}" "$_ct" "${PARENT_MODEL_VAL:-pi-default}"
  printf '│ %s\n' "$mon"
  printf '└%s\n' "$(rule)"
  } >&2; }

dur_sec() { # $1: 90 | 45s | 90m | 2h | 1d | 1h30m → seconds (a bare number = minutes)
  local s="$1" total
  if [[ "$s" =~ ^[0-9]+$ ]]; then [ "$s" -gt 0 ] || return 1; echo $(( s * 60 )); return 0; fi
  [[ "$s" =~ ^([0-9]+d)?([0-9]+h)?([0-9]+m)?([0-9]+s)?$ ]] || return 1
  local d="${BASH_REMATCH[1]%%d*}" h="${BASH_REMATCH[2]%%h*}" m="${BASH_REMATCH[3]%%m*}" sec="${BASH_REMATCH[4]%%s*}"
  total=$(( ${d:-0} * 86400 + ${h:-0} * 3600 + ${m:-0} * 60 + ${sec:-0} ))
  [ "$total" -gt 0 ] || return 1
  echo "$total"
}

# ------------------------------------------------------------- spawn (v0.26.0)
# THE CHILD'S API — dispatched BEFORE the global CLI flag parser: spawn's own
# flags (--task / --runtime / --deadline) share names with the wrapper's launch
# knobs and must not be eaten as those. The child writes a request file; the
# chain step (supervisor side) does the launching. The child's env carries
# PI_SUP_RUN_DIR (set by launch.mjs) — without it, this is not a child.
if [ "${1:-}" = "spawn" ]; then
  shift
  SP_NAME=""; SP_TASK=""; SP_DEADLINE=""; SP_RUNTIME=""; SP_REASON=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --name)      [ $# -ge 2 ] || { saye "${C_R}✗${C_N} spawn: --name needs a value"; exit 2; }; SP_NAME=$2; shift 2 ;;
      --name=*)    SP_NAME=${1#*=}; shift ;;
      --task)      [ $# -ge 2 ] || { saye "${C_R}✗${C_N} spawn: --task needs a value"; exit 2; }; SP_TASK=$2; shift 2 ;;
      --task=*)    SP_TASK=${1#*=}; shift ;;
      --deadline)  [ $# -ge 2 ] || { saye "${C_R}✗${C_N} spawn: --deadline needs a value"; exit 2; }; SP_DEADLINE=$2; shift 2 ;;
      --deadline=*) SP_DEADLINE=${1#*=}; shift ;;
      --runtime)   [ $# -ge 2 ] || { saye "${C_R}✗${C_N} spawn: --runtime needs a value"; exit 2; }; SP_RUNTIME=$2; shift 2 ;;
      --runtime=*) SP_RUNTIME=${1#*=}; shift ;;
      --reason)    [ $# -ge 2 ] || { saye "${C_R}✗${C_N} spawn: --reason needs a value"; exit 2; }; SP_REASON=$2; shift 2 ;;
      --reason=*)  SP_REASON=${1#*=}; shift ;;
      -h|--help)
        cat <<'USAGE'
ralph.sh spawn — request a sub-run (a sub-project node) from inside a window
  ralph.sh spawn --name <node> --task <file> [--deadline <ISO|HH:MM|epoch>]
                 [--runtime <duration>] [--reason <text>]
Writes spawn-request.json into this window's run dir and prints a receipt.
It NEVER launches: the chain step launches the child node when this window
ends, and re-enters this node afterwards. END YOUR TURN after spawning —
direct launches are denied for child sessions (the PI_SUP_CHILD gate).
USAGE
        exit 0 ;;
      *) saye "${C_R}✗${C_N} spawn: unknown argument: $1"; exit 2 ;;
    esac
  done
  if [ -z "${PI_SUP_RUN_DIR:-}" ] || [ ! -d "${PI_SUP_RUN_DIR:-}" ]; then
    saye "${C_R}✗${C_N} spawn: not inside a supervised window (PI_SUP_RUN_DIR is missing)"
    sayc "${C_D}spawn is the CHILD's API — meant to run inside a ralph window. To start a project the normal way: write TASK.md and run ralph.sh.${C_N}"
    exit 1
  fi
  [ -n "$SP_NAME" ] || { saye "${C_R}✗${C_N} spawn: --name is required (the sub-project node name)"; exit 2; }
  [[ "$SP_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { saye "${C_R}✗${C_N} spawn: bad node name \"${SP_NAME}\" — [A-Za-z0-9][A-Za-z0-9._-]* (no slashes, spaces, or leading dots)"; exit 2; }
  [[ "$SP_NAME" =~ ^run-[0-9]+$ ]] && { saye "${C_R}✗${C_N} spawn: node name \"${SP_NAME}\" collides with the window names (run-N)"; exit 2; }
  [ -n "$SP_TASK" ] || { saye "${C_R}✗${C_N} spawn: --task <file> is required (write the sub-project's task file first)"; exit 2; }
  case "$SP_TASK" in /*) SP_TASK_ABS=$SP_TASK ;; *) SP_TASK_ABS="$PWD/$SP_TASK" ;; esac
  [ -f "$SP_TASK_ABS" ] || { saye "${C_R}✗${C_N} spawn: task file not found: $SP_TASK_ABS"; exit 2; }
  [ -s "$SP_TASK_ABS" ] || { saye "${C_R}✗${C_N} spawn: task file is empty: $SP_TASK_ABS"; exit 2; }
  SP_RUNTIME_MIN=""
  if [ -n "$SP_RUNTIME" ]; then
    SP_RUNTIME_SEC="$(dur_sec "$SP_RUNTIME")" \
      || { saye "${C_R}✗${C_N} spawn: bad --runtime \"${SP_RUNTIME}\" — use bare minutes (90) or a duration (45s/90m/2h/1h30m)"; exit 2; }
    SP_RUNTIME_MIN=$(( (SP_RUNTIME_SEC + 59) / 60 ))
  fi
  SP_REQ="${PI_SUP_RUN_DIR}/spawn-request.json"
  SP_REQ_JSON="$(SP_NAME="$SP_NAME" SP_TASK_ABS="$SP_TASK_ABS" SP_DEADLINE="$SP_DEADLINE" SP_RUNTIME_MIN="$SP_RUNTIME_MIN" SP_REASON="$SP_REASON" SP_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" node -e '
const j = {
  kind: "spawn",
  node: process.env.SP_NAME,
  task: process.env.SP_TASK_ABS,
  deadline: process.env.SP_DEADLINE || null,
  runtime_min: process.env.SP_RUNTIME_MIN ? Number(process.env.SP_RUNTIME_MIN) : null,
  reason: process.env.SP_REASON || null,
  at: process.env.SP_AT,
};
process.stdout.write(JSON.stringify(j, null, 2) + "\n");')" \
    || { saye "${C_R}✗${C_N} spawn: failed to build the request JSON"; exit 1; }
  printf '%s\n' "$SP_REQ_JSON" > "$SP_REQ" || { saye "${C_R}✗${C_N} spawn: cannot write $SP_REQ"; exit 1; }
  saye "${C_G}✓${C_N} spawn request written: $SP_REQ"
  saye "${C_D}·${C_N} node=${SP_NAME} task=${SP_TASK_ABS}${SP_DEADLINE:+ deadline=${SP_DEADLINE}}${SP_RUNTIME_MIN:+ runtime=${SP_RUNTIME_MIN}m} — the chain step launches it when this window ends; this node will be re-entered afterwards. END THE TURN now (do not launch anything yourself).${C_N}"
  exit 0
fi

# ------------------------------------------------------------- CLI flags
# The four most-used knobs as flags, parseable BEFORE mode dispatch so they
# work in normal (zero-arg) mode: --deadline / --runtime / --child-model /
# --parent-model. They set the same variables the rest of the script reads
# (DEADLINE, RUNTIME, CHILD_MODEL, PARENT_MODEL) → flags win over env, by construction. Accepted
# anywhere in the arg list; positional args (run-dir, stop, --harvest, …) are
# preserved in order for mode dispatch below.
_cli_pos=()
while [ $# -gt 0 ]; do
  case "$1" in
    --deadline)        [ $# -ge 2 ] || { saye "${C_R}✗${C_N} --deadline needs a value"; exit 2; }; DEADLINE=$2; shift 2 ;;
    --deadline=*)      DEADLINE=${1#*=}; shift ;;
    --runtime)         [ $# -ge 2 ] || { saye "${C_R}✗${C_N} --runtime needs a value"; exit 2; }; RUNTIME=$2; shift 2 ;;
    --runtime=*)       RUNTIME=${1#*=}; shift ;;
    --child-model)     [ $# -ge 2 ] || { saye "${C_R}✗${C_N} --child-model needs a value"; exit 2; }; CHILD_MODEL=$2; shift 2 ;;
    --child-model=*)   CHILD_MODEL=${1#*=}; shift ;;
    --child-thinking)  [ $# -ge 2 ] || { saye "${C_R}✗${C_N} --child-thinking needs a value"; exit 2; }; CHILD_THINKING=$2; shift 2 ;;
    --child-thinking=*) CHILD_THINKING=${1#*=}; shift ;;
    --parent-model)    [ $# -ge 2 ] || { saye "${C_R}✗${C_N} --parent-model needs a value"; exit 2; }; PARENT_MODEL=$2; shift 2 ;;
    --parent-model=*)  PARENT_MODEL=${1#*=}; shift ;;
    --task)            [ $# -ge 2 ] || { saye "${C_R}✗${C_N} --task needs a value"; exit 2; }; TASK_FILE=$2; shift 2 ;;
    --task=*)          TASK_FILE=${1#*=}; shift ;;
    --cycle)           [ $# -ge 2 ] || { saye "${C_R}✗${C_N} --cycle needs a value"; exit 2; }; CYCLE_RAW=$2; shift 2 ;;
    --cycle=*)         CYCLE_RAW=${1#*=}; shift ;;
    -h|--help)
      cat <<'USAGE'
ralph.sh — supervised pi child (ralph loop). Zero-arg pipeline:
  ralph.sh                     find ./TASK.md → launch guarded child → monitor in foreground
  ralph.sh <run-dir> [flags]   attach to an existing run (power-user)
  ralph.sh stop [--all | <run-dir>] [--force]   stop a run's processes + harvest it
  ralph.sh --harvest <run-dir> [dest-dir]       harvest (re-runnable)
  ralph.sh spawn --name <node> --task <file> [--deadline <t>] [--runtime <m>]
                       [--reason <text>]   THE CHILD'S API (inside a window):
                       writes spawn-request.json; the chain step launches it
  ralph.sh unprotect [project-dir]   remove the kernel-protection boundary
                       (child user ACLs, scoped sudo rule, bind mount)
  ralph.sh -h | --help         this help
normal-mode flags (anywhere in the arg list): --deadline <ISO|HH:MM|epoch>
  --runtime <duration>    relative deadline: 90 = 90min, or 45s/90m/2h/1h30m
  --child-model <spec>  --parent-model <spec>    (--flag value and --flag=value)
  --child-thinking <level>   the CHILD's thinking level (off|minimal|low|medium|high)
  --task <path>           task file to run (default TASK.md)
  --cycle <duration>      parent's judgment period: 45s/90m/2h/2h30m (default 20m)
environment: PI TASK_FILE RUNS_DIR DEADLINE RUNTIME MAX_HOURS MODEL PROVIDER
  CHILD_MODEL CHILD_PROVIDER CHILD_THINKING PARENT_MODEL PARENT_PROVIDER PREAMBLE IDLE_TIMEOUT TURN_STALL_SEC FINALIZE
  CYCLE_SEC TIMEOUT_SEC MAX_INTERVENTIONS STUCK_SEC STALE_SEC LLM_FAIL_MAX
  PROMPT_FILE SESSION LOG_FILE
See the header comment in ralph.sh for the full contract.
USAGE
      exit 0 ;;
    *) _cli_pos+=("$1"); shift ;;
  esac
done
if [ ${#_cli_pos[@]} -gt 0 ]; then set -- "${_cli_pos[@]}"; else set --; fi

DEADLINE_RAW="${DEADLINE:-}"
RUNTIME_RAW="${RUNTIME:-}"
DEADLINE_USER_SET=0   # --deadline or --runtime given (env or flag) → do NOT adopt a run's stored deadline
[ -n "$DEADLINE_RAW" ] && DEADLINE_USER_SET=1
[ -n "$RUNTIME_RAW" ] && DEADLINE_USER_SET=1
if [ -n "$DEADLINE_RAW" ] && [ -n "$RUNTIME_RAW" ]; then
  saye "${C_Y}!${C_N} both --deadline and --runtime given — --deadline (absolute) wins"
fi
if [ -n "$DEADLINE_RAW" ]; then
  DEADLINE_EPOCH="$DEADLINE_RAW"   # ISO | "HH:MM" | epoch — launch.mjs and ralph-monitor both accept all three
elif [ -n "$RUNTIME_RAW" ]; then
  RUNTIME_SEC="$(dur_sec "$RUNTIME_RAW")" \
    || { saye "${C_R}✗${C_N} bad --runtime \"${RUNTIME_RAW}\" — use bare minutes (90) or a duration (45s/90m/2h/1h30m)"; exit 2; }
  DEADLINE_EPOCH=$(( $(date +%s) + RUNTIME_SEC ))   # relative → absolute now; epoch is accepted everywhere downstream
else
  DEADLINE_EPOCH=$(( $(date +%s) + ${MAX_HOURS:-12} * 3600 ))
fi
# --cycle: the parent's judgment period as a duration (2h30m) → CYCLE_SEC (sec)
if [ -n "${CYCLE_RAW:-}" ]; then
  CYCLE_SEC="$(dur_sec "$CYCLE_RAW")" \
    || { saye "${C_R}✗${C_N} bad --cycle \"${CYCLE_RAW}\" — use a duration (45s/90m/2h/1h30m)"; exit 2; }
fi

# model selection: MODEL/PROVIDER set BOTH sides; CHILD_*/PARENT_* override one side
CHILD_MODEL_VAL="${CHILD_MODEL:-${MODEL:-}}"
CHILD_PROVIDER_VAL="${CHILD_PROVIDER:-${PROVIDER:-}}"
PARENT_MODEL_VAL="${PARENT_MODEL:-${MODEL:-}}"
PARENT_PROVIDER_VAL="${PARENT_PROVIDER:-${PROVIDER:-}}"

# common ralph-monitor flags from env (explicit CLI args in power-user mode
# win: they are appended last and ralph-monitor takes the last occurrence)
ralph_flags=(--pi "$PI_BIN")
if [ -n "$PARENT_MODEL_VAL" ];      then ralph_flags+=(--model "$PARENT_MODEL_VAL"); fi
if [ -n "$PARENT_PROVIDER_VAL" ];   then ralph_flags+=(--provider "$PARENT_PROVIDER_VAL"); fi
if [ -n "${CYCLE_SEC:-}" ];         then ralph_flags+=(--cycle-sec "$CYCLE_SEC"); fi
if [ -n "${TIMEOUT_SEC:-}" ];       then ralph_flags+=(--timeout-sec "$TIMEOUT_SEC"); fi
# v0.23.0: the monitor waits the finalization window (+5 min slack) for the child's
# true terminal state after the deadline before exiting (default: FINALIZE*60+300)
ralph_flags+=(--finalize-grace-sec "${FINALIZE_GRACE_SEC:-$(( ${FINALIZE:-10} * 60 + 300 ))}")
if [ -n "${MAX_INTERVENTIONS:-}" ]; then ralph_flags+=(--max-interventions "$MAX_INTERVENTIONS"); fi
if [ -n "${STUCK_SEC:-}" ];         then ralph_flags+=(--stuck-sec "$STUCK_SEC"); fi
if [ -n "${STALE_SEC:-}" ];         then ralph_flags+=(--stale-sec "$STALE_SEC"); fi
if [ -n "${LLM_FAIL_MAX:-}" ];      then ralph_flags+=(--llm-fail-max "$LLM_FAIL_MAX"); fi
if [ -n "${PROMPT_FILE:-}" ];       then ralph_flags+=(--prompt-file "$PROMPT_FILE"); fi
if [ -n "${SESSION:-}" ];           then ralph_flags+=(--session "$SESSION"); fi
if [ -n "${LOG_FILE:-}" ];          then ralph_flags+=(--log-file "$LOG_FILE"); fi

status_field() { # $1=file $2=key → prints value or empty
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(v===null||v===undefined?"":String(v))}catch{}' "$1" "$2" 2>/dev/null || true
}
guard_alive() { # $1=run-dir → 0 if the status file names a live guard pid
  local pid
  pid=$(status_field "$1/pi-child-status.json" guardPid)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
harvest() { # $1=run-dir $2=interrupted(0|1) $3=monitor exit code (best effort)
  node "$HERE/lib/harvest.mjs" "$1" "$2" "$3" || true
}

# v0.25.11: stop a run and print ONE human line. stop.mjs still prints its
# full JSON result (consumed here, kept for the exit code) — the raw blob
# drowned the terminal, and the paths it carries are already on the lines
# before and after. Digest: outcome, how, and whether guard + child are
# confirmed dead.
stop_and_report() { # $1=run-dir; remaining args → stop.mjs (e.g. --force)
  local d="$1"; shift
  local out rc=0 line
  out=$(node "$HERE/stop.mjs" --out-dir "$d" "$@" 2>/dev/null) || rc=$?
  line=$(STOP_JSON="$out" STOP_RC="$rc" node -e '
    const rc = Number(process.env.STOP_RC);
    let j = {}; try { j = JSON.parse(process.env.STOP_JSON || "{}"); } catch {}
    const t = ((j.elapsedMs || 0) / 1000).toFixed(1) + "s";
    const dead = (v) => (v === true ? "confirmed dead" : v === false ? "STILL ALIVE" : "unknown");
    if (rc !== 0) console.log(`stop failed (exit ${rc})${j.reason ? " — " + j.reason : ""}`);
    else if (j.stoppedVia === "already-dead") console.log(`already stopped — guard ${j.guardPid} not running`);
    else if (j.stopped) console.log(`stopped in ${t} via ${j.signal || "?"} — guard: ${dead(j.confirmedDead && j.confirmedDead.guard)}, child: ${dead(j.confirmedDead && j.confirmedDead.child)}`);
    else console.log(j.reason || "nothing to stop");
  ' 2>/dev/null) || line="stop.mjs produced no summary"
  if [ "$rc" -eq 0 ]; then saye "${C_D}·${C_N} $line"
  else saye "${C_R}✗${C_N} $line"; fi
  return $rc
}

# ------------------------------------------------------------- unprotect
if [ "${1:-}" = "unprotect" ]; then
  shift
  UP_PROJECT=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --project)   [ $# -ge 2 ] || { saye "${C_R}✗${C_N} --project needs a value"; exit 2; }; UP_PROJECT="$2"; shift 2 ;;
      --project=*) UP_PROJECT="${1#*=}"; shift ;;
      -*) saye "${C_R}✗${C_N} unprotect: unknown flag: $1"; exit 2 ;;
      *) if [ -n "${UP_PROJECT:-}" ]; then saye "${C_R}✗${C_N} unprotect: one project dir at a time"; exit 2; fi
         UP_PROJECT="$1"; shift ;;
    esac
  done
  UP_PROJECT="${UP_PROJECT:-$PWD}"
  if [ ! -d "$UP_PROJECT/.pi-supervisor" ]; then
    saye "${C_R}✗${C_N} no .pi-supervisor in $UP_PROJECT — nothing to unprotect"; exit 1
  fi
  if protect_unprotect "$UP_PROJECT"; then
    saye "${C_G}✓${C_N} kernel protection removed for $UP_PROJECT"
  else
    saye "${C_R}✗${C_N} unprotect failed — inspect the output above"; exit 1
  fi
  exit 0
fi

# ------------------------------------------------------------- --harvest
if [ "${1:-}" = "--harvest" ]; then
  SRC="${2:-}"; DEST="${3:-}"
  if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
    saye "usage: ralph.sh --harvest <run-dir> [dest-dir]"
    exit 1
  fi
  TARGET="$SRC"
  if [ -n "$DEST" ]; then
    if [ -e "$DEST" ]; then saye "${C_R}✗${C_N} dest $DEST exists — refusing to overwrite"; exit 1; fi
    mkdir -p "$(dirname "$DEST")"
    cp -a "$SRC" "$DEST"
    saye "${C_D}·${C_N} copied $SRC → $DEST"
    TARGET="$DEST"
  fi
  node "$HERE/lib/harvest.mjs" "$TARGET" 0 0
  exit $?
fi

# ---------------------------------------------------------------- stop
if [ "${1:-}" = "stop" ]; then
  shift
  STOP_ARGS=(); STOP_TARGET=""; STOP_ALL=0; STOP_RC=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --all)   STOP_ALL=1 ;;
      --force) STOP_ARGS+=(--force) ;;
      -*)      saye "${C_R}✗${C_N} stop: unknown flag: $1"; exit 2 ;;
      *)       if [ -n "$STOP_TARGET" ]; then saye "${C_R}✗${C_N} stop: one run dir at a time (or --all)"; exit 2; fi
               STOP_TARGET=$1 ;;
    esac
    shift
  done
  STOP_ROOT="${RUNS_DIR:-$PWD/.pi-supervisor/runs}"
  STOP_PTR="$PWD/.pi-supervisor/ralph-run-dir"

  stop_one() { # $1=run-dir
    local d="$1" rc=0
    if [ ! -f "$d/pi-child-status.json" ]; then
      saye "${C_D}·${C_N} no status file in $d — nothing to stop"
      return 0
    fi
    saye "${C_D}·${C_N} stopping $d"
    stop_and_report "$d" "${STOP_ARGS[@]}" || rc=$?
    node "$HERE/lib/harvest.mjs" "$d" 0 "$rc" 2>/dev/null || true
    saye "${C_G}✓${C_N} preserved — report: $d/RUN-REPORT.md"
    return $rc
  }

  if [ "$STOP_ALL" -eq 1 ]; then
    if [ ! -d "$STOP_ROOT" ]; then
      saye "${C_Y}!${C_N} stop --all: no run dirs ($STOP_ROOT missing)"
    else
      found=0
      for d in "$STOP_ROOT"/*/; do
        [ -d "$d" ] || continue
        found=1
        stop_one "${d%/}" || STOP_RC=1
      done
      [ "$found" -eq 1 ] || saye "${C_Y}!${C_N} stop --all: no run dirs in $STOP_ROOT"
    fi
  elif [ -n "$STOP_TARGET" ]; then
    stop_one "$STOP_TARGET" || STOP_RC=1
  else
    cand=""
    if [ -f "$STOP_PTR" ]; then cand="$(cat "$STOP_PTR" 2>/dev/null || true)"; fi
    if [ -n "$cand" ] && [ -f "$cand/pi-child-status.json" ]; then
      stop_one "$cand" || STOP_RC=1
    elif [ -d "$STOP_ROOT" ]; then
      newest="$(for d in "$STOP_ROOT"/*/; do [ -f "$d/pi-child-status.json" ] && printf '%s\n' "${d%/}"; done | xargs -r ls -1t 2>/dev/null | head -1)"
      if [ -n "$newest" ]; then
        saye "${C_Y}!${C_N} stop: no pointer — using newest run with a status file: $newest"
        stop_one "$newest" || STOP_RC=1
      else
        saye "${C_Y}!${C_N} stop: no run with a status file found (looked in $STOP_ROOT)"
      fi
    else
      saye "${C_Y}!${C_N} stop: no runs found (no pointer, $STOP_ROOT missing)"
    fi
  fi
  exit $STOP_RC
fi

# -------------------------------------------------- attach mode (power-user)
ATTACHED=0
if [ $# -ge 1 ]; then
  ATTACHED=1
  RUN_DIR=$1; shift
  PROJECT_DIR="${PROJECT_DIR:-$PWD}"   # follow-the-slot: the monitor needs the project (active.json lives there)
  # display: adopt the run's own deadline from its status file if the user gave
  # neither --deadline nor --runtime (so the banner shows it AND the monitor is
  # told the run's real deadline). DEADLINE_EPOCH can't be the test — it is
  # ALWAYS set by then (defaulted to now+MAX_HOURS), which made this check
  # dead code; v0.25.0 tests the real thing.
  if [ "$DEADLINE_USER_SET" -eq 0 ] && [ -f "$RUN_DIR/pi-child-status.json" ]; then
    DEADLINE_EPOCH="$(node -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));if(j.deadlineIso)process.stdout.write(String(Math.floor(new Date(j.deadlineIso).getTime()/1000)))}catch{}" "$RUN_DIR/pi-child-status.json" 2>/dev/null || true)"
  fi
  if [ -n "${PROJECT_DIR:-}" ]; then ralph_flags+=(--project-dir "$PROJECT_DIR"); fi
  if [ -n "$DEADLINE_EPOCH" ]; then ralph_flags+=(--deadline "$DEADLINE_EPOCH"); fi
  EXTRA=("$@")
  if [ -n "$PI_PROTECT_USER" ]; then
    # A power-user attach may point at a run that lives OUTSIDE the project's
    # run tree (any dir the user names) — there is nothing to protect there and
    # the parent sessions stay the owner. Mandatory once the tree exists.
    if [ -d "$PROJECT_DIR/.pi-supervisor" ]; then
      protect_apply "$PROJECT_DIR" "$RUN_DIR" || { saye "${C_R}✗${C_N} kernel protection failed — cannot attach to a protected run"; exit 1; }
      ralph_flags+=(--pi "$HERE/lib/pi-as-child.sh")
      export PI_SUP_PI_ABS_FILE="$PROJECT_DIR/.pi-supervisor/pi-abs"
    else
      saye "${C_D}·${C_N} kernel protection skipped — no run tree at $PROJECT_DIR/.pi-supervisor (the run lives outside the tree)"
    fi
  fi
  RALPH_MODE=attach   # the banner prints before the monitor starts
  MONITOR_ARGS=(--run-dir "$RUN_DIR" "${ralph_flags[@]}" "${EXTRA[@]}")
  if [ -f "$PROJECT_DIR/.pi-supervisor/active.json" ] || [ -f "$PROJECT_DIR/.pi-supervisor/runs/node.json" ]; then
    SUBRUNS_ATTACH_TREE=1   # v0.26.0: sub-runs project → the tree banner is the view
  fi
fi

# ------------------------------------------------------------- zero-arg mode
if [ "$ATTACHED" -eq 0 ]; then
  # v0.26.0 gate — pure caller identity: this process was launched by
  # launch.mjs inside a supervised window (PI_SUP_CHILD set in its env), so it
  # is a CHILD session, and child sessions never launch ("agents propose,
  # supervisor disposes"): the only project-mutating API is `ralph.sh spawn`
  # (request file — it launches nothing). Monitor scripts and users are never
  # marked, so they are never blocked (warnings only, per the gate contract).
  if [ -n "${PI_SUP_CHILD:-}" ]; then
    saye "${C_R}✗${C_N} denied: direct launches by child sessions are unauthorized — spawn a sub-run with 'ralph.sh spawn --name <node> --task <file>' (it never launches; the chain step does, when your window ends), then end your turn."
    exit 1
  fi
  TASK_FILE="${TASK_FILE:-TASK.md}"
  if [ ! -f "$TASK_FILE" ]; then
    saye "${C_R}✗${C_N} no $TASK_FILE in $(pwd)"
    sayc "${C_D}zero-arg mode: write the task in ./$TASK_FILE, then run ralph.sh (or set TASK_FILE=<name> to point elsewhere).${C_N}"
    sayc "${C_D}to attach to an existing run instead: ralph.sh <run-dir> [ralph args...]${C_N}"
    exit 1
  fi

  PROJECT_DIR=$PWD
  RUNROOT="${RUNS_DIR:-$PROJECT_DIR/.pi-supervisor/runs}"
  PTR="$PROJECT_DIR/.pi-supervisor/ralph-run-dir"

  # v0.26.0 (plan §5.5): the sub-runs active slot. active.json is written by
  # launch.mjs at window start and cleared by the chain step at window end, so
  # it either names a LIVE window (attach to it — follow-the-slot) or a window
  # that ended WITHOUT its chain step (reboot/crash mid-finalize — repair: run
  # the missing step() once, then follow its result).
  RUN_DIR=""
  AJ_REPAIRED=0; AJ_OUTCOME=""
  ACTIVE_JSON="$PROJECT_DIR/.pi-supervisor/active.json"
  if [ -f "$ACTIVE_JSON" ]; then
    aj_dir="$(status_field "$ACTIVE_JSON" run_dir)"
    aj_pid="$(status_field "$ACTIVE_JSON" guard_pid)"
    if [ -n "$aj_dir" ] && [ -d "$aj_dir" ] && [ -n "$aj_pid" ] && kill -0 "$aj_pid" 2>/dev/null; then
      RUN_DIR="$aj_dir"
    elif [ -n "$aj_dir" ] && [ -d "$aj_dir" ] && [ -f "$aj_dir/pi-child-status.json" ] && [ ! -f "$aj_dir/chain-done.json" ]; then
      saye "${C_Y}!${C_N} $(basename "$aj_dir") ended without its chain step (reboot/crash?) — running the missing step"
      AJ_REPAIRED=1
      node --input-type=module -e 'const { step } = await import(process.argv[1]); await step(process.argv[2], process.argv[3]);' "file://$HERE/lib/chain.mjs" "$PROJECT_DIR" "$aj_dir" \
        || saye "${C_Y}!${C_N} repair step failed — the window is preserved; re-run to retry"
      if [ -f "$aj_dir/chain-done.json" ]; then
        AJ_OUTCOME="$(status_field "$aj_dir/chain-done.json" next 2>/dev/null || true)"
      fi
      aj_dir2="$(status_field "$ACTIVE_JSON" run_dir 2>/dev/null || true)"
      aj_pid2="$(status_field "$ACTIVE_JSON" guard_pid 2>/dev/null || true)"
      if [ -n "$aj_dir2" ] && [ -d "$aj_dir2" ] && [ -n "$aj_pid2" ] && kill -0 "$aj_pid2" 2>/dev/null; then
        RUN_DIR="$aj_dir2"
      fi
    fi
  fi

  if [ -f "$PTR" ]; then
    cand="$(cat "$PTR" 2>/dev/null || true)"
    if [ -n "$cand" ] && [ -f "$cand/pi-child-status.json" ] && guard_alive "$cand"; then
      RUN_DIR=$cand   # live run → attach below
    elif [ -n "$cand" ] && [ -d "$cand" ] && [ ! -f "$cand/run-summary.json" ]; then
      # dead run without a summary — reboot or crash mid-run: post-mortem it
      # now so it becomes permanent evidence, then start a fresh run below
      saye "${C_Y}!${C_N} previous run $cand is dead (reboot/crash?) — harvesting post-mortem"
      harvest "$cand" 1 0
    fi
  fi

  if [ -z "$RUN_DIR" ]; then
    if [ "$AJ_REPAIRED" -eq 1 ]; then
      node "$HERE/lib/node.mjs" tree "$PROJECT_DIR"
      case "$AJ_OUTCOME" in
        idle) saye "${C_G}✓${C_N} the chain finished — root node done (windows under .pi-supervisor/runs/)"; exit 0 ;;
        *)    saye "${C_R}✗${C_N} the chain is not running — last step: ${AJ_OUTCOME:-no outcome recorded} (inspect .pi-supervisor/runs/)"; exit 1 ;;
      esac
    fi
    mkdir -p "$RUNROOT"
    n=0
    for d in "$RUNROOT"/run*; do
      [ -d "$d" ] || continue
      b="$(basename "$d")"
      case "$b" in
        run[0-9]*)
          num="${b#run}"
          if [ "$num" -gt "$n" ] 2>/dev/null; then n="$num"; fi
          ;;
      esac
    done
    n=$((n + 1))
    RUN_DIR="$RUNROOT/run$n"
    mkdir -p "$RUN_DIR"

    # v0.25.16: the task file is the run's input artifact — copy it into the
    # run dir so the evidence folder is self-contained. The project's TASK.md
    # may be edited or lost after the run, and the transcript's task message
    # carries the preamble + cycle notes, not the clean original text.
    if cp -p "$TASK_FILE" "$RUN_DIR/$(basename "$TASK_FILE")" 2>/dev/null; then
      rlog "task file copied: $(basename "$TASK_FILE") → $RUN_DIR/$(basename "$TASK_FILE")"
    else
      rlog "WARNING: task file copy FAILED — $(basename "$TASK_FILE") is not in $RUN_DIR (the run continues from the original)"
      saye "${C_Y}!${C_N} could not copy $(basename "$TASK_FILE") into $RUN_DIR — the run continues from the original"
    fi

    launch_args=(--task-file "$TASK_FILE" --out-dir "$RUN_DIR"
                 --project "$PROJECT_DIR" --node "(root)"
                 --deadline "$DEADLINE_EPOCH"
                 --preamble "${PREAMBLE:-standard}"
                 --idle-timeout "${IDLE_TIMEOUT:-300}"
                 --turn-stall "${TURN_STALL_SEC:-900}"
                 --finalize "${FINALIZE:-10}")
    if [ -n "$CHILD_MODEL_VAL" ];    then launch_args+=(--model "$CHILD_MODEL_VAL"); fi
    if [ -n "$CHILD_PROVIDER_VAL" ]; then launch_args+=(--provider "$CHILD_PROVIDER_VAL"); fi
    if [ -n "${CHILD_THINKING:-}" ]; then launch_args+=(--thinking "$CHILD_THINKING"); fi

    # kernel protection — the boundary must exist BEFORE the child starts
    # (the wrapper verifies the child actually runs as the protected user; a
    # protected launch without the boundary would fail at spawn). Mandatory by
    # default: refuse early with a clear message instead.
    if [ -n "$PI_PROTECT_USER" ]; then
      if ! protect_apply "$PROJECT_DIR" "$RUN_DIR"; then
        saye "${C_R}✗${C_N} cannot start a protected run — fix the message above, or opt out with PI_SUP_NO_PROTECT=1"
        exit 1
      fi
      ralph_flags+=(--pi "$HERE/lib/pi-as-child.sh")
      export PI_SUP_PI_ABS_FILE="$PROJECT_DIR/.pi-supervisor/pi-abs"
    fi
    RALPH_MODE=launch
    banner launch
    launch_out=$(node "$HERE/launch.mjs" "${launch_args[@]}" 2>&1) || true
    case "$launch_out" in
      *'"launched":true'*)
        guard_pid=$(status_field "$RUN_DIR/pi-child-status.json" guardPid)
        saye "${C_D}·${C_N} child launched (guardPid=$guard_pid)" ;;
      *'"launched":"unknown"'*)
        saye "${C_Y}!${C_N} launch.mjs reported 'unknown' (alive but silent) — proceeding, the pre-checks will catch a dead child" ;;
      *)
        saye "${C_R}✗${C_N} launch failed — output from launch.mjs:"
        echo "$launch_out" | tail -20 >&2
        exit 1 ;;
    esac

    # v0.26.0 (plan §5.5): the tree is the view — show it at launch too (the
    # root node was just materialized by launch.mjs via --node; active.json
    # names the window, so this is also the follow-the-slot entry point).
    if [ -f "$PROJECT_DIR/.pi-supervisor/active.json" ]; then
      node "$HERE/lib/node.mjs" tree "$PROJECT_DIR"
    fi

    mkdir -p "$PROJECT_DIR/.pi-supervisor"
    echo "$RUN_DIR" > "$PTR"
    # keep run artifacts out of git's way (idempotent — the line is added once)
    if [ -d "$PROJECT_DIR/.git" ] && ! grep -qxF '.pi-supervisor/' "$PROJECT_DIR/.gitignore" 2>/dev/null; then
      { printf '\n# pi-supervisor run artifacts\n.pi-supervisor/\n' >> "$PROJECT_DIR/.gitignore"; } 2>/dev/null \
        && saye "${C_D}·${C_N} added .pi-supervisor/ to .gitignore" || true
    fi
  else
    # attach to a live run: honor the run's own deadline unless the user overrode it
    if [ "$DEADLINE_USER_SET" -eq 0 ]; then
      iso=$(status_field "$RUN_DIR/pi-child-status.json" deadlineIso)
      [ -n "$iso" ] && DEADLINE_EPOCH="$iso"
    fi
    RALPH_MODE=attach
    if [ -f "$PROJECT_DIR/.pi-supervisor/active.json" ] || [ -f "$PROJECT_DIR/.pi-supervisor/runs/node.json" ]; then
      SUBRUNS_ATTACH_TREE=1   # v0.26.0: sub-runs project → the tree banner is the view
    fi
    if [ -n "$PI_PROTECT_USER" ]; then
      ralph_flags+=(--pi "$HERE/lib/pi-as-child.sh")
      export PI_SUP_PI_ABS_FILE="$PROJECT_DIR/.pi-supervisor/pi-abs"
      protect_apply "$PROJECT_DIR" "$RUN_DIR" || { saye "${C_R}✗${C_N} kernel protection failed — cannot attach to a protected run"; exit 1; }
    fi
  fi

  MONITOR_ARGS=(--run-dir "$RUN_DIR" --project-dir "$PROJECT_DIR" --deadline "$DEADLINE_EPOCH" "${ralph_flags[@]}")
fi

# ------------------------------------- foreground monitor + harvest on exit
HARVEST_TARGET="$RUN_DIR"
# v0.25.15: ralph.log — the wrapper's own on-disk record (see rlog): the
# invocation, the config snapshot, the monitor pid, the wait bookends, the exit.
SCRIPT_SHA_AT_START="$(sha256sum "$HERE/ralph.sh" 2>/dev/null | cut -d' ' -f1 || true)"
rlog "ralph.sh start mode=${RALPH_MODE:-launch} pid=$$ ppid=$PPID bash=$BASH_VERSION run_dir=$RUN_DIR"
rlog "script sha256=${SCRIPT_SHA_AT_START:-?} mtime=$(stat -c %Y "$HERE/ralph.sh" 2>/dev/null || echo ?)"
rlog "config child_model=${CHILD_MODEL_VAL:-pi-default} child_thinking=${CHILD_THINKING:--} parent_model=${PARENT_MODEL_VAL:-pi-default} deadline_epoch=${DEADLINE_EPOCH:-?} cycle_sec=${CYCLE_SEC:-1200}"
rlog "monitor command: node $HERE/ralph-monitor.mjs ${MONITOR_ARGS[*]}"
# v0.25.14: bash's `wait $MON_PID` can LOSE the monitor's exit status — rc 127
# means "pid not a child of this shell", which can happen even when the monitor
# exited cleanly (observed 2026-11-02: a completed run printed `✗ done · exit
# 127`). The monitor records its own code in monitor-exit.json before it dies;
# trust it when the wait's status was lost. Only rc 127 is resolved — a real 0/4/
# 130/143 from wait is never touched, and a 127 with no file (e.g. `node` not
# found) stays 127: that one is a real failure.
resolve_monitor_rc() {
  [ "$rc" -eq 127 ] && [ -n "$HARVEST_TARGET" ] && [ -f "$HARVEST_TARGET/monitor-exit.json" ] || return 0
  local mon_rc
  mon_rc=$(sed -n 's/.*"code"[[:space:]]*:[[:space:]]*\(-\{0,1\}[0-9]\{1,\}\).*/\1/p' "$HARVEST_TARGET/monitor-exit.json" | head -n1)
  case "$mon_rc" in ''|*[!0-9-]*) : ;; *) rc=$mon_rc ;; esac
  rlog "rc resolution: wait reported 127 (status lost) — monitor-exit.json code=${mon_rc:-?} → rc=$rc"
}
on_exit() {
  local rc=$?
  local interrupted=0
  if [ "$rc" -eq 130 ] || [ "$rc" -eq 143 ]; then interrupted=1; fi
  resolve_monitor_rc
  if [ -n "$HARVEST_TARGET" ] && [ -d "$HARVEST_TARGET" ]; then
    # v0.25.15: was the script edited on disk mid-run? (2026-11-02 run: the
    # skills repo was committed at 22:09Z INSIDE a 3h run — forensics had to
    # prove by hand that the tail region was byte-identical.)
    local sha_now
    sha_now="$(sha256sum "$HERE/ralph.sh" 2>/dev/null | cut -d' ' -f1 || true)"
    if [ -n "${SCRIPT_SHA_AT_START:-}" ] && [ -n "$sha_now" ] && [ "$sha_now" != "$SCRIPT_SHA_AT_START" ]; then
      rlog "WARNING: ralph.sh changed on disk mid-run (sha ${SCRIPT_SHA_AT_START:0:12}… → ${sha_now:0:12}…)"
    fi
    rlog "exit rc=$rc interrupted=$interrupted"
    harvest "$HARVEST_TARGET" "$interrupted" "$rc"
    if [ "$rc" -eq 0 ]; then saye "${C_G}✓ done · exit 0${C_N} · report: $HARVEST_TARGET/RUN-REPORT.md"
    else saye "${C_R}✗ done · exit $rc${C_N} · report: $HARVEST_TARGET/RUN-REPORT.md"; fi
    rlog "final: $(if [ "$rc" -eq 0 ]; then printf '✓ done · exit 0'; else printf '✗ done · exit %s' "$rc"; fi) · report: $HARVEST_TARGET/RUN-REPORT.md"
  fi
}
trap on_exit EXIT
# v0.25.10: Ctrl+C / SIGTERM stop the WHOLE run — the monitor (kill below),
# then the detached guard + child (stop.mjs — the same graceful SIGTERM →
# SIGKILL group kill `ralph.sh stop` uses), then the EXIT harvest. Before
# v0.25.10 only the monitor died and the child kept running.
MON_PID=""
stop_for_signal() { # $1 = exit code (130 INT / 143 TERM)
  trap '' INT TERM                        # a second Ctrl+C during the stop: ignored
  if [ -n "$MON_PID" ]; then
    kill -TERM "$MON_PID" 2>/dev/null || true
    wait "$MON_PID" 2>/dev/null || true   # reap it
  fi
  if [ -n "${RUN_DIR:-}" ] && [ -f "$RUN_DIR/pi-child-status.json" ]; then
    saye "${C_Y}!${C_N} stopping the run — guard + child (graceful, escalating to SIGKILL)"
    stop_and_report "$RUN_DIR" || true
  fi
  exit "$1"
}
trap 'stop_for_signal 130' INT
trap 'stop_for_signal 143' TERM

# launch mode printed its banner at launch; attach mode prints it here
if [ "${RALPH_MODE:-launch}" = "attach" ]; then
  [ -n "$DEADLINE_EPOCH" ] || DEADLINE_EPOCH=$(status_field "$RUN_DIR/pi-child-status.json" deadlineIso 2>/dev/null)
  banner attach
  if [ "${SUBRUNS_ATTACH_TREE:-0}" = "1" ]; then
    echo
    node "$HERE/lib/node.mjs" tree "$PROJECT_DIR"
    echo
  fi
fi
rc=0
# the monitor runs in the background and ralph.sh waits on it: a trapped
# Ctrl+C interrupts the wait (a trapped signal makes `wait` return 128+sig),
# so stop_for_signal fires even if the monitor itself is busy — and the
# handler can kill the monitor by PID. (A plain foreground `node` would defer
# the trap until the monitor exited on its own.)
node "$HERE/ralph-monitor.mjs" "${MONITOR_ARGS[@]}" &
MON_PID=$!
rlog "monitor launched (mon_pid=$MON_PID)"
# v0.25.15: bookend the wait and stop swallowing the BUILTIN's stderr — a lost
# status prints `wait: pid N is not a child of this shell` straight into
# ralph.log (that one line is the whole diagnosis of a 127). The monitor's own
# stderr is unaffected: the redirect belongs to the wait builtin, not the child.
wait_start=$(date +%s)
wait "$MON_PID" 2>>"$RUN_DIR/ralph.log" || rc=$?
rlog "monitor wait rc=$rc (mon_pid=$MON_PID, waited $(( $(date +%s) - wait_start ))s)"
# the parent's final report (v0.20.0 — written by the monitor on completion or
# parent-stop; absent otherwise, e.g. Ctrl+C — the child is stopped before the
# parent can summarize)
if [ -f "$RUN_DIR/FINAL-REPORT.md" ]; then
  printf '%s┌ final report (parent)%s %s\n' "$C_B" "$C_N" "$(rule)" >&2
  while IFS= read -r line; do printf '│ %s\n' "$line" >&2; done < "$RUN_DIR/FINAL-REPORT.md"
  printf '└%s\n' "$(rule)" >&2
fi
exit $rc
