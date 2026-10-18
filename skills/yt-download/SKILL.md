---
name: yt-download
description: Download YouTube videos on this machine using yt-dlp — quality tiers, cookies, and bgutil PO tokens. Use when the user asks to download, save, or archive a YouTube video (or its audio), or to list a video's available formats.
---

# yt-download

Downloads YouTube videos via yt-dlp with the flags that actually work on this
machine (cookies + bgutil PO tokens + a format selector that survives
DASH-only stream sets).

## Requirements

- yt-dlp — on this machine: `python -m yt_dlp` (Python 3.14, yt-dlp 2026.08.19)
- ffmpeg on PATH (needed to merge video+audio DASH streams)
- node on PATH (only when using `--po`, for the bgutil plugin)
- Exported youtube.com cookies file (Netscape format)
- bgutil PO-provider server home (built): `C:\Users\Suburban\bgutil-ytdlp-pot-provider\server`

## Usage (this machine)

```sh
# Full quality ≤1080p, MP4, with metadata + log written next to the video
skills/yt-download/scripts/yt-download.sh "https://www.youtube.com/watch?v=VIDEO_ID" \
  --quality 1080 \
  --cookies "E:\Downloads\youtube.com_cookies.txt" \
  --po "C:\Users\Suburban\bgutil-ytdlp-pot-provider\server" \
  --out "D:\Videos"

# Lower tier (smaller/faster)
skills/yt-download/scripts/yt-download.sh "URL" --quality 360 --cookies "..." --po "..." --out DIR

# Inspect available formats first (no download)
skills/yt-download/scripts/yt-download.sh "URL" --list --cookies "..." --po "..."
```

Outputs into `--out`: `<title> [id].mp4`, `<title> [id].info.json`,
`.yt-download.log`. The cookies file may be rewritten in place by yt-dlp
(cookie refresh) — that's normal.

## Pitfalls (why the script does what it does)

- **Format selectors**: stream sets here are DASH-only — no merged formats, and
  format 18 doesn't exist. A selector with a missing explicit id (e.g.
  `18/best[...]`) HARD-FAILS with "Requested format is not available"; a bare
  `best`/`b` matches nothing. The script therefore uses merge candidates only:
  `bv*[vcodec^=avc1][height<=N]+ba[ext=m4a]/bv*[height<=N]+ba[ext=m4a]/bv*[height<=N]+ba`.
- **Bot-blocked egress**: "Sign in to confirm you're not a bot" means the
  *egress IP* is blocked by YouTube's player API, not that cookies are bad.
  On this machine: the Netherlands Amnezia server and the direct RU line are
  blocked; the **Poland** server works. Switch egress (see vpn-control skill)
  and retry — the script's error path prints this hint.
- **Player client**: this yt-dlp build (2026.08.19) ignores the
  `player_client` extractor-arg and always uses the visionos client. Don't
  bother passing it.
- **Cookies warnings**: "rotated"/"invalid cookie" warnings can appear and the
  download still succeed (format 134 DASH worked despite them).
- **PO provider**: requires `--js-runtimes node:<path>` (the script adds it
  automatically with the node it finds on PATH) and a *built* server home
  (`server/build/` must exist — `node generate_once.js` style build, done).
- **ffmpeg**: without it the `bv*+ba` merge fails; the script warns. A
  single-format fallback (`--format 134` etc.) avoids merging but has no audio
  when video-only — prefer fixing ffmpeg.

## Exit codes

`0` = downloaded (or listed) OK; `64` = usage error; `69` = missing yt-dlp /
node; otherwise yt-dlp's own exit code (check `.yt-download.log` in `--out`).
