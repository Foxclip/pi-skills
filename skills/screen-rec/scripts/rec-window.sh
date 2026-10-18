#!/bin/bash
# rec-window.sh — record ONE specific WINDOW with ffmpeg gfxcapture
# (Windows.Graphics.Capture API, FFmpeg 8.0+). Same kill-proof .ts->.mp4
# flow as rec.sh, but window-targeted: no screen crop, no moving-window
# drift, works on GPU/composited (DComp/D3D) apps where gdigrab window
# capture produces black frames.
#
#   rec-window.sh record [sec]   SEL [OPTS]   ONE-SHOT (preferred): start,
#                            wait sec (default 10), stop, audit, trim, remux.
#   rec-window.sh start  [maxsec] SEL [OPTS]  LONG mode: start, return
#                            immediately; watchdog auto-kills at deadline
#                            (agent-death proof).
#   rec-window.sh stop  [ts]     Stop + audit + trim + remux to .mp4. No
#                            args = self-heal: uses rec-window.state, else
#                            adopts any live gfxcapture ffmpeg.
#   rec-window.sh status         Show state + any live window recording.
#
# SEL (required for record/start):  --hwnd N   or   --title REGEX
#   --hwnd    exact window handle from list-windows.ps1 (preferred — no
#             non-ASCII title pasting).
#   --title   PCRE regex matched against the window title; (?i) prefix
#             makes it case-insensitive. ASCII-safe substring recommended.
# OPTS: --cursor   capture the mouse cursor (default: off)
#
# Why gfxcapture and not gdigrab: gdigrab title=/hwnd= BitBlts the window's
# GDI DC, which is EMPTY for GPU/composited windows (all modern apps —
# Docker Desktop, VS Code, Terminal, ...) => valid file, all-black frames.
# gfxcapture uses the Windows.Graphics.Capture API (compositor level) and
# captures at the window's own size; the window need not be foreground.
#
# Pacing: gfxcapture frames carry real wall-clock timestamps, so duration
# is correct without fps decimation (verified: 5s wall -> 5.12s duration).
# max_framerate=25 caps the capture rate; -r 25 stamps constant pts.
#
# Record to .ts NEVER .mp4 (hard kill = no moov atom = unplayable mp4).
# PID lookup via CIM (no pgrep in this git-bash; ps -C mismatches native
# exes). No $_ anywhere — MSYS bash mangles it.
set -u
FF=ffmpeg
STATE=rec-window.state
SCRIPTDIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"
CIMP="Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"

gfx_pid() {
  powershell -NoProfile -Command "$CIMP" 2>/dev/null \
    | grep -F gfxcapture | head -1 | awk -F'","' '{print $1}' | tr -d '"'
}

gfx_pid_of() { # pid of the gfxcapture ffmpeg recording the file named $1
  powershell -NoProfile -Command "$CIMP" 2>/dev/null \
    | grep -F gfxcapture | grep -F "$1" | head -1 | awk -F'","' '{print $1}' | tr -d '"'
}

gfx_out() {
  # output file = last token of the gfxcapture ffmpeg cmdline (no spaces in OUT)
  powershell -NoProfile -Command "$CIMP" 2>/dev/null \
    | grep -F gfxcapture | head -1 | awk -F'","' '{print $2}' | awk '{print $NF}' | tr -d '"'
}

write_state() { # pid, out, max
  printf 'PID=%s\nOUT=%s\nMAX=%s\nSTARTED=%s\n' "$1" "$2" "$3" "$(date '+%F %T')" > "$STATE"
}

build_filter() { # SEL_MODE SEL_VAL dummy CURSOR -> sets FILTER (lavfi source string)
  if [ "$1" = hwnd ]; then
    FILTER="gfxcapture=hwnd=$2:capture_cursor=$4:max_framerate=25"
  else
    FILTER="gfxcapture=window_title=$2:capture_cursor=$4:max_framerate=25"
  fi
}

