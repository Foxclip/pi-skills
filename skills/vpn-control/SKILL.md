---
name: vpn-control
description: Turn the Amnezia VPN on, off, or check its status on this Windows machine while the AmneziaVPN GUI app is running, and switch the active VPN server. Use when the user asks to enable/disable/toggle the VPN, route traffic through the VPN, check whether the VPN is connected, or switch the VPN server (e.g. to Poland or the Netherlands).
---

# VPN control (AmneziaVPN, Windows)

Controls the running AmneziaVPN desktop app (v5.x, Qt GUI at `C:\Program Files\AmneziaVPN\`)
via Windows UI Automation — fully windowless (no foregrounding, no mouse, no screen capture).
No CLI mode exists in the app; the service IPC is internal Qt D-Bus.

- `vpn.ps1` / `vpn.sh` — connect/disconnect/status via the connect button's stable
  AutomationId `AmneziaApplication.mainWindow.tabBarStackView.connectButton`
  (button name is `Connected` when up, `Connect` when down).
- `vpn-server.ps1` — switch the active server: disconnect (Amnezia refuses server
  changes while connected) → open the server picker (invoke the server button in the
  connect bar) → select the country via `SelectionItemPattern` → verify → optional reconnect.

## Usage

From bash (Git Bash / MSYS):

```sh
scripts/vpn.sh status                  # prints "Connected" or "Connect", never clicks
scripts/vpn.sh on                      # connect (no-op if already connected)
scripts/vpn.sh off                     # disconnect (no-op if already disconnected)
scripts/vpn.sh server Poland           # switch server; app is left DISCONNECTED
scripts/vpn.sh server Poland --reconnect   # switch AND stay connected
```

Or directly with PowerShell:

```sh
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/vpn.ps1 on|off|status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/vpn-server.ps1 -Server Poland -Reconnect
```

Exit codes: `0` = OK (target state reached), `1` = step failed / state not reached in time,
`2` = AmneziaVPN window not found (app not running).

## Notes

- The AmneziaVPN GUI app **must be running** (`AmneziaVPN.exe` process). If exit code 2,
  tell the user the app is not running; do not try to start it yourself.
- Server names must match the app exactly (e.g. `Netherlands`, `Poland`).
- Verify actual network effect when it matters, e.g.
  `curl -s -m 10 -o /tmp/eg.json https://ipinfo.io/json` and inspect the file.
  (Egress IPs depend on the selected server and its ISP — check live if the exact IP matters.)
- **YouTube egress quirk (2026-10):** the NL server IP is bot-blocked by YouTube's player
  API ("Sign in to confirm you're not a bot" on every player client) — for yt-dlp downloads
  switch to the PL server first; the direct RU egress is blocked too.
- Known behavior: instagram.com is reachable only WITH the VPN (ISP blocks it),
  vl.ru is reachable only WITHOUT the VPN (site blocks the VPN exit IP).
- **If the app UI gets stuck** (picker left open, or an unrelated panel shown): invoke
  `AmneziaApplication.mainWindow.tabBar.homeTabButton` (UIA InvokePattern) — it always resets
  the view to the connect bar. `vpn-server.ps1` does this automatically.
  Never invoke the two unnamed `ImageButtonType_*` elements in the bar — one of them
  navigates to the key panel.
- Server switching only works when the app is fully disconnected (wait for the button to
  read exactly `Connect`; a mid-`Disconnecting...` transition makes the picker stick open).
