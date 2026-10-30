#!/usr/bin/env bash
# rec-window.sh — ONE-window X11 video, WYSIWYG: x11grab the ROOT and crop to
# the window's absolute on-screen rect. Never per-window XGetImage
# (hard-locks this machine on GLX windows; verified 2x, reboot).
#
#   rec-window.sh record [SEC]   --window ID | --title ERE
#   rec-window.sh start [MAXSEC] --window ID | --title ERE
#   rec-window.sh stop [ts]      self-heal (state: rec-window.state)
#   rec-window.sh status
#
# ID = decimal or 0x-hex (from list-windows.sh). --title matches the first
# title against an ERE; multiple matches → error listing the candidates.
# Preflight: window must exist and be mapped. MINIMIZED/unmapped → refuse
# with a clear error (a crop would record the stale desktop region — the
# WGC-minimized-hang equivalent, but a clean refusal instead of a hang).
# Geometry = xwininfo Absolute coords (xdotool/wmctrl are frame-relative,
# verified off on this box), clamped to the root rect, rounded to even.
# Output: win-<idhex>-<timestamp>.{ts,mp4}; separate state file, so it can
# run alongside rec.sh. Cursor is NOT captured (x11grab reads the root
# pixmap; the X cursor is separate). Audio is NOT captured.
# Tail loss: 'record' uses -t → clean stop, ZERO loss. 'start'/watchdog stop
# loses the ~1.6s x264 lookahead queue (signal handler flags the muxer).
set -uo pipefail

STATE=rec-window.state
[ -n "${DISPLAY:-}" ] || { echo "ERROR: DISPLAY not set" >&2; exit 1; }
IN=${DISPLAY}; case "$IN" in *:*.) : ;; *) IN="$IN.0" ;; esac
read -r RW RH < <(xdotool getdisplaygeometry) || { echo "ERROR: cannot read display geometry" >&2; exit 1; }

die() { echo "ERROR: $*" >&2; exit 1; }
ffmpeg -hide_banner -devices 2>/dev/null | grep -q x11grab || die "ffmpeg lacks the x11grab device"

WINID=""; WINTITLE=""; SECARG=""
WID=0; WHEX=""; WTITLE=""; X=0; Y=0; W=0; H=0

resolve_window() {
  if [ -n "$WINID" ]; then
    case $WINID in 0x*|0X*) WID=$((WINID)) ;; *) WID=$WINID ;; esac
  else
    local hits
    hits=$(wmctrl -lp | awk -v re="$WINTITLE" '
      { id=$1; $1=$2=$3=$4=""; sub(/^ +/,""); if (match($0, re)) print id" "$0 }')
    [ -n "$hits" ] || die "no window title matches /$WINTITLE/"
    [ "$(printf '%s\n' "$hits" | wc -l)" = 1 ] \
      || { echo "ambiguous --title /$WINTITLE/ — multiple matches (use --window):" >&2; printf '%s\n' "$hits" >&2; exit 1; }
    WID=$(printf '%s\n' "$hits" | awk '{print $1}')
    WID=$((WID))
  fi
  WID=$((WID))
  WHEX=$(printf '0x%08x' "$WID")
  WTITLE=$(xdotool getwindowname "$WID" 2>/dev/null)
  [ -n "$WTITLE" ] || WTITLE="$WHEX"
}

preflight() {
  local info
  info=$(xwininfo -id "$WHEX" 2>/dev/null) || die "window $WHEX ($WTITLE) not found"
  [[ $info == *IsViewable* ]] \
    || die "window $WHEX ($WTITLE) is MINIMIZED/unmapped — restore it first (a crop would record the stale desktop region)"
  local ax ay w h
  ax=$(printf '%s\n' "$info" | awk -F': *' '/Absolute upper-left X/ {print $2}')
  ay=$(printf '%s\n' "$info" | awk -F': *' '/Absolute upper-left Y/ {print $2}')
  w=$(printf '%s\n' "$info" | awk -F': *' '/^ *Width:/ {print $2}')
  h=$(printf '%s\n' "$info" | awk -F': *' '/^ *Height:/ {print $2}')
  (( ax < 0 )) && ax=0
  (( ay < 0 )) && ay=0
  (( ax % 2 )) && (( ax++ ))
  (( ay % 2 )) && (( ay++ ))
  (( w > RW - ax )) && w=$(( RW - ax ))
  (( h > RH - ay )) && h=$(( RH - ay ))
  w=$(( w / 2 * 2 )); h=$(( h / 2 * 2 ))
  (( w >= 8 && h >= 8 )) || die "window $WHEX ($WTITLE) is off-screen (visible area too small)"
  X=$ax Y=$ay W=$w H=$h
}

