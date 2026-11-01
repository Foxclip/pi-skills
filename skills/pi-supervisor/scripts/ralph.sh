#!/usr/bin/env bash
# ralph.sh — v0.19.4: run a supervised child with zero arguments.
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
#   MAX_HOURS      deadline horizon          (default: 12)
#   PREAMBLE       child preamble text       (default: standard)
#   IDLE_TIMEOUT   guard idle timeout, sec   (default: 300)
#   CYCLE_SEC (1200)  TIMEOUT_SEC (600)  MAX_INTERVENTIONS (3)
#   STUCK_SEC (3600)  STALE_SEC (180)  LLM_FAIL_MAX (6)
#   PROMPT_FILE  PROJECT_DIR  SESSION  LOG_FILE   (ralph-monitor passthrough)
#
# FLAGS (v0.19.3 — accepted anywhere in the argument list, in any mode;
# they map onto the env vars above, so FLAGS WIN OVER ENV):
#   --deadline <ISO|HH:MM|epoch>    = DEADLINE
#   --child-model <spec>            = CHILD_MODEL   (the child's model)
#   --parent-model <spec>           = PARENT_MODEL  (ralph's judgment model)
# Both `--flag value` and `--flag=value` forms work.
#
# EVERY message this wrapper prints is timestamped `[YYYY-MM-DDTHH:MM:SS.mmmZ]`
# (same format as ralph-monitor.log) — quoted output blocks (a launch failure,
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
#                                  dead child on its next pre-check (≤30s) and
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

# every wrapper message is timestamped like the monitor's log lines:
# [YYYY-MM-DDTHH:MM:SS.mmmZ]   (UTC, GNU date %3N)
ts()   { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }
say()  { printf '[%s] %s\n' "$(ts)" "$*"; }
saye() { printf '[%s] %s\n' "$(ts)" "$*" >&2; }

# ------------------------------------------------------------- CLI flags
# The three most-used knobs as flags, parseable BEFORE mode dispatch so they
# work in normal (zero-arg) mode: --deadline / --child-model / --parent-model.
# They set the same variables the rest of the script reads (DEADLINE,
# CHILD_MODEL, PARENT_MODEL) → flags win over env, by construction. Accepted
# anywhere in the arg list; positional args (run-dir, stop, --harvest, …) are
# preserved in order for mode dispatch below.
_cli_pos=()
while [ $# -gt 0 ]; do
  case "$1" in
    --deadline)        [ $# -ge 2 ] || { saye "ralph: --deadline needs a value"; exit 2; }; DEADLINE=$2; shift 2 ;;
    --deadline=*)      DEADLINE=${1#*=}; shift ;;
    --child-model)     [ $# -ge 2 ] || { saye "ralph: --child-model needs a value"; exit 2; }; CHILD_MODEL=$2; shift 2 ;;
    --child-model=*)   CHILD_MODEL=${1#*=}; shift ;;
    --parent-model)    [ $# -ge 2 ] || { saye "ralph: --parent-model needs a value"; exit 2; }; PARENT_MODEL=$2; shift 2 ;;
    --parent-model=*)  PARENT_MODEL=${1#*=}; shift ;;
    *) _cli_pos+=("$1"); shift ;;
  esac
