#!/usr/bin/env bash
# ralph.sh — v0.18.1: terminal wrapper for ralph-monitor.mjs.
#
# Foreground by design: your terminal IS the view (ralph logs every cycle to
# stderr) and Ctrl+C reaches ralph's SIGINT handler directly (clean exit 130,
# state saved) — no orphaned process to hunt for. For unattended runs, wrap
# this script in tmux/nohup yourself; do not background it from here.
#
# Usage:
#   ralph.sh <run-dir> [ralph-monitor.mjs args...]
#
# Environment defaults (any explicit CLI arg wins — passthrough is appended
# last and ralph-monitor takes the last occurrence of a flag):
#   PI               pi executable           (default: pi)
#   MODEL            e.g. gemma-4-26B-...   (default: pi's default model)
#   PROVIDER         e.g. llama.cpp          (default: pi's default)
#   DEADLINE         ISO | "HH:MM" | epoch   (default: none)
#   MAX_HOURS        deadline horizon        (default: 12, if no DEADLINE)
#   CYCLE_SEC        (1200)  TIMEOUT_SEC    (600)
#   MAX_INTERVENTIONS (3)   STUCK_SEC      (3600)   STALE_SEC (180)
#   LLM_FAIL_MAX     (6)    PROJECT_DIR    (-)      SESSION (-)
#   PROMPT_FILE      (-)    LOG_FILE       (-)
#
# Example (same model as the child on a shared local server is fine — ralph
# survives its own model going down):
#   MODEL=gemma-4-26B-A4B-it-UD-Q4_K_M PROVIDER=llama.cpp \
#   DEADLINE="2026-11-01 22:00" \
#   ./ralph.sh /tmp/<task>/run1

set -euo pipefail

if [ $# -lt 1 ]; then
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi

RUN_DIR=$1
shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

args=(--run-dir "$RUN_DIR" --pi "${PI:-pi}")
if [ -n "${MODEL:-}" ];             then args+=(--model "$MODEL"); fi
if [ -n "${PROVIDER:-}" ];          then args+=(--provider "$PROVIDER"); fi
if [ -n "${DEADLINE:-}" ];          then args+=(--deadline "$DEADLINE"); fi
if [ -n "${MAX_HOURS:-}" ];         then args+=(--max-hours "$MAX_HOURS"); fi
if [ -n "${CYCLE_SEC:-}" ];         then args+=(--cycle-sec "$CYCLE_SEC"); fi
if [ -n "${TIMEOUT_SEC:-}" ];       then args+=(--timeout-sec "$TIMEOUT_SEC"); fi
if [ -n "${MAX_INTERVENTIONS:-}" ]; then args+=(--max-interventions "$MAX_INTERVENTIONS"); fi
if [ -n "${STUCK_SEC:-}" ];         then args+=(--stuck-sec "$STUCK_SEC"); fi
if [ -n "${STALE_SEC:-}" ];         then args+=(--stale-sec "$STALE_SEC"); fi
if [ -n "${LLM_FAIL_MAX:-}" ];      then args+=(--llm-fail-max "$LLM_FAIL_MAX"); fi
if [ -n "${PROMPT_FILE:-}" ];       then args+=(--prompt-file "$PROMPT_FILE"); fi
if [ -n "${PROJECT_DIR:-}" ];       then args+=(--project-dir "$PROJECT_DIR"); fi
if [ -n "${SESSION:-}" ];           then args+=(--session "$SESSION"); fi
if [ -n "${LOG_FILE:-}" ];          then args+=(--log-file "$LOG_FILE"); fi

echo "ralph-monitor: run-dir=$RUN_DIR pi=${PI:-pi} model=${MODEL:-<pi default>} provider=${PROVIDER:-<pi default>} deadline=${DEADLINE:-none} (cycle=${CYCLE_SEC:-1200}s, max-interventions=${MAX_INTERVENTIONS:-3})" >&2
exec node "$HERE/ralph-monitor.mjs" "${args[@]}" "$@"