start_ffmpeg() { # out, max, selmode, selval, cursor -> sets globals PID/OUT/DIRABS
  OUT="$1"; MAXREC="$2"; SELMODE="$3"; SELVAL="$4"; CURSOR="$5"
  DIRABS="$(pwd -P)"
  BASE="$(basename "$OUT")"
  build_filter "$SELMODE" "$SELVAL" x "$CURSOR"
  cd "$DIRABS" 2>/dev/null || true
  EXISTING="$(gfx_pid)"
  if [ -n "$EXISTING" ]; then
    echo "WARNING: a gfxcapture ffmpeg is already running (pid $EXISTING) — 'rec-window.sh stop' it first if you meant to start fresh" >&2
  fi
  # gfxcapture emits d3d11 hardware frames: hwdownload to system memory, and
  # the bgra intermediate is MANDATORY (direct yuv420p download errors with
  # "Invalid output format yuv420p for hwframe download").
  "$FF" -hide_banner -loglevel error -f lavfi -i "$FILTER" \
    -vf "hwdownload,format=bgra,format=yuv420p" -r 25 \
    -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p "$BASE" > "$BASE.log" 2>&1 &
  sleep 1
  PID="$(gfx_pid_of "$BASE")"
  if [ -z "$PID" ]; then
    echo "ERROR: ffmpeg not running — check $BASE.log (bad hwnd/title?)" >&2
    cat "$BASE.log" >&2
    return 1
  fi
  write_state "$PID" "$DIRABS/$BASE" "$MAXREC"
  # watchdog: kill at deadline only if THIS recording (same PID in state) is still alive
  (
    sleep "$MAXREC"
    SP="$(sed -n 's/^PID=//p' rec-window.state 2>/dev/null)"
    CP="$(gfx_pid)"
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
  LIVE="$(gfx_pid)"
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

usage() {
  echo "usage: rec-window.sh record [sec] (--hwnd N | --title REGEX) [--cursor]"
  echo "       rec-window.sh start  [maxsec] (--hwnd N | --title REGEX) [--cursor]"
  echo "       rec-window.sh stop [ts] | status"
}

SUB="${1:-status}"; shift 2>/dev/null || true
SEL_MODE=""; SEL_VAL=""; CURSOR=0
case "$SUB" in
  record|start)
    SEC=""
    SEL_MODE=""; SEL_VAL=""
    i=0
    while [ $i -lt $# ]; do
      a="${1}"; shift || true
      case "$a" in
        --hwnd)   SEL_MODE=hwnd;  SEL_VAL="${1:-}"; shift || true ;;
        --title)  SEL_MODE=title; SEL_VAL="${1:-}"; shift || true ;;
        --cursor) CURSOR=1 ;;
        *)        [ -z "$SEC" ] && SEC="$a" ;;
      esac
      i=$((i+1))
    done
    [ -z "$SEL_MODE" ] || [ -z "$SEL_VAL" ] && { usage; exit 2; }
    # Preflight: gfxcapture HANGS with zero frames on minimized/hidden windows
    # (WGC never delivers a frame for an un-composited surface - verified on
    # Taskmgr + Windows Terminal: no frame in 60s). Refuse early with a clear
    # error instead of starting a ffmpeg that will sit idle forever.
    if [ "$SEL_MODE" = hwnd ]; then
      PRE="$(powershell -NoProfile -ExecutionPolicy Bypass -File "$SCRIPTDIR/win-rect.ps1" -Hwnd "$SEL_VAL" 2>/dev/null)"
    else
      PRE="$(powershell -NoProfile -ExecutionPolicy Bypass -File "$SCRIPTDIR/win-rect.ps1" -Title "$SEL_VAL" 2>/dev/null)"
    fi
    case "$PRE" in
      MINIMIZED*)
        echo "ERROR: target window is minimized/hidden ($PRE) - gfxcapture would hang with zero frames. Restore the window first (or use cap-foreground.ps1 for a one-shot still)." >&2
        exit 1 ;;
      NOTFOUND|BADHWND|'')
        echo "WARNING: preflight could not resolve the target ($PRE) - continuing anyway" >&2 ;;
    esac
    if [ "$SUB" = record ]; then
      SEC="${SEC:-10}"
      trap 'L="$(gfx_pid)"; [ -n "$L" ] && powershell -NoProfile -Command "Stop-Process -Id $L -Force -ErrorAction SilentlyContinue" 2>/dev/null' TERM INT HUP
      start_ffmpeg "win-$(date +%Y%m%d-%H%M%S).ts" "$SEC" "$SEL_MODE" "$SEL_VAL" "$CURSOR" || exit 1
      echo "recording ${SEC}s (PID=$PID) ..."
      sleep "$SEC"
      finish_ffmpeg "$DIRABS/$BASE"
    else
      SEC="${SEC:-600}"
      start_ffmpeg "win-$(date +%Y%m%d-%H%M%S).ts" "$SEC" "$SEL_MODE" "$SEL_VAL" "$CURSOR" || exit 1
      echo "PID=$PID OUT=$DIRABS/$BASE MAX=${SEC}s STATE=$DIRABS/$STATE (auto-kills at deadline if still alive)"
    fi
    ;;
  stop)
    TS="${1:-}"
    [ -z "$TS" ] && [ -f "$STATE" ] && TS="$(sed -n 's/^OUT=//p' "$STATE")"
    if [ -z "$TS" ]; then
      LIVE="$(gfx_pid)"
      if [ -n "$LIVE" ]; then
        TS="$(gfx_out)"
        echo "adopted orphaned recording (pid $LIVE): $TS"
      fi
    fi
    [ -z "$TS" ] && { echo "no recording found (no $STATE, no live gfxcapture ffmpeg)"; exit 1; }
    finish_ffmpeg "$TS"
    ;;
  status)
    if [ -f "$STATE" ]; then cat "$STATE"; fi
    LIVE="$(gfx_pid)"
    if [ -n "$LIVE" ]; then echo "LIVE pid=$LIVE out=$(gfx_out)"; else echo "LIVE none"; fi
    ;;
  *)
    usage; exit 2
    ;;
esac