do_stop() { # $1=optional ts override
  local ts=${1:-} mp4 pid wpid
  if [ -z "$ts" ]; then
    [ -f "$STATE" ] || { echo "no $STATE — nothing to stop"; return 1; }
    read -r pid wpid ts mp4 < "$STATE"
  else
    pid=""; mp4="${ts%.ts}.mp4"
  fi
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
    [ -f "$STATE" ] && { read -r p w _ < "$STATE"; kill "$w" 2>/dev/null || true; }
  fi
  # NOTE: on a static screen the .ts can stay 0 bytes while ffmpeg runs
  # (encoder lookahead + avio buffer); it flushes on finalize (the kill
  # above) — check the file only after the process is confirmed dead.
  [ -s "$ts" ] || for _ in $(seq 1 40); do [ -s "$ts" ] && break; sleep 0.25; done
  [ -s "$ts" ] || { echo "FAIL: $ts missing/empty"; [ -z "${1:-}" ] && rm -f "$STATE"; return 1; }
  ffmpeg -hide_banner -loglevel error -nostdin -y -i "$ts" -c copy "$mp4" \
    || { echo "FAIL: remux of $ts"; [ -z "${1:-}" ] && rm -f "$STATE"; return 1; }
  rm -f "$ts"
  [ -z "${1:-}" ] && rm -f "$STATE"
  echo "saved $mp4 ($(du -h "$mp4" | cut -f1))"
}

do_start() { # $1=watchdog_sec  $2=-t limit (0 = none) ; writes state
  local maxsec=$1 limit=${2:-0} base pid wpid ts mp4 tl=""
  base="win-$(printf '%08x' "$WID")-$(date +%Y%m%d-%H%M%S)"
  ts="$PWD/$base.ts"; mp4="$PWD/$base.mp4"
  (( limit > 0 )) && tl="-t $limit"
  # NOTE: launch ffmpeg as a BARE background command, never `func &`:
  # a wrapper function makes $! the subshell, not ffmpeg — killing that
  # orphans ffmpeg (zombie recorder) and the state pid goes stale.
  # -t: stops input at the limit, then ffmpeg finalizes CLEANLY (no signal
  # → no tail loss); the watchdog is only a safety net for a hung finalize.
  # +flush_packets: write every packet to disk immediately — without it a
  # static screen buffers everything and a kill loses ALL.
  ffmpeg -hide_banner -loglevel error -nostdin -y -f x11grab \
    -framerate 25 -video_size "${RW}x${RH}" -i "$IN" \
    -vf "crop=${W}:${H}:${X}:${Y},fps=25" -c:v libx264 -preset veryfast -crf 23 -fflags +flush_packets $tl -an "$ts" &
  pid=$!
  ( sleep "$maxsec"; kill -TERM "$pid" 2>/dev/null ) &
  wpid=$!
  echo "$pid $wpid $ts $mp4" > "$STATE"
}

clear_stale() {
  [ -f "$STATE" ] || return 0
  read -r p _ < "$STATE"
  if kill -0 "$p" 2>/dev/null; then
    die "already recording (pid $p) — run 'rec-window.sh stop' first (or status)"
  fi
  do_stop >/dev/null || true
}

[ $# -ge 1 ] || die "usage: rec-window.sh record|start [SEC] --window ID | --title ERE | stop | status"
mode=$1; shift
while [ $# -gt 0 ]; do
  case $1 in
    --window) [ $# -ge 2 ] || die "--window needs an id"; WINID=$2; shift 2 ;;
    --title)  [ $# -ge 2 ] || die "--title needs a regex"; WINTITLE=$2; shift 2 ;;
    *) if [ -n "$SECARG" ]; then die "unexpected arg: $1"; fi; SECARG=$1; shift ;;
  esac
done
[ -n "$SECARG" ] || SECARG=""

case $mode in
  record)
    [ -n "$WINID" ] || [ -n "$WINTITLE" ] || die "record needs --window ID or --title ERE"
    sec=${SECARG:-10}
    [[ $sec =~ ^[0-9]+$ && $sec -gt 0 ]] || die "SEC must be a positive integer"
    resolve_window; preflight
    clear_stale
    do_start $((sec + 10)) "$sec"   # -t stops cleanly; watchdog = safety net
    read -r pid _ _ _ < "$STATE"
    wait "$pid" 2>/dev/null || true
    do_stop || exit 1
    ;;
  start)
    [ -n "$WINID" ] || [ -n "$WINTITLE" ] || die "start needs --window ID or --title ERE"
    maxsec=${SECARG:-600}
    [[ $maxsec =~ ^[0-9]+$ && $maxsec -gt 0 ]] || die "MAXSEC must be a positive integer"
    resolve_window; preflight
    clear_stale
    do_start "$maxsec" 0
    read -r pid wpid ts mp4 < "$STATE"
    echo "started pid=$pid out=$ts rect=${W}x${H}+${X}+${Y} watchdog=${maxsec}s state=$STATE"
    ;;
  stop)
    [ $# -le 1 ] || die "stop takes at most one arg (ts override)"
    do_stop ${1:-} || exit 1
    ;;
  status)
    if [ ! -f "$STATE" ]; then echo "not running (no $STATE)"; exit 0; fi
    read -r pid wpid ts mp4 < "$STATE"
    if kill -0 "$pid" 2>/dev/null; then
      echo "LIVE pid=$pid out=$ts size=$(stat -c%s "$ts" 2>/dev/null || echo 0)B"
    else
      echo "DEAD pid=$pid out=$ts — run 'rec-window.sh stop' to remux"
    fi
    ;;
  *)
    die "usage: rec-window.sh record|start [SEC] --window ID | --title ERE | stop | status"
    ;;
esac
