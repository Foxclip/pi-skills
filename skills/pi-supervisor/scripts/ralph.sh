#!/usr/bin/env bash
# ralph.sh — v0.18.4: run a supervised child with zero arguments.
#
# ZERO-ARG MODE (the point of this script):
#   1. put a TASK.md in the current directory (your project)
#   2. ./ralph.sh
#   that's it — the script finds TASK.md, allocates a run dir
#   (/tmp/ralph-<project>/run-N), launches the guarded child via launch.mjs,
#   then execs the ralph monitor loop IN THE FOREGROUND.
#
#   Your terminal is the view: every ralph cycle is printed as it happens,
#   and Ctrl+C stops the MONITOR cleanly (the child keeps running — it is
#   detached; stop it with stop.mjs if you really want it gone).
#
#   One-time setup (pick ONE, then plain `ralph.sh` works from any project):
#     A) PATH (recommended — zero per-project files):
#        echo 'export PATH="$HOME/.pi/agent/git/github.com/Foxclip/pi-skills/skills/pi-supervisor/scripts:$PATH"' >> ~/.bashrc
#     B) per-project symlink (visible in the repo):
#        ln -s ~/.pi/agent/git/github.com/Foxclip/pi-skills/skills/pi-supervisor/scripts/ralph.sh ralph.sh
#
# ENVIRONMENT (all optional; CLI flags in power-user mode override these):
#   TASK_FILE      task file in cwd           (default: TASK.md)
#   PI             pi executable             (default: pi)
#   MODEL/PROVIDER   for BOTH child and parent (default: pi's default model —
#                the safe shared config on shared local model servers)
#   CHILD_MODEL/CHILD_PROVIDER    override the CHILD's model only
#   PARENT_MODEL/PARENT_PROVIDER  override the PARENT's (ralph's) model only
#                (e.g. child on a big local model, parent on a fast/cloud one)
#   DEADLINE       ISO | "HH:MM" | epoch     (default: now + MAX_HOURS)
#   MAX_HOURS      deadline horizon          (default: 12)
#   PREAMBLE       child preamble text       (default: standard)
#   IDLE_TIMEOUT   guard idle timeout, sec   (default: 300)
#   CYCLE_SEC (1200)  TIMEOUT_SEC (600)  MAX_INTERVENTIONS (3)
#   STUCK_SEC (3600)  STALE_SEC (180)  LLM_FAIL_MAX (6)
#   PROMPT_FILE  PROJECT_DIR  SESSION  LOG_FILE   (ralph-monitor passthrough)
#
# POWER-USER MODE (attach to an existing run dir; same as v0.18.1):
#   ./ralph.sh <run-dir> [ralph-monitor.mjs args...]
#
set -euo pipefail

# resolve our own real location so HERE finds launch.mjs/ralph-monitor.mjs:
# - $0 (not BASH_SOURCE[0] — the latter expands unreliably in this box's bash)
# - readlink -f: the entry may be a symlink (per-project ralph.sh or a PATH dir
#   that is itself a link) — we want the scripts dir, not the project
HERE="$(cd "$(dirname "$(readlink -f "${0}")")" && pwd)"
PI_BIN="${PI:-pi}"

DEADLINE_RAW="${DEADLINE:-}"
if [ -n "$DEADLINE_RAW" ]; then
  DEADLINE_EPOCH="$DEADLINE_RAW"   # ISO | "HH:MM" | epoch — launch.mjs and ralph-monitor both accept all three
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
if [ -n "${MAX_INTERVENTIONS:-}" ]; then ralph_flags+=(--max-interventions "$MAX_INTERVENTIONS"); fi
if [ -n "${STUCK_SEC:-}" ];         then ralph_flags+=(--stuck-sec "$STUCK_SEC"); fi
if [ -n "${STALE_SEC:-}" ];         then ralph_flags+=(--stale-sec "$STALE_SEC"); fi
if [ -n "${LLM_FAIL_MAX:-}" ];      then ralph_flags+=(--llm-fail-max "$LLM_FAIL_MAX"); fi
if [ -n "${PROMPT_FILE:-}" ];       then ralph_flags+=(--prompt-file "$PROMPT_FILE"); fi
if [ -n "${SESSION:-}" ];           then ralph_flags+=(--session "$SESSION"); fi
if [ -n "${LOG_FILE:-}" ];          then ralph_flags+=(--log-file "$LOG_FILE"); fi

