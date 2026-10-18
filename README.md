# pi-skills

Pi agent skills for this machine. One package, multiple skills (conventional
`skills/<name>/` layout — pi auto-discovers each directory).

| Skill | What it does |
|---|---|
| `vpn-control` | Turn the AmneziaVPN desktop app on/off, check status, switch the active server (UI Automation, windowless). Replaces the older standalone `vpn-toggle` skill. |
| `yt-download` | Download YouTube videos via yt-dlp: quality tiers (360p–best), exported cookies, bgutil PO tokens. |

## Install

```sh
pi install git:github.com/Foxclip/pi-skills@v0.1.0
```

or add the pin `git:github.com/Foxclip/pi-skills@v0.1.0` to `packages` in
`~/.pi/agent/settings.json` (takes effect at the next session start).

## Notes

- Machine-specific (Windows + the AmneziaVPN GUI app; cookies/PO paths in the
  skill docs point at this machine's locations).
- VPN skill exit codes: `0` ok, `1` step failed, `2` app not running.
