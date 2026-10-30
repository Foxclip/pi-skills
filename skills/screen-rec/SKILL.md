---
name: screen-rec
description: Record the screen to video on Windows (ffmpeg gdigrab / gfxcapture) or X11 Linux (x11grab of the root window with in-user crop) — kill-proof .ts → clean .mp4 — and capture stills of specific windows without disturbing the user's foreground (PrintWindow; gfxcapture single-frame still for GPU/DComp windows; foreground fallback for minimized windows; root-crop PNG on X11). Use when the user asks to screen-record, record the desktop/screen, make a screen video, record/capture a specific window as video, or screenshot/capture a specific window (even a background or minimized one).
---

# screen-rec

Two platforms, same design (kill-proof .ts → remux to .mp4). Windows section
first (primary monitor 1920x1080, RTX 3090; ffmpeg 9.0.2 at
`C:\Users\Suburban\.pi\agent\bin\ffmpeg.exe`); X11 Linux section at the
bottom (Mint 22, DISPLAY :0). On each host, three modes:

1. **Capture** — still PNG of one or all windows, no focus change.
2. **Record** — full-screen video via `gdigrab`, kill-proof, remuxed to mp4.
3. **Record window** — video of ONE specific window via `gfxcapture`
   (Windows.Graphics.Capture), same kill-proof flow. Use this, not gdigrab
   window capture, for any modern (GPU/composited) app.

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
- GPU/DComp-rendered windows (Windows Terminal, Electron): PrintWindow goes
  BLACK on these. Preferred still path for a VISIBLE window = gfxcapture
  single-frame (no foreground change, FFmpeg 8.0+; bgra intermediate again
  mandatory — same d3d11 hw frames as video):
  ```sh
  ffmpeg -f lavfi -i "gfxcapture=hwnd=N:capture_cursor=0" -vf "hwdownload,format=bgra" -frames:v 1 out.png
  ```
  Minimized window (or ffmpeg < 8.0) → `cap-foreground.ps1` path above.
  WARNING: gfxcapture on a MINIMIZED window HANGS with zero frames (see
  Record window) — check state first when unsure:
  ```sh
  powershell -NoProfile -ExecutionPolicy Bypass -File skills/screen-rec/scripts/win-rect.ps1 -Hwnd N
  # prints: OK <hwnd> WxH | MINIMIZED <hwnd> WxH | NOTFOUND | BADHWND
  ```
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

## Record window (video)

One script, same modes/state as rec.sh (separate `rec-window.state` +
`win-*.ts` names, so it can't clash with a full-screen run):

```sh
cd <dir-for-files>
bash skills/screen-rec/scripts/rec-window.sh record [sec]    --hwnd N [--cursor]
bash skills/screen-rec/scripts/rec-window.sh start  [maxsec] --hwnd N [--cursor]
bash skills/screen-rec/scripts/rec-window.sh stop [ts]      # self-heals from rec-window.state
bash skills/screen-rec/scripts/rec-window.sh status
```

- Selector: `--hwnd N` (preferred — from `list-windows.ps1`, no non-ASCII
  title pasting) or `--title REGEX` (PCRE, `(?i)` for case-insensitive;
  ASCII-safe substring recommended). `--cursor` adds the mouse (default off).
- Engine: `gfxcapture` filter (Windows.Graphics.Capture API, FFmpeg 8.0+;
  present in the local 9.0.2 build). Captures at the WINDOW'S OWN SIZE
  (e.g. 1920x1040), no screen crop; the window need not be foreground.
  Under the hood: `-f lavfi -i "gfxcapture=hwnd=N:capture_cursor=0:max_framerate=25"
  -vf "hwdownload,format=bgra,format=yuv420p" -r 25 -c:v libx264 ...`.
- `format=bgra` between `hwdownload` and `format=yuv420p` is MANDATORY —
  raw output is d3d11 hw frames and direct `hwdownload,format=yuv420p`
  fails ("Invalid output format yuv420p for hwframe download").
- **Event-driven capture:** WGC delivers frames only while the window's
  content changes (up to max_framerate). pts are wall-clock, so motion
  paces correctly, but a long static UI yields a SHORT video (ends at the
  last content change). Keep the window active/animating during the take.
- **Minimized/hidden target = HANG, zero frames** — WGC only signals frame
  events on content updates and DWM stops compositing a minimized surface, so
  the filter initializes then waits forever (verified: Taskmgr + Windows
  Terminal minimized, no frame in 60s; no stale frame, no black frame).
  `rec-window.sh` now preflights the target via `win-rect.ps1` (the <=100x100
  minimized tell, same heuristic as cap-windows.ps1) and refuses with a
  clear error instead of starting a ffmpeg that would sit idle.
- Same .ts rules as rec.sh (kill-proof, watchdog, self-heal stop, ~1-2s
  loss at stop). Bad hwnd/title → clear error + exit 1, no state written.
- Do NOT use `gdigrab title=`/`hwnd=` for window video: it BitBlts the
  window's GDI DC = all-BLACK frames for GPU/composited apps (verified on
  Docker Desktop + Sound Blaster Command). Full-screen gdigrab is fine
  (composited desktop).

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

