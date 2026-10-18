#!/bin/bash
# Start a kill-proof screen recording (MPEG-TS: no trailer, survives hard kill).
# Record to .ts NEVER .mp4 — a hard kill (Stop-Process/taskkill/MSYS kill =
# SIGKILL) leaves an mp4 without its moov atom (unplayable), while TS is
# self-contained per-packet. Remux to mp4 afterwards (rec-finish.sh).
# Usage: rec-start.sh [out.ts]   (run from the directory you want files in)
set -u
OUT="${1:-screen-$(date +%Y%m%d-%H%M%S).ts}"
BASE="$(basename "$OUT")"
DIR="$(dirname "$OUT")"
cd "$DIR" 2>/dev/null || true
ffmpeg -hide_banner -loglevel error -f gdigrab -framerate 25 -i desktop \
  -c:v libx264 -preset ultrafast -crf 23 -pix_fmt yuv420p "$OUT" > "$BASE.log" 2>&1 &
sleep 1
# pgrep is not available in git-bash and 'ps -C' does not match native names;
# resolve the PID via CIM, matching the gdigrab command line (so a concurrent
# yt-dlp ffmpeg is never confused with ours). No $_ — MSYS bash mangles it.
PID="$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation" 2>/dev/null | grep -F gdigrab | awk -F'","' '{print $1}' | tr -d '"' | head -1)"
echo "$PID" > rec.pid
echo "PID=$PID OUT=$OUT"
if [ -z "$PID" ]; then echo "WARNING: ffmpeg PID not found (check: Get-Process ffmpeg)"; fi
