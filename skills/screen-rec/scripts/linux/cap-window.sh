#!/usr/bin/env bash
# cap.sh — X11 stills. SAFE capture: always grabs the ROOT window
# (ffmpeg x11grab -i :0.0); a "window" still = one root frame + crop filter
# at the window's absolute on-screen rect. No focus change.
#
# HARD RULE: never XGetImage an individual window on this machine —
# not `import -window <id>`, not `maim -i <id>`, not `x11grab -window_id`.
# Per-window XGetImage on GLX windows hard-locks the box (DRI3/GPU wedge,
# verified 2x, reboot required). Root-window grab is safe (verified).
#
# Usage:
#   cap.sh                    all visible top-level windows
#   cap.sh -f [NAME.png]      full-screen still (default: full-<timestamp>.png)
#   cap.sh -w ID [-w ID ...]  window(s) by id (decimal or 0x-hex)
#   cap.sh -t 'ERE'           windows whose title matches (ERE)
#   -o DIR                    output dir (default: caps)
# Output: DIR/cap-<sanitized-title>.png (window), DIR/<name> (root).
# Minimized/unmapped targets are skipped with a notice (restore first).
# Notes:
#   - window rect = CLIENT window geometry: CSD windows (GNOME default,
#     e.g. gnome-terminal) = full visible window incl. header bar;
#     server-decorated windows exclude the WM title bar.
#   - crops are clamped to the root rect; partially off-screen windows
#     capture their visible portion; fully off-screen → skipped.
#   - a (near-)black result is flagged, not failed (a black window is legal).
set -uo pipefail

OUT="caps"
FULL=0; FULLNAME=""
declare -a WIDS=() TITLES=()

die() { echo "ERROR: $*" >&2; exit 1; }

[ -n "${DISPLAY:-}" ] || die "DISPLAY not set"
command -v ffmpeg xwininfo xdotool wmctrl >/dev/null \
  || die "missing one of: ffmpeg x11grab xwininfo xdotool wmctrl"
IN=${DISPLAY}; case "$IN" in *:*.) : ;; *) IN="$IN.0" ;; esac
read -r RW RH < <(xdotool getdisplaygeometry) || die "cannot read display geometry"

grab_root() { # $1=outfile ; one x11grab frame of the whole screen
  ffmpeg -hide_banner -loglevel error -nostdin -y -f x11grab \
    -framerate 25 -video_size "${RW}x${RH}" -i "$IN" -frames:v 1 "$1" \
    || die "x11grab root capture failed"
}

win_geom() { # $1=hexid → sets X Y W H (absolute, clamped, even) ; rc: 0 ok, 1 notfound, 2 unmapped, 3 too small
  local info ax ay w h
  info=$(xwininfo -id "$1" 2>/dev/null) || return 1
  [[ $info == *IsViewable* ]] || return 2
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
  X=$ax Y=$ay W=$w H=$h
  (( W >= 8 && H >= 8 )) || return 3
  return 0
}

black_warn() { # $1=file
  local y
  y=$(ffmpeg -hide_banner -nostats -i "$1" \
        -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null - 2>&1 \
        | grep -oP 'YAVG=\K[0-9.]+' | head -1)
  if [[ $y =~ ^[0-9.]+$ ]] && awk "BEGIN{exit !($y < 8)}"; then
    echo "  WARN: $1 is (near-)black (YAVG=$y) — empty window? GPU-direct surface? off-screen region?"
  fi
}

sanitize() { printf '%s' "$1" | tr -cs 'A-Za-z0-9._-' '_' | cut -c1-40; }

while [ $# -gt 0 ]; do
  case $1 in
    -o) [ $# -ge 2 ] || die "-o needs a dir"; OUT=$2; shift 2 ;;
    -f) FULL=1; if [ $# -ge 2 ] && [[ $2 != -* ]]; then FULLNAME=$2; shift; fi; shift ;;
    -w) [ $# -ge 2 ] || die "-w needs an id"; WIDS+=("$2"); shift 2 ;;
    -t) [ $# -ge 2 ] || die "-t needs a regex"; TITLES+=("$2"); shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown arg: $1 (see -h)" ;;
  esac
done

# no explicit targets → all visible top-level windows
if [ ${#WIDS[@]} -eq 0 ] && [ ${#TITLES[@]} -eq 0 ] && [ $FULL -eq 0 ]; then
  mapfile -t WIDS < <(wmctrl -lp | awk 'NR>0 {print $1}')
fi

# title regexes → window ids
for t in ${TITLES[@]+"${TITLES[@]}"}; do
  hit=$(wmctrl -lp | awk -v re="$t" '{ id=$1; $1=$2=$3=$4=""; sub(/^ +/,""); if (match($0, re)) { print id; exit } }')
  [ -n "$hit" ] || die "no window title matches /$t/"
  WIDS+=("$hit")
done

mkdir -p "$OUT" || die "cannot create $OUT"
trap 'rm -f "$OUT/.root.png"' EXIT

n=0
if [ $FULL -eq 1 ]; then
  name=${FULLNAME:-full-$(date +%Y%m%d-%H%M%S).png}
  [[ $name == *.png ]] || name="$name.png"
  grab_root "$OUT/$name"
  echo "$OUT/$name"
  n=$((n+1))
fi

declare -A seen=()
if [ ${#WIDS[@]} -gt 0 ]; then
  grab_root "$OUT/.root.png"
  for id in ${WIDS[@]+"${WIDS[@]}"}; do
    case $id in 0x*|0X*) idn=$((id)) ;; *) idn=$id ;; esac
    idn=$((idn))
    hex=$(printf '0x%08x' "$idn")
    [ -n "${seen[$hex]:-}" ] && continue
    seen[$hex]=1
    title=$(xdotool getwindowname "$idn" 2>/dev/null)
    [ -n "$title" ] || title="win-$hex"
    win_geom "$hex"; rc=$?
    case $rc in
      1) echo "SKIP $hex ($title): NOTFOUND"; continue ;;
      2) echo "SKIP $hex ($title): MINIMIZED/unmapped — restore first"; continue ;;
      3) echo "SKIP $hex ($title): off-screen (visible area too small)"; continue ;;
    esac
    base=$(sanitize "$title"); [ -n "$base" ] || base="win"
    f="$OUT/cap-$base.png"
    [ -e "$f" ] && f="$OUT/cap-$base-$hex.png"
    if ffmpeg -hide_banner -loglevel error -nostdin -y -i "$OUT/.root.png" \
         -vf "crop=${W}:${H}:${X}:${Y}" "$f" && [ -s "$f" ]; then
      echo "$f (${W}x${H} at +${X}+${Y}) — $title"
      black_warn "$f"
      n=$((n+1))
    else
      echo "FAIL $hex ($title): crop failed"
    fi
  done
fi

[ $n -gt 0 ] || { echo "nothing captured" >&2; exit 1; }