done
if [ ${#_cli_pos[@]} -gt 0 ]; then set -- "${_cli_pos[@]}"; else set --; fi

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
    if [ -e "$DEST" ]; then saye "ralph: dest $DEST exists — refusing to overwrite"; exit 1; fi
    mkdir -p "$(dirname "$DEST")"
    cp -a "$SRC" "$DEST"
    saye "ralph: copied $SRC → $DEST"
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
      -*)      saye "ralph: stop: unknown flag: $1"; exit 2 ;;
      *)       if [ -n "$STOP_TARGET" ]; then saye "ralph: stop: one run dir at a time (or --all)"; exit 2; fi
               STOP_TARGET=$1 ;;
    esac
    shift
  done
  STOP_ROOT="${RUNS_DIR:-$PWD/.pi-supervisor/runs}"
  STOP_PTR="$PWD/.pi-supervisor/ralph-run-dir"

  stop_one() { # $1=run-dir
    local d="$1" rc=0
    if [ ! -f "$d/pi-child-status.json" ]; then
      saye "ralph: stop: no status file in $d — nothing to stop"
      return 0
    fi
    saye "ralph: stopping $d"
    node "$HERE/stop.mjs" --out-dir "$d" "${STOP_ARGS[@]}" || rc=$?
    node "$HERE/lib/harvest.mjs" "$d" 0 "$rc" 2>/dev/null || true
    saye "ralph: preserved — report: $d/RUN-REPORT.md"
    return $rc
  }

  if [ "$STOP_ALL" -eq 1 ]; then
    if [ ! -d "$STOP_ROOT" ]; then
      saye "ralph: stop --all: no run dirs ($STOP_ROOT missing)"
    else
      found=0
      for d in "$STOP_ROOT"/*/; do
        [ -d "$d" ] || continue
        found=1
        stop_one "${d%/}" || STOP_RC=1
      done
      [ "$found" -eq 1 ] || saye "ralph: stop --all: no run dirs in $STOP_ROOT"
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
        saye "ralph: stop: no pointer — using newest run with a status file: $newest"
        stop_one "$newest" || STOP_RC=1
      else
        saye "ralph: stop: no run with a status file found (looked in $STOP_ROOT)"
      fi
    else
      saye "ralph: stop: no runs found (no pointer, $STOP_ROOT missing)"
    fi
  fi
  exit $STOP_RC
fi

# -------------------------------------------------- attach mode (power-user)
ATTACHED=0
if [ $# -ge 1 ]; then
  ATTACHED=1
  RUN_DIR=$1; shift
  if [ -n "${PROJECT_DIR:-}" ]; then ralph_flags+=(--project-dir "$PROJECT_DIR"); fi
  if [ -n "$DEADLINE_EPOCH" ]; then ralph_flags+=(--deadline "$DEADLINE_EPOCH"); fi
  EXTRA=("$@")
  saye "ralph-monitor: run-dir=$RUN_DIR (attaching to existing run)"
  MONITOR_ARGS=(--run-dir "$RUN_DIR" "${ralph_flags[@]}" "${EXTRA[@]}")
fi

# ------------------------------------------------------------- zero-arg mode
if [ "$ATTACHED" -eq 0 ]; then
  TASK_FILE="${TASK_FILE:-TASK.md}"
  if [ ! -f "$TASK_FILE" ]; then
    saye "ralph: no $TASK_FILE in $(pwd)"
    saye "Zero-arg mode: write the task in ./$TASK_FILE, then run ralph.sh (or set TASK_FILE=<name> to point elsewhere)."
    saye "To attach to an existing run instead: ralph.sh <run-dir> [ralph args...]"
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
      saye "ralph: previous run $cand is dead (reboot/crash?) — harvesting post-mortem"
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
                 --idle-timeout "${IDLE_TIMEOUT:-300}")
    if [ -n "$CHILD_MODEL_VAL" ];    then launch_args+=(--model "$CHILD_MODEL_VAL"); fi
    if [ -n "$CHILD_PROVIDER_VAL" ]; then launch_args+=(--provider "$CHILD_PROVIDER_VAL"); fi

    saye "ralph: launching child (task=.$TASK_FILE, run-dir=$RUN_DIR, deadline=$DEADLINE_EPOCH, child-model=${CHILD_MODEL_VAL:-pi-default}, parent-model=${PARENT_MODEL_VAL:-pi-default})"
    launch_out=$(node "$HERE/launch.mjs" "${launch_args[@]}" 2>&1) || true
    case "$launch_out" in
      *'"launched":true'*)
        guard_pid=$(status_field "$RUN_DIR/pi-child-status.json" guardPid)
        saye "ralph: child launched (guardPid=$guard_pid)" ;;
      *'"launched":"unknown"'*)
        saye "ralph: WARNING launch.mjs reported 'unknown' (alive but silent) — proceeding, the pre-checks will catch a dead child" ;;
      *)
        saye "ralph: LAUNCH FAILED — output from launch.mjs:"
        echo "$launch_out" | tail -20 >&2
        exit 1 ;;
    esac

    mkdir -p "$PROJECT_DIR/.pi-supervisor"
    echo "$RUN_DIR" > "$PTR"
    # keep run artifacts out of git's way (idempotent — the line is added once)
    if [ -d "$PROJECT_DIR/.git" ] && ! grep -qxF '.pi-supervisor/' "$PROJECT_DIR/.gitignore" 2>/dev/null; then
      { printf '\n# pi-supervisor run artifacts\n.pi-supervisor/\n' >> "$PROJECT_DIR/.gitignore"; } 2>/dev/null \
        && saye "ralph: added .pi-supervisor/ to .gitignore" || true
    fi
  else
    # attach to a live run: honor the run's own deadline unless the user overrode it
    if [ -z "$DEADLINE_RAW" ]; then
      iso=$(status_field "$RUN_DIR/pi-child-status.json" deadlineIso)
      [ -n "$iso" ] && DEADLINE_EPOCH="$iso"
    fi
    saye "ralph: attaching to live run $RUN_DIR (no new child launched)"
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
    saye "ralph: preserved — report: $HARVEST_TARGET/RUN-REPORT.md   index: $(dirname "$HARVEST_TARGET")/INDEX.json"
  fi
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

saye "ralph: monitoring — cycles every ${CYCLE_SEC:-1200}s, Ctrl+C stops the MONITOR only (the child keeps running)"
rc=0
node "$HERE/ralph-monitor.mjs" "${MONITOR_ARGS[@]}" || rc=$?
exit $rc
