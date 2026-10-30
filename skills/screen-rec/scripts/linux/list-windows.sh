#!/usr/bin/env bash
# list-windows.sh — list top-level X11 windows.
# Safe: attribute queries only (xwininfo/wmctrl), no XGetImage.
# Output columns: DEC_ID  HEX_ID  PID  GEOM (WxH+X+Y, absolute screen coords)
#                STATE (OK=IsViewable, else MINIMIZED)  TITLE
# Geometry comes from xwininfo "Absolute" coords — xdotool/wmctrl report
# frame-relative positions (verified off by the frame extent on this box).
set -uo pipefail

[ -n "${DISPLAY:-}" ] || { echo "ERROR: DISPLAY not set" >&2; exit 1; }

printf "%-10s %-10s %-7s %-14s %-9s %s\n" "DEC_ID" "HEX_ID" "PID" "GEOM" "STATE" "TITLE"
while read -r hexid desk pid host title; do
  case "$hexid" in 0x*|0X*) ;; *) continue ;; esac
  dec=$((hexid))
  state=MINIMIZED
  geo="-"
  if info=$(xwininfo -id "$hexid" 2>/dev/null); then
    if [[ $info == *IsViewable* ]]; then
      state=OK
      ax=$(printf '%s\n' "$info" | awk -F': *' '/Absolute upper-left X/ {print $2}')
      ay=$(printf '%s\n' "$info" | awk -F': *' '/Absolute upper-left Y/ {print $2}')
      w=$(printf '%s\n' "$info" | awk -F': *' '/^ *Width:/ {print $2}')
      h=$(printf '%s\n' "$info" | awk -F': *' '/^ *Height:/ {print $2}')
      geo="${w}x${h}+${ax}+${ay}"
    fi
  fi
  printf "%-10s %-10s %-7s %-14s %-9s %s\n" "$dec" "$hexid" "${pid:-?}" "$geo" "$state" "$title"
done < <(wmctrl -lp)
