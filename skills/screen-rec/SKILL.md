---
name: screen-rec
description: Record the Windows screen to video (ffmpeg gdigrab, kill-proof .ts → clean .mp4) and capture stills of specific windows without disturbing the user's foreground (PrintWindow, with a foreground fallback for minimized/GPU-rendered windows). Use when the user asks to screen-record, record the desktop/screen, make a screen video, or screenshot/capture a specific window (even a background or minimized one).
---

# screen-rec

Two modes, both proven on this machine (Windows, primary monitor 1920x1080,
RTX 3090; ffmpeg 9.0.2 at `C:\Users\Suburban\.pi\agent\bin\ffmpeg.exe`):

1. **Capture** — still PNG of one or all windows, no focus change.
2. **Record** — full-screen video via `gdigrab`, kill-proof, remuxed to mp4.

## Capture (stills)

```sh
# 1. Find windows (Name / Hwnd / Title)
powershell -NoProfile -File skills/screen-rec/scripts/list-windows.ps1

# 2. PrintWindow capture — no foreground change, works on background windows
#    (incl. Electron: Chrome, Docker Desktop). No args = all main windows.
powershell -NoProfile -ExecutionPolicy Bypass -File skills/screen-rec/scripts/cap-windows.ps1 -OutDir caps -Targets 3673776,265058:chrome
# Targets: "<hwnd>", "<hwnd>:<label>", or a process name. Output: caps/cap-<name>.png
```

- **Minimized tell:** a capture that comes back `160x28` (or the script prints
  `minimized/hidden`) = titlebar only. That window needs the foreground path:
  ```sh
  # Restore + foreground (ALT-key trick bypasses the foreground lock) +
  # CopyFromScreen + put the previous foreground window back (-RestoreHwnd).
  powershell -NoProfile -ExecutionPolicy Bypass -File skills/screen-rec/scripts/cap-foreground.ps1 -Hwnd 69232 -Out caps/term.png -RestoreHwnd 790610
  ```
- GPU/DComp-rendered windows (Windows Terminal) are also only reliably
  captured via `cap-foreground.ps1` (CopyFromScreen), not PrintWindow.
- Non-ASCII titles come out mojibake'd in the console (code page) — identify
  windows by `Hwnd`/process name, never by pasting title text back.
- After any capture, read the PNG with the `read` tool to verify/inspect.

## Record (video)

```sh
cd <dir-for-files>
bash skills/screen-rec/scripts/rec-start.sh            # → PID=<pid> OUT=screen-<ts>.ts
# ... let it run; do the thing ...
bash skills/screen-rec/scripts/rec-finish.sh screen-<ts>.ts
# → kills ffmpeg (via rec.pid), audits, trims corrupted tail if any,
#   remuxes to screen-<ts>.mp4, prints audit + probe (duration/size/frames).
```

Rules / why:

- **Record to `.ts`, never `.mp4`.** Hard kill = no moov atom = unplayable
  mp4. TS needs no trailer; remux (`-c copy`) writes a proper one.
- Stop via `rec-finish.sh` (kills the exact ffmpeg PID from `rec.pid`).
  Never `Stop-Process -Name ffmpeg` if other ffmpeg could be running (yt-dlp
  merges).
- The audit in `rec-finish.sh` is the acceptance check: **empty audit =
  clean**. A hard kill clips the in-flight TS packet (one corrupted
  macroblock at the tail) — the script trims at the last clean pts (costs
  <1 s at the very end).
- 25 fps gdigrab keeps up fine at 1080p on this machine.

## Pitfalls (all hit in production)

- `nohup ffmpeg ... & echo $!` can capture a WRAPPER shell PID, not ffmpeg's
  — that's why `rec-start.sh` resolves the real PID with `pgrep`.
- MSYS bash mangles `$_` in inline `powershell -Command` strings → always use
  these script files, never one-liners with `$_`.
- Audio is NOT captured (gdigrab is video-only). For system audio add a
  second `dshow` input (Stereo Mix) — untested here.
- Recovery of an already-killed mp4 (no moov): x264 NALs survive in `mdat`,
  but SPS/PPS live only in moov/avcC — not reliably recoverable. That's why
  the .ts rule exists.
