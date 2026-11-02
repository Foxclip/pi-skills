#!/usr/bin/env bash
# ralph.sh — v0.25.5: run a supervised child with zero arguments.
#
# ZERO-ARG MODE (the point of this script):
#   1. put a TASK.md in the current directory (your project)
#   2. ./ralph.sh
#   that's it — the script finds TASK.md, allocates a run dir IN THE PROJECT
#   (<project>/.pi-supervisor/runs/run-N — permanent: nothing lives in /tmp,
#   a reboot mid-run leaves every artifact on disk), launches the guarded
#   child via launch.mjs, then runs the ralph monitor loop IN THE FOREGROUND.
#
#   Your terminal is the view: every ralph cycle is printed as it happens,
#   and Ctrl+C stops the MONITOR cleanly (the child keeps running — it is
#   detached; stop it with stop.mjs if you really want it gone).
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
human_secs() { local s=${1:-0}; case "$s" in ''|*[!0-9]*) echo "${s}s"; return;; esac
  if [ "$s" -ge 3600 ] && [ $((s % 3600)) -eq 0 ]; then echo "$((s / 3600))h";
  elif [ "$s" -ge 60 ] && [ $((s % 60)) -eq 0 ]; then echo "$((s / 60))m";
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
  if [ "$1" = attach ]; then
    mon="monitoring attached run — cycle every $(human_secs "${CYCLE_SEC:-1200}") · Ctrl+C stops the monitor only (child keeps running)"
  else
    mon="monitoring — cycle every $(human_secs "${CYCLE_SEC:-1200}") · Ctrl+C stops the monitor only (child keeps running)"
  fi
  printf '%s┌ ralph%s %s\n' "$C_B" "$C_N" "$(rule)"
  printf '│ project   %s\n' "$( [ -n "$pd" ] && basename "$pd" || echo unknown )"
  printf '│ run       %s\n' "$runrel"
  printf '│ deadline  %s\n' "$(human_dl "${DEADLINE_EPOCH:-}")"
  printf '│ models    child=%s · parent=%s\n' "${CHILD_MODEL_VAL:-pi-default}" "${PARENT_MODEL_VAL:-pi-default}"
  printf '│ %s\n' "$mon"
  printf '└%s\n' "$(rule)"
  } >&2; }

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
    --parent-model)    [ $# -ge 2 ] || { saye "${C_R}✗${C_N} --parent-model needs a value"; exit 2; }; PARENT_MODEL=$2; shift 2 ;;
    --parent-model=*)  PARENT_MODEL=${1#*=}; shift ;;
    -h|--help)
      cat <<'USAGE'
ralph.sh — supervised pi child (ralph loop). Zero-arg pipeline:
  ralph.sh                     find ./TASK.md → launch guarded child → monitor in foreground
  ralph.sh <run-dir> [flags]   attach to an existing run (power-user)
  ralph.sh stop [--all | <run-dir>] [--force]   stop a run's processes + harvest it
  ralph.sh --harvest <run-dir> [dest-dir]       harvest (re-runnable)
  ralph.sh -h | --help         this help
normal-mode flags (anywhere in the arg list): --deadline <ISO|HH:MM|epoch>
  --runtime <duration>    relative deadline: 90 = 90min, or 45s/90m/2h/1h30m
  --child-model <spec>  --parent-model <spec>    (--flag value and --flag=value)
environment: PI TASK_FILE RUNS_DIR DEADLINE RUNTIME MAX_HOURS MODEL PROVIDER
  CHILD_MODEL CHILD_PROVIDER PARENT_MODEL PARENT_PROVIDER PREAMBLE IDLE_TIMEOUT TURN_STALL_SEC FINALIZE
  CYCLE_SEC TIMEOUT_SEC MAX_INTERVENTIONS STUCK_SEC STALE_SEC LLM_FAIL_MAX
  PROMPT_FILE SESSION LOG_FILE
See the header comment in ralph.sh for the full contract.
USAGE
      exit 0 ;;
    *) _cli_pos+=("$1"); shift ;;
  esac
