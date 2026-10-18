#!/bin/sh
# vpn.sh on|off|status — toggle the Amnezia VPN (see ../SKILL.md)
# vpn.sh server <Country> [--reconnect] — switch the active server (see ../SKILL.md)
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$1" = "server" ]; then
  shift
  [ -n "$1" ] || { echo "usage: vpn.sh server <Country> [--reconnect]" >&2; exit 1; }
  SRV="$1"; shift
  if [ "$1" = "--reconnect" ]; then
    exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$DIR/vpn-server.ps1" -Server "$SRV" -Reconnect
  fi
  exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$DIR/vpn-server.ps1" -Server "$SRV"
fi
exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$DIR/vpn.ps1" "$1"
