# pi-skills

Pi agent skills for this machine. One package, multiple skills (conventional
`skills/<name>/` layout — pi auto-discovers each directory).

| Skill | What it does |
|---|---|
| `pi-supervisor` | Spawn a second pi agent as an RPC child for long autonomous tasks; supervision ladder (steer → rewind → fork) via `guard.mjs`; context-overflow detection with distill-and-relaunch pivot (v0.6.0); Docker, low-integrity sandbox, and dedicated-user variants. |
| `bug-hunting` | Structured methodology for hard bugs — differential reproduction, stage-by-stage ground-truth diffing, broken baseline + per-fix regression proofs, machine-checkable acceptance, verified-facts ledger — executed as supervised fresh-session runs via pi-supervisor. |
| `vpn-control` | Turn the AmneziaVPN desktop app on/off, check status, switch the active server (UI Automation, windowless). |
| `yt-download` | Download YouTube videos via yt-dlp: quality tiers (360p–best), exported cookies, bgutil PO tokens. |
| `screen-rec` | Record the Windows screen to video — full screen (ffmpeg gdigrab) or a single specific window (ffmpeg gfxcapture / Windows.Graphics.Capture), kill-proof .ts → clean .mp4 — and capture window stills without touching the foreground (PrintWindow; gfxcapture single-frame for GPU/DComp windows; foreground fallback for minimized). Window recording preflights the target and refuses minimized windows (gfxcapture hangs with zero frames on them). |

## Install

```sh
pi install git:github.com/Foxclip/pi-skills@v0.6.0
```

or add the pin `git:github.com/Foxclip/pi-skills@v0.6.0` to `packages` in
`~/.pi/agent/settings.json` (takes effect at the next session start).

## Notes

- Machine-specific (Windows + the AmneziaVPN GUI app; cookies/PO paths in the
  skill docs point at this machine's locations).
- VPN skill exit codes: `0` ok, `1` step failed, `2` app not running.
- `pi-supervisor` scripts need Node >= 22.19.
