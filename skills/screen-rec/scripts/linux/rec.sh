#!/usr/bin/env bash
# rec.sh — full-screen X11 video, kill-proof.
#
#   rec.sh record [SEC]      one-shot (default 10s) → rec-<timestamp>.mp4
#   rec.sh start [MAXSEC]    long-run with watchdog (default 600s)
#   rec.sh stop              self-heal: kill ffmpeg if alive, remux .ts → .mp4
#   rec.sh status            pid / out path / live?
#
# SAFE: x11grab of the ROOT window only. Never -window_id / per-window
# XGetImage — hard-locks this machine on GLX windows (verified 2x, reboot).
#
# .ts is kill-safe (no moov atom to lose); stop remuxes -c copy to .mp4.
# Tail loss: 'record' uses -t → clean stop, ZERO loss. 'start'/watchdog stop
# loses the ~1.6s x264 lookahead queue (signal handler flags the muxer).
# State: rec.state in cwd (pid wpid ts mp4, ts is absolute). stop self-heals
# from it — works even if the start call/session is gone.
set -uo pipefail

STATE=rec.state
[ -n "${DISPLAY:-}" ] || { echo "ERROR: DISPLAY not set" >&2; exit 1; }
IN=${DISPLAY}; case "$IN" in *:*.) : ;; *) IN="$IN.0" ;; esac
read -r RW RH < <(xdotool getdisplaygeometry) || { echo "ERROR: cannot read display geometry" >&2; exit 1; }

die() { echo "ERROR: $*" >&2; exit 1; }
ffmpeg -hide_banner -devices 2>/dev/null | grep -q x11grab || die "ffmpeg lacks the x11grab device"

do_stop() {
  [ -f "$STATE" ] || { echo "no $STATE — nothing to stop"; return 1; }
  read -r pid wpid ts mp4 < "$STATE"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
  fi
  kill "$wpid" 2>/dev/null || true
  # small grace for the muxer to flush the final packets
  # NOTE: on a static screen the .ts can legitimately stay 0 bytes while
  # ffmpeg runs (x264 lookahead + avio buffer hold the tiny static-frame
  # output); it flushes on the finalize triggered by the kill above — so
  # only check the file AFTER the process is confirmed dead.
  [ -s "$ts" ] || for _ in $(seq 1 40); do [ -s "$ts" ] && break; sleep 0.25; done
  [ -s "$ts" ] || { echo "FAIL: $ts missing/empty"; rm -f "$STATE"; return 1; }
  ffmpeg -hide_banner -loglevel error -nostdin -y -i "$ts" -c copy "$mp4" \
    || { echo "FAIL: remux of $ts"; rm -f "$STATE"; return 1; }
  rm -f "$ts" "$STATE"
  echo "saved $mp4 ($(du -h "$mp4" | cut -f1))"
}

do_start() { # $1=watchdog_sec  $2=-t limit (0 = none) ; writes state
  local maxsec=$1 limit=${2:-0} base pid wpid ts mp4 tl=""
  base="rec-$(date +%Y%m%d-%H%M%S)"
  ts="$PWD/$base.ts"; mp4="$PWD/$base.mp4"
  (( limit > 0 )) && tl="-t $limit"
  # NOTE: launch ffmpeg as a BARE background command, never `func &`:
  # a wrapper function makes $! the subshell, not ffmpeg — killing that
  # orphans ffmpeg (zombie recorder) and the state pid goes stale.
  # -t: stops input at the limit, then ffmpeg finalizes CLEANLY (no signal
  # → no tail loss); the watchdog below is only a safety net for a hung
  # finalize. +flush_packets: write every packet to disk immediately —
  # without it a static screen buffers everything and a kill loses ALL.
  ffmpeg -hide_banner -loglevel error -nostdin -y -f x11grab \
    -framerate 25 -video_size "${RW}x${RH}" -i "$IN" \
    -vf "fps=25" -c:v libx264 -preset veryfast -crf 23 -fflags +flush_packets $tl -an "$ts" &
  pid=$!
  ( sleep "$maxsec"; kill -TERM "$pid" 2>/dev/null ) &
  wpid=$!
  echo "$pid $wpid $ts $mp4" > "$STATE"
}

clear_stale() { # if a state exists: error if live, else self-heal
  [ -f "$STATE" ] || return 0
  read -r p _ < "$STATE"
  if kill -0 "$p" 2>/dev/null; then
    die "already recording (pid $p) — run 'rec.sh stop' first (or status)"
  fi
  do_stop >/dev/null || true
}

case ${1:-} in
  record)
    sec=${2:-10}
    [[ $sec =~ ^[0-9]+$ && $sec -gt 0 ]] || die "SEC must be a positive integer"
    clear_stale
    do_start $((sec + 10)) "$sec"   # -t stops cleanly; watchdog = safety net
    read -r pid _ _ _ < "$STATE"
    wait "$pid" 2>/dev/null || true
    do_stop || exit 1
    ;;
  start)
    maxsec=${2:-600}
    [[ $maxsec =~ ^[0-9]+$ && $maxsec -gt 0 ]] || die "MAXSEC must be a positive integer"
    clear_stale
    do_start "$maxsec"
    read -r pid wpid ts mp4 < "$STATE"
    echo "started pid=$pid out=$ts watchdog=${maxsec}s state=$STATE"
    ;;
  stop)
    do_stop || exit 1
    ;;
  status)
    if [ ! -f "$STATE" ]; then echo "not running (no $STATE)"; exit 0; fi
    read -r pid wpid ts mp4 < "$STATE"
    if kill -0 "$pid" 2>/dev/null; then
      echo "LIVE pid=$pid out=$ts size=$(stat -c%s "$ts" 2>/dev/null || echo 0)B"
    else
      echo "DEAD pid=$pid out=$ts — run 'rec.sh stop' to remux"
    fi
    ;;
  *)
    die "usage: rec.sh record [SEC] | start [MAXSEC] | stop | status"
    ;;
esac
