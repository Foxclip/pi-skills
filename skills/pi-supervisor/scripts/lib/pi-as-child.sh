#!/bin/sh
# v0.26.0 kernel protection: run pi AS the protected child user.
# ralph.sh passes THIS file as the --pi target for the monitor's parent
# sessions (judgment + final report) when the run is protected: the owner's
# monitor then runs its pi turns through the scoped passwordless sudo rule
# instead of directly.
#
# ralph.sh writes the real pi path to $PI_SUP_PI_ABS_FILE at bootstrap.
# The invocation shells through the scoped /bin/sh rule to fix up PATH first —
# sudo's secure_path is a fixed system list and does not know the owner's
# pi bin dir, and env_reset would drop an exported PATH anyway.
u="${PI_SUP_CHILD_USER:-pichild}"
absf="${PI_SUP_PI_ABS_FILE:-}"
abs="$(cat "$absf" 2>/dev/null)"
if [ -z "$abs" ]; then
  echo "pi-as-child: $absf is missing or empty — kernel protection not applied? (ralph.sh bootstrap writes it)" >&2
  exit 69
fi
bindir="$(dirname "$abs")"
exec sudo -n -u "$u" /bin/sh -c "export PATH=\"$bindir\":\$PATH; exec \"$abs\" \"\$@\"" _ "$@"
