#!/usr/bin/env bash
# snapshot.sh — refresh the local-overrides branch from the live on-box infra.
#
# The infra lives OUTSIDE the repo (bin/ is a sibling of src/), so this script
# copies the current on-box files into a checkout of THIS branch and commits.
#
# Usage (from a worktree checked out on local-overrides):
#   bash snapshot.sh && git add -A && git commit -m "snapshot: <what changed>"
#
# Or fully automated:
#   bash snapshot.sh --commit "snapshot: 2026-08-24 kill-switch + app failover"
set -euo pipefail

ROOT="/mnt/devvm/custom/omnirouter"
HERE="$(cd "$(dirname "$0")" && pwd)"   # the local-overrides worktree

echo "[snapshot] copying bin/ ..."
mkdir -p "$HERE/bin"
cp -a "$ROOT/bin/." "$HERE/bin/"

echo "[snapshot] copying systemd user units ..."
mkdir -p "$HERE/systemd-user"
for u in omniroute omniroute-egress-failover omniroute-app-egress-failover omniroute-codex-egress; do
  cp -a "$HOME/.config/systemd/user/${u}.service" "$HERE/systemd-user/" 2>/dev/null || true
done

echo "[snapshot] copying gitignored docker-compose.override.yml ..."
cp -a "$ROOT/src/docker-compose.override.yml" "$HERE/" 2>/dev/null || true

echo "[snapshot] done. Review with 'git status' then commit."

if [ "${1:-}" = "--commit" ]; then
  cd "$HERE"
  git add -A
  git commit -m "${2:-snapshot: refresh local-overrides}" && echo "[snapshot] committed."
fi
