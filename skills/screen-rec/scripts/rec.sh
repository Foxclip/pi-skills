#!/bin/bash
# rec.sh — single-file Windows screen recorder (ffmpeg gdigrab).
#
#   rec.sh record [sec]      ONE-SHOT (preferred): start, wait sec (default 10),
#                            stop, audit, trim, remux — one call, nothing left
#                            dangling. On signal, a trap kills ffmpeg; the .ts
#                            stays on disk for `rec.sh stop` to finish.
#   rec.sh start [maxsec]    LONG mode: start now (default max 600s), return
#                            immediately. A watchdog auto-kills the recording
#                            at the deadline if still alive (agent-death proof).
#   rec.sh stop [ts]         Stop + audit + trim + remux to .mp4. No args =
#                            self-heal: uses rec.state, else adopts any live
#                            gdigrab ffmpeg (finds the .ts from its cmdline).
#   rec.sh status            Show state + any live recording.
#
# Record to .ts NEVER .mp4: a hard kill (Stop-Process/kill = SIGKILL) leaves an
# mp4 without its moov atom (unplayable); TS needs no trailer. remux writes one.
# PID lookup uses CIM (git-bash has no pgrep; `ps -C` doesn't match native
# names). No $_ anywhere — MSYS bash mangles it.
set -u
FF=ffmpeg
STATE=rec.state
CIMP="Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"

gdigrab_pid() {
  powershell -NoProfile -Command "$CIMP" 2>/dev/null \
    | grep -F gdigrab | head -1 | awk -F'","' '{print $1}' | tr -d '"'
}

gdigrab_pid_of() { # pid of the gdigrab ffmpeg recording the file named $1
  powershell -NoProfile -Command "$CIMP" 2>/dev/null \
    | grep -F gdigrab | grep -F "$1" | head -1 | awk -F'","' '{print $1}' | tr -d '"'
}

gdigrab_out() {
  # output file = last token of the gdigrab ffmpeg command line (no spaces in OUT)
  powershell -NoProfile -Command "$CIMP" 2>/dev/null \
    | grep -F gdigrab | head -1 | awk -F'","' '{print $2}' | awk '{print $NF}' | tr -d '"'
}

write_state() { # pid, out, max
  printf 'PID=%s\nOUT=%s\nMAX=%s\nSTARTED=%s\n' "$1" "$2" "$3" "$(date '+%F %T')" > "$STATE"
}

start_ffmpeg() { # out, max -> sets globals PID/OUT/DIRABS
  OUT="$1"; MAXREC="$2"
  DIRABS="$(pwd -P)"
  BASE="$(basename "$OUT")"
  cd "$DIRABS" 2>/dev/null || true
  EXISTING="$(gdigrab_pid)"
  if [ -n "$EXISTING" ]; then
    echo "WARNING: a gdigrab ffmpeg is already running (pid $EXISTING) — 'rec.sh stop' it first if you meant to start fresh" >&2
  fi
  # fps=25 decimates the (variable, ~20-60fps) gdigrab stream to a constant 25fps:
  # without it the footage's pacing is wrong (plays too fast/slow) and the encoder
  # queue grows unbounded, so a hard kill loses several seconds. Hard-kill loss with
  # fps=25 is <1s (encoder queue + OS write-back); the trim below drops the rest.
  "$FF" -hide_banner -loglevel error -f gdigrab -framerate 25 -i desktop -vf fps=25 \
    -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p "$BASE" > "$BASE.log" 2>&1 &
  sleep 1
  PID="$(gdigrab_pid_of "$BASE")"
  write_state "$PID" "$DIRABS/$BASE" "$MAXREC"
  # watchdog: kill at deadline only if THIS recording (same PID in state) is still alive
  (
    sleep "$MAXREC"
    SP="$(sed -n 's/^PID=//p' rec.state 2>/dev/null)"
    CP="$(gdigrab_pid)"
    if [ -n "$SP" ] && [ "$SP" = "$CP" ]; then
      powershell -NoProfile -Command "Stop-Process -Id $SP -Force -ErrorAction SilentlyContinue" 2>/dev/null
    fi
  ) >/dev/null 2>&1 &
}

