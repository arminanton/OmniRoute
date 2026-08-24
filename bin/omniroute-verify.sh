#!/usr/bin/env bash
set -uo pipefail
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

echo "══════════════════════════════════════════════════════════════"
echo " OmniRoute deployment: final verification"
echo "══════════════════════════════════════════════════════════════"

echo ""
echo "── 1. Containers (both should be Up + healthy) ──"
podman ps --filter name=omniroute --format '{{.Names}}  {{.Status}}  {{.Ports}}'

echo ""
echo "── 2. HTTP endpoints ──"
curl -s -o /dev/null -w "  dashboard :20128 -> HTTP %{http_code}\n" http://127.0.0.1:20128/ --max-time 10

echo ""
echo "── 3. systemd autostart unit ──"
echo "  enabled: $(systemctl --user is-enabled omniroute.service)"
echo "  active:  $(systemctl --user is-active omniroute.service)"
echo "  linger:  $(loginctl show-user ndsadmin 2>/dev/null | grep -oE 'Linger=(yes|no)')"

echo ""
echo "── 4. UID/GID mapping (workspace must be ndsadmin 400:400) ──"
stat -c '  %n -> %U:%G (%u:%g)' /mnt/devvm/custom/omnirouter/workspace
stat -c '  %n -> %U:%G (%u:%g)' /mnt/devvm/custom/omnirouter/workspace/storage.sqlite
stat -c '  %n -> %U:%G (%u:%g)' /mnt/devvm/custom/omnirouter/workspace/redis

echo ""
echo "── 5. Container userns mode (keep-id via annotation) ──"
echo "  omniroute:       $(podman inspect omniroute --format '{{index .Config.Annotations "io.podman.annotations.userns"}}')"
echo "  omniroute-redis: $(podman inspect omniroute-redis --format '{{index .Config.Annotations "io.podman.annotations.userns"}}')"

echo ""
echo "── 6. ndsadmin can write workspace directly ──"
if touch /mnt/devvm/custom/omnirouter/workspace/.verify_write 2>/dev/null; then
  echo "  YES (removing test file)"
  rm -f /mnt/devvm/custom/omnirouter/workspace/.verify_write
else
  echo "  NO — permission problem!"
fi

echo ""
echo "── 7. Git / fork wiring ──"
cd /mnt/devvm/custom/omnirouter/src
echo "  branch:   $(git branch --show-current)"
echo "  origin:   $(git remote get-url origin)"
echo "  upstream: $(git remote get-url upstream)"
echo "  push as:  $(gh auth token -u arminanton >/dev/null 2>&1 && GITHUB_TOKEN="$(gh auth token -u arminanton)" gh api user --jq .login 2>&1)"

echo ""
echo "── 8. Isolation: override + .env gitignored ──"
git check-ignore docker-compose.override.yml .env >/dev/null 2>&1 && echo "  YES — neither leaks into PRs" || echo "  WARNING — something is tracked"

echo ""
echo "══════════════════════════════════════════════════════════════"
