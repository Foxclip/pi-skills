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

One script, three modes:

```sh
cd <dir-for-files>
bash skills/screen-rec/scripts/rec.sh record [SEC]    # one-shot: default 10s → .mp4
bash skills/screen-rec/scripts/rec.sh start [MAXSEC]  # long-run: default 600s safety net
# ... do the thing ...
bash skills/screen-rec/scripts/rec.sh stop             # kill + trim + remux → .mp4
bash skills/screen-rec/scripts/rec.sh status           # pid / out path / live?
```

**Agent-death safety** (start and stop may be in different calls/sessions):
- `start` spawns a watchdog that auto-kills ffmpeg at the MAXSEC deadline.
- `stop` self-heals from `rec.state` (pid + absolute .ts path, cwd-scoped):
  kill if still alive, then trim + remux. Works even if the original call is
  gone — the .ts is already on disk.
- Worst case: ffmpeg was already killed (watchdog) and no one ran `stop` —
  `rec.state` + the .ts remain; a later `rec.sh stop` finishes the job.

Rules / why:

- **Record to `.ts`, never `.mp4`.** Hard kill = no moov atom = unplayable
  mp4. TS needs no trailer; the stop path remuxes (`-c copy`) to write a
  proper one.
- Kills target the exact ffmpeg PID resolved from the CIM CommandLine
  (scoped to the .ts name). Never blanket `taskkill ffmpeg.exe` (yt-dlp
  merges could die).
- `-vf fps=25` is REQUIRED: gdigrab captures at the display's rate (variable,
  ~20-60fps here) and `-framerate 25` only stamps pts. Decimation fixes
  pacing and keeps hard-kill loss <1s; without it footage plays at the wrong
  speed and multi-second encoder queues are lost on kill.
- The .ts can stay invisible for several seconds (both at start and after
  kill — OS write-back). `stop` waits up to 10s before declaring it missing.
- Expected loss at stop: ~1-2s (encoder queue + OS buffer + the clipped
  tail packet the trim drops).

## Pitfalls (all hit in production)

- `ffmpeg ... &` does NOT let `$!` identify ffmpeg reliably (wrapper shell
  PIDs) — resolve the real PID from the CIM CommandLine (the .ts name is a
  unique token).
- This git-bash has NO `pgrep`, and `ps -C name` does not match native exe
  names — enumerate with `Get-CimInstance Win32_Process` + grep.
- MSYS bash mangles `$_` in inline `powershell -Command` strings → always use
  these script files, never one-liners with `$_`.
- `ls` can miss the .ts for seconds (write-back lag) — judge liveness via
  `rec.sh status` (the LIVE line), not directory listings.
- Audio is NOT captured (gdigrab is video-only). For system audio add a
  second `dshow` input (Stereo Mix) — untested here.
- Recovery of an already-killed mp4 (no moov): x264 NALs survive in `mdat`,
  but SPS/PPS live only in moov/avcC — not reliably recoverable. That's why
  the .ts rule exists.
