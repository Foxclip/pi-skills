#!/usr/bin/env bash
# yt-download.sh — download a YouTube video via yt-dlp (quality tier, cookies, PO tokens).
# See ../SKILL.md for machine-specific paths and known pitfalls.
#
# Usage:
#   yt-download.sh <URL> [options]
#
# Options:
#   --quality 360|480|720|1080|best   height cap / best available (default: 1080)
#   --out DIR                          output directory (default: cwd)
#   --cookies FILE                     Netscape cookies file (recommended)
#   --po DIR                          bgutil PO-provider server home (recommended)
#   --format SPEC                      override the format selector entirely
#   --list                             list available formats and exit (no download)
#   -h, --help
#
# Exit codes: yt-dlp's exit code, or 64 (usage) / 69 (missing dependency).

set -u

URL="" QUALITY="1080" OUT="." COOKIES="" PO="" FMT_OVERRIDE="" LIST=0

while [ $# -gt 0 ]; do
  case "$1" in
    --quality)   QUALITY="$2"; shift 2 ;;
    --out)       OUT="$2"; shift 2 ;;
    --cookies)   COOKIES="$2"; shift 2 ;;
    --po)        PO="$2"; shift 2 ;;
    --format)    FMT_OVERRIDE="$2"; shift 2 ;;
    --list)      LIST=1; shift ;;
    -h|--help)   sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)          echo "unknown option: $1" >&2; exit 64 ;;
    *)           [ -n "$URL" ] && { echo "unexpected argument: $1" >&2; exit 64; }
                 URL="$1"; shift ;;
  esac
done

[ -n "$URL" ] || { echo "usage: yt-download.sh <URL> [options] — see --help" >&2; exit 64; }
case "$QUALITY" in 360|480|720|1080|best) ;;
  *) echo "invalid --quality: $QUALITY (want 360|480|720|1080|best)" >&2; exit 64 ;; esac

# --- locate yt-dlp (binary, python module, or Windows py launcher) ---
if command -v yt-dlp >/dev/null 2>&1; then
  YTDLP="yt-dlp"
elif command -v python >/dev/null 2>&1 && python -m yt_dlp --version >/dev/null 2>&1; then
  YTDLP="python -m yt_dlp"
elif command -v py >/dev/null 2>&1 && py -3 -m yt_dlp --version >/dev/null 2>&1; then
  YTDLP="py -3 -m yt_dlp"
else
  echo "error: yt-dlp not found (tried: yt-dlp, python -m yt_dlp, py -3 -m yt_dlp)" >&2
  exit 69
fi

# --- format selector ---------------------------------------------------------
# Stream sets are DASH-only (video-only + audio-only); a bare `best`/`b` matches
# MERGED formats only, and an explicit numeric id (e.g. 18) HARD-FAILS the whole
# selector when absent from the set. Hence: merge candidates (bv* + ba) with a
# height cap, avc1/m4a preferred.
if [ -z "$FMT_OVERRIDE" ]; then
  if [ "$QUALITY" = "best" ]; then
    FMT='bv*[vcodec^=avc1]+ba[ext=m4a]/bv*+ba[ext=m4a]/bv*+ba'
  else
    FMT="bv*[vcodec^=avc1][height<=$QUALITY]+ba[ext=m4a]/bv*[height<=$QUALITY]+ba[ext=m4a]/bv*[height<=$QUALITY]+ba"
  fi
fi

# --- PO provider (bgutil) needs a JS runtime ---
NODE=""
if [ -n "$PO" ]; then
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || { echo "error: --po given but node not found on PATH" >&2; exit 69; }
  [ -d "$PO" ] || { echo "error: --po dir not found: $PO" >&2; exit 69; }
  # git-bash returns /c/... paths, which the Windows yt-dlp process cannot exec
  if command -v cygpath >/dev/null 2>&1; then
    NODE="$(cygpath -w "$NODE")"
  fi
fi

command -v ffmpeg >/dev/null 2>&1 || \
  echo "warning: ffmpeg not found on PATH — merging video+audio will fail" >&2

mkdir -p "$OUT" || exit 1

args=(--no-playlist)
[ -n "$COOKIES" ] && args+=(--cookies "$COOKIES")
if [ -n "$PO" ]; then
  args+=(--js-runtimes "node:$NODE"
         --extractor-args "youtubepot-bgutilscript:server_home=$PO")
fi
if [ "$LIST" = 1 ]; then
  args+=(--list-formats)
else
  args+=(-f "$FMT" --merge-output-format mp4 --write-info-json
         --windows-filenames -o "$OUT/%(title)s [%(id)s].%(ext)s")
fi

read -r -a YTDLP_ARR <<< "$YTDLP"
cmd=("${YTDLP_ARR[@]}" "${args[@]}" "$URL")

tmp="$(mktemp)"
"${cmd[@]}" >"$tmp" 2>&1; rc=$?
cat "$tmp"
cp "$tmp" "$OUT/.yt-download.log" 2>/dev/null || true

if [ $rc -ne 0 ]; then
  if grep -q "confirm you're not a bot" "$tmp"; then
    {
      echo ""
      echo "NOTE: YouTube bot-blocked this egress IP ('Sign in to confirm you're not a bot')."
      echo "      Use a different egress (e.g. another VPN server) and retry."
    } >&2
  fi
fi
rm -f "$tmp"
exit $rc