# ---------------------------------------------------------------- power-user
if [ $# -ge 1 ]; then
  RUN_DIR=$1; shift
  if [ -n "${PROJECT_DIR:-}" ]; then ralph_flags+=(--project-dir "$PROJECT_DIR"); fi
  if [ -n "$DEADLINE_EPOCH" ];  then ralph_flags+=(--deadline "$DEADLINE_EPOCH"); fi
  echo "ralph-monitor: run-dir=$RUN_DIR (attaching to existing run)" >&2
  exec node "$HERE/ralph-monitor.mjs" --run-dir "$RUN_DIR" "${ralph_flags[@]}" "$@"
fi

# ------------------------------------------------------------- zero-arg mode
TASK_FILE="${TASK_FILE:-TASK.md}"
if [ ! -f "$TASK_FILE" ]; then
  cat >&2 <<EOF
ralph: no $TASK_FILE in $(pwd)

Zero-arg mode: write the task in ./$TASK_FILE, then run ./ralph.sh
(or set TASK_FILE=<name> to point elsewhere).
To attach to an existing run instead:  ./ralph.sh <run-dir> [ralph args...]
EOF
  exit 1
fi

PROJECT_DIR=$PWD
PROJECT_NAME=$(basename "$PROJECT_DIR")
RUNROOT="/tmp/ralph-$PROJECT_NAME"
PTR="$PROJECT_DIR/.pi-supervisor/ralph-run-dir"

status_field() { # $1=file $2=key → prints value or empty
  node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=j[process.argv[2]];process.stdout.write(v===null||v===undefined?"":String(v))}catch{}' "$1" "$2" 2>/dev/null || true
}
guard_alive() { # $1=run-dir → 0 if the status file names a live guard pid
  local pid
  pid=$(status_field "$1/pi-child-status.json" guardPid)
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

RUN_DIR=""; ATTACH=0
if [ -f "$PTR" ]; then
  cand="$(cat "$PTR" 2>/dev/null || true)"
  if [ -n "$cand" ] && [ -f "$cand/pi-child-status.json" ] && guard_alive "$cand"; then
    RUN_DIR=$cand; ATTACH=1
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
               --idle-timeout "${IDLE_TIMEOUT:-300}")
  if [ -n "$CHILD_MODEL_VAL" ];    then launch_args+=(--model "$CHILD_MODEL_VAL"); fi
  if [ -n "$CHILD_PROVIDER_VAL" ]; then launch_args+=(--provider "$CHILD_PROVIDER_VAL"); fi

  echo "ralph: launching child (task=.$TASK_FILE, run-dir=$RUN_DIR, deadline=$DEADLINE_EPOCH, child-model=${CHILD_MODEL_VAL:-pi-default}, parent-model=${PARENT_MODEL_VAL:-pi-default})" >&2
  launch_out=$(node "$HERE/launch.mjs" "${launch_args[@]}" 2>&1) || true
  case "$launch_out" in
    *'"launched":true'*)
      guard_pid=$(status_field "$RUN_DIR/pi-child-status.json" guardPid)
      echo "ralph: child launched (guardPid=$guard_pid)" >&2 ;;
    *'"launched":"unknown"'*)
      echo "ralph: WARNING launch.mjs reported 'unknown' (alive but silent) — proceeding, the pre-checks will catch a dead child" >&2 ;;
    *)
      echo "ralph: LAUNCH FAILED — output from launch.mjs:" >&2
      echo "$launch_out" | tail -20 >&2
      exit 1 ;;
  esac

  mkdir -p "$PROJECT_DIR/.pi-supervisor"
  echo "$RUN_DIR" > "$PTR"
  if [ ! -d "$PROJECT_DIR/.git" ] || ! grep -qF '.pi-supervisor/' "$PROJECT_DIR/.gitignore" 2>/dev/null; then
    echo "ralph: tip — add .pi-supervisor/ to .gitignore" >&2
  fi
else
  # attach: honor the attached run's own deadline unless the user overrode it
  if [ -z "$DEADLINE_RAW" ]; then
    iso=$(status_field "$RUN_DIR/pi-child-status.json" deadlineIso)
    [ -n "$iso" ] && DEADLINE_EPOCH="$iso"
  fi
  echo "ralph: attaching to live run $RUN_DIR (no new child launched)" >&2
fi

echo "ralph: monitoring — cycles every ${CYCLE_SEC:-1200}s, Ctrl+C stops the MONITOR only (the child keeps running)" >&2
exec node "$HERE/ralph-monitor.mjs" --run-dir "$RUN_DIR" --project-dir "$PROJECT_DIR" --deadline "$DEADLINE_EPOCH" "${ralph_flags[@]}"