finish_ffmpeg() { # ts (absolute or cwd-relative)
  TS="$1"
  # the .ts can lag behind process death by several seconds (OS write-back);
  # wait for it to appear before concluding it is missing
  for _ in $(seq 1 40); do [ -f "$TS" ] && break; sleep 0.25; done
  [ -f "$TS" ] || TS="$(basename "$TS")"
  [ -f "$TS" ] || { echo "no .ts found for '$TS' — nothing to finish"; return 1; }
  LIVE="$(gdigrab_pid)"
  if [ -n "$LIVE" ]; then
    powershell -NoProfile -Command "Stop-Process -Id $LIVE -Force -ErrorAction SilentlyContinue" 2>/dev/null
    sleep 1
  fi
  OUTMP4="${TS%.ts}.mp4"
  "$FF" -hide_banner -i "$TS" -vf showinfo -an -f null - 2> showinfo.log
  TRIM="$(awk '/error while decoding/ { exit } /showinfo/ { if (match($0, /pts_time:[0-9.]+/)) pts = substr($0, RSTART + 9, RLENGTH - 9) } END { if (pts != "") print pts }' showinfo.log)"
  rm -f showinfo.log
  if [ -n "$TRIM" ]; then
    echo "trimming at pts=$TRIM (corrupted tail after hard kill)"
    "$FF" -y -hide_banner -loglevel error -t "$TRIM" -i "$TS" -c copy "$OUTMP4"
  else
    "$FF" -y -hide_banner -loglevel error -i "$TS" -c copy "$OUTMP4"
  fi
  rm -f "$STATE"
  echo "=== audit (empty = clean):"
  "$FF" -v error -i "$OUTMP4" -f null - 2>&1 | head -5
  echo "=== probe:"
  ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,nb_frames -of default=noprint_wrappers=1 "$OUTMP4"
}

SUB="${1:-status}"; shift 2>/dev/null || true
case "$SUB" in
  record)
    SEC="${1:-10}"
    trap 'L="$(gdigrab_pid)"; [ -n "$L" ] && powershell -NoProfile -Command "Stop-Process -Id $L -Force -ErrorAction SilentlyContinue" 2>/dev/null' TERM INT HUP
    start_ffmpeg "screen-$(date +%Y%m%d-%H%M%S).ts" "$SEC"
    echo "recording ${SEC}s (PID=$PID) ..."
    sleep "$SEC"
    finish_ffmpeg "$DIRABS/$BASE"
    ;;
  start)
    MAXSEC="${1:-600}"
    start_ffmpeg "screen-$(date +%Y%m%d-%H%M%S).ts" "$MAXSEC"
    echo "PID=$PID OUT=$DIRABS/$BASE MAX=${MAXSEC}s STATE=$DIRABS/$STATE (auto-kills at deadline if still alive)"
    ;;
  stop)
    TS="${1:-}"
    [ -z "$TS" ] && [ -f "$STATE" ] && TS="$(sed -n 's/^OUT=//p' "$STATE")"
    if [ -z "$TS" ]; then
      LIVE="$(gdigrab_pid)"
      if [ -n "$LIVE" ]; then
        TS="$(gdigrab_out)"
        echo "adopted orphaned recording (pid $LIVE): $TS"
      fi
    fi
    [ -z "$TS" ] && { echo "no recording found (no $STATE, no live gdigrab ffmpeg)"; exit 1; }
    finish_ffmpeg "$TS"
    ;;
  status)
    if [ -f "$STATE" ]; then cat "$STATE"; fi
    LIVE="$(gdigrab_pid)"
    if [ -n "$LIVE" ]; then echo "LIVE pid=$LIVE out=$(gdigrab_out)"; else echo "LIVE none"; fi
    ;;
  *)
    echo "usage: rec.sh record [sec] | start [maxsec] | stop [ts] | status"; exit 2
    ;;
esac
