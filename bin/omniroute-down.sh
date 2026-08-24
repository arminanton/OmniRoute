#!/usr/bin/env bash
# Graceful stop for the OmniRoute stack (called by systemd ExecStop).
# Stops but does NOT remove the containers, so the next boot can `podman start`
# them instead of rebuilding. compose down would delete them; we don't want that.
set -uo pipefail

APP="omniroute"
REDIS="omniroute-redis"

echo "[omniroute-down] stopping $APP"
podman stop -t 40 "$APP"   2>/dev/null || true
echo "[omniroute-down] stopping $REDIS"
podman stop -t 40 "$REDIS" 2>/dev/null || true
exit 0