## Linux X11 (this host: Mint 22, DISPLAY :0)

Scripts in `scripts/linux/` — bash + ffmpeg x11grab, same kill-proof .ts →
remux-to-.mp4 design as the Windows side.

| Script | Purpose |
|---|---|
| `list-windows.sh` | DEC + HEX id, PID, geometry, mapped state |
| `cap-window.sh` | Window stills: `-w ID` / `-t ERE` / `-f [NAME]` / `-o DIR` (no args = all visible windows) |
| `rec.sh` | Full-screen video: `record [SEC]` / `start [MAXSEC]` / `stop` / `status` |
| `rec-window.sh` | Single-window video, same modes + `--window ID \| --title ERE` |

```sh
cd <dir-for-files>
bash scripts/linux/list-windows.sh
bash scripts/linux/rec.sh record 10                          # → rec-<ts>.mp4
bash scripts/linux/rec-window.sh record 10 --window 0x02600040   # or --title "ERE"
bash scripts/linux/cap-window.sh -w 0x02600040     # or -t "vim" ; -f name.png ; -o caps
```

### HARD SAFETY RULE — violating it hard-locks the whole machine (verified TWICE, both times required a reboot)
**Never** do per-window XGetImage on this box: no `ffmpeg -f x11grab -window_id …`,
no `import -window 0x…`, no per-window xwd — against anything, especially not
GLX/OpenGL windows. x11grab per-window froze the machine once; ImageMagick
`import -window` froze it a second time. All scripts here instead capture the
**root window** and crop in-user with libav — proven safe under long tests
(root XGetImage is fine; the hang is per-window capture on GLX surfaces).

### Design notes (Linux-specific gotchas, all verified on this host)

- `record` (one-shot) passes `-t SEC` → ffmpeg stops input itself and
  finalizes cleanly → **zero tail loss**. `start`/`stop` SIGTERMs ffmpeg →
  loses the x264 lookahead queue (~1–2s tail, documented).
- `-fflags +flush_packets` is REQUIRED on the ffmpeg line: without it a static
  screen buffers everything inside x264/avio and any kill loses ALL (0-byte .ts).
- ffmpeg must be launched as a **bare background command, never `func &`** —
  a wrapper subshell makes `$!` the wrapper, not ffmpeg: the kill orphans a
  zombie recorder and the state pid goes stale.
- Window geometry = `xwininfo` **Absolute** upper-left. xdotool
  `getwindowgeometry` and wmctrl are frame-relative (verified off by exactly
  the frame offset) — do not use them for cropping.
- Target preflight: the window must exist and be mapped (`IsViewable`);
  MINIMIZED → clean error (the Linux equivalent of the WGC minimized hang).
  Keep the window visible for the duration of the take (WYSIWYG rule).
- x11grab reads the root pixmap: the **X cursor is NOT in the recording**
  (same as gdigrab). No audio.
- The display can change size mid-session (observed 1920x1080 → 1920x974) —
  geometry is read at script start; a resize during a take kills that ffmpeg;
  just re-run.
- Outputs: `rec-<ts>.{ts,mp4}`, `win-<idhex>-<ts>.{ts,mp4}` in cwd; state in
  `rec.state` / `rec-window.state` (stop self-heals from them).
- `--window` takes decimal or `0x`-hex; `--title` is an ERE; multiple hits →
  error listing the candidates.