done
if [ ${#_cli_pos[@]} -gt 0 ]; then set -- "${_cli_pos[@]}"; else set --; fi

dur_sec() { # $1: 90 | 45s | 90m | 2h | 1d | 1h30m → seconds (a bare number = minutes)
  local s="$1" total
  if [[ "$s" =~ ^[0-9]+$ ]]; then [ "$s" -gt 0 ] || return 1; echo $(( s * 60 )); return 0; fi
  [[ "$s" =~ ^([0-9]+d)?([0-9]+h)?([0-9]+m)?([0-9]+s)?$ ]] || return 1
  local d="${BASH_REMATCH[1]%%d*}" h="${BASH_REMATCH[2]%%h*}" m="${BASH_REMATCH[3]%%m*}" sec="${BASH_REMATCH[4]%%s*}"
  total=$(( ${d:-0} * 86400 + ${h:-0} * 3600 + ${m:-0} * 60 + ${sec:-0} ))
  [ "$total" -gt 0 ] || return 1
  echo "$total"
}
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
    node "$HERE/stop.mjs" --out-dir "$d" "${STOP_ARGS[@]}" || rc=$?
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
  RALPH_MODE=attach   # the banner prints before the monitor starts
  MONITOR_ARGS=(--run-dir "$RUN_DIR" "${ralph_flags[@]}" "${EXTRA[@]}")
fi

# ------------------------------------------------------------- zero-arg mode
if [ "$ATTACHED" -eq 0 ]; then
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

  RUN_DIR=""
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

    launch_args=(--task-file "$TASK_FILE" --out-dir "$RUN_DIR"
                 --deadline "$DEADLINE_EPOCH"
                 --preamble "${PREAMBLE:-standard}"
                 --idle-timeout "${IDLE_TIMEOUT:-300}"
                 --turn-stall "${TURN_STALL_SEC:-900}"
                 --finalize "${FINALIZE:-10}")
    if [ -n "$CHILD_MODEL_VAL" ];    then launch_args+=(--model "$CHILD_MODEL_VAL"); fi
    if [ -n "$CHILD_PROVIDER_VAL" ]; then launch_args+=(--provider "$CHILD_PROVIDER_VAL"); fi

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
  fi

  MONITOR_ARGS=(--run-dir "$RUN_DIR" --project-dir "$PROJECT_DIR" --deadline "$DEADLINE_EPOCH" "${ralph_flags[@]}")
fi

# ------------------------------------- foreground monitor + harvest on exit
HARVEST_TARGET="$RUN_DIR"
on_exit() {
  local rc=$?
  local interrupted=0
  if [ "$rc" -eq 130 ] || [ "$rc" -eq 143 ]; then interrupted=1; fi
  if [ -n "$HARVEST_TARGET" ] && [ -d "$HARVEST_TARGET" ]; then
    harvest "$HARVEST_TARGET" "$interrupted" "$rc"
    if [ "$rc" -eq 0 ]; then saye "${C_G}✓ done · exit 0${C_N} · report: $HARVEST_TARGET/RUN-REPORT.md"
    else saye "${C_R}✗ done · exit $rc${C_N} · report: $HARVEST_TARGET/RUN-REPORT.md"; fi
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# launch mode printed its banner at launch; attach mode prints it here
if [ "${RALPH_MODE:-launch}" = "attach" ]; then
  [ -n "$DEADLINE_EPOCH" ] || DEADLINE_EPOCH=$(status_field "$RUN_DIR/pi-child-status.json" deadlineIso 2>/dev/null)
  banner attach
fi
rc=0
node "$HERE/ralph-monitor.mjs" "${MONITOR_ARGS[@]}" || rc=$?
# the parent's final report (v0.20.0 — written by the monitor on completion or
# parent-stop; absent otherwise, e.g. Ctrl+C with a still-live child)
if [ -f "$RUN_DIR/FINAL-REPORT.md" ]; then
  printf '%s┌ final report (parent)%s %s\n' "$C_B" "$C_N" "$(rule)" >&2
  while IFS= read -r line; do printf '│ %s\n' "$line" >&2; done < "$RUN_DIR/FINAL-REPORT.md"
  printf '└%s\n' "$(rule)" >&2
fi
exit $rc
