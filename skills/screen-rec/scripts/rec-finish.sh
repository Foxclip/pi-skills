#!/bin/bash
# Stop the recording started by rec-start.sh and produce a clean .mp4.
# Usage: rec-finish.sh <rec.ts> [out.mp4]
# Kills ffmpeg via rec.pid (NOT by name — an unrelated ffmpeg, e.g. a
# concurrent yt-dlp merge, must not die). Audits the .ts; a hard kill clips
# the last in-flight TS packet, so if the audit finds decode errors the tail
# is trimmed at the last clean pts before remuxing.
set -u
TS="${1:?usage: rec-finish.sh <rec.ts> [out.mp4]}"
if [ -f rec.pid ]; then
  PID="$(cat rec.pid)"
  if [ -n "$PID" ]; then
    powershell -NoProfile -Command "Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue" 2>/dev/null
    sleep 1
  fi
fi
OUT="${2:-$(basename "${TS%.ts}").mp4}"
FF=ffmpeg
"$FF" -hide_banner -i "$TS" -vf showinfo -an -f null - 2> showinfo.log
TRIM="$(awk '/error while decoding/ { exit } /showinfo/ { if (match($0, /pts_time:[0-9.]+/)) pts = substr($0, RSTART + 9, RLENGTH - 9) } END { if (pts != "") print pts }' showinfo.log)"
rm -f showinfo.log
if [ -n "$TRIM" ]; then
  echo "trimming at pts=$TRIM (corrupted tail after hard kill)"
  "$FF" -y -hide_banner -loglevel error -t "$TRIM" -i "$TS" -c copy "$OUT"
else
  "$FF" -y -hide_banner -loglevel error -i "$TS" -c copy "$OUT"
fi
echo "=== audit (empty = clean):"
"$FF" -v error -i "$OUT" -f null - 2>&1 | head -5
echo "=== probe:"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height,nb_frames -of default=noprint_wrappers=1 "$OUT"
