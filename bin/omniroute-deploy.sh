#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  OmniRoute deploy / rebuild (rootless podman, this EC2 box).
#
#  Full rebuild pipeline. Run this after pulling new commits into the fork,
#  or on first setup. It is NOT run at boot (boot just starts the containers).
#
#    1. Build the raw image straight from the fork Dockerfile  -> omniroute:raw
#    2. Apply the local ESM-crash fix layer on top             -> omniroute:base
#       (compose references omniroute:base, so this is what runs)
#    3. Ensure the external workspace is owned by the container user
#       (rootless UID 1000 -> host subuid 231072+999) so /app/data is writable
#
#  Keeping the fix as a derived layer (not a source edit) means the fork at
#  src/ stays clean for upstream PRs. When upstream ships the packaging fix,
#  delete the fix layer and retag raw->base directly.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="/mnt/devvm/custom/omnirouter"
SRC_DIR="$ROOT/src"
BIN_DIR="$ROOT/bin"
WORKSPACE="$ROOT/workspace"
PROFILE="base"

log() { echo "[omniroute-deploy] $*"; }

cd "$SRC_DIR" || { echo "[omniroute-deploy] FATAL: $SRC_DIR missing" >&2; exit 1; }

# ── 1. Raw image from the fork (heavy multi-stage build) ──────────────
log "building omniroute:raw from fork Dockerfile (target=runner-base)..."
podman build --target runner-base -t localhost/omniroute:raw . 

# ── 2. Apply local ESM fix layer -> omniroute:base ────────────────────
log "applying ESM fix layer -> omniroute:base"
podman build -f "$BIN_DIR/omniroute-fix.Containerfile" -t localhost/omniroute:base "$BIN_DIR"

# ── 3. Workspace ownership: host ndsadmin (uid/gid 400) ───────────────
# The override runs both containers with keep-id userns, mapping the app's
# `node` (uid 1000) and redis's root (uid 0) onto host uid/gid 400. So the
# workspace must be owned by 400 on the host for the containers to write it,
# and 400 IS ndsadmin, so these files are directly editable with no friction.
mkdir -p "$WORKSPACE/redis"
log "setting workspace ownership to ndsadmin (uid/gid 400)"
chown -R 400:400 "$WORKSPACE" 2>/dev/null \
  || podman unshare chown -R 0:0 "$WORKSPACE"   # fallback if any files sit outside our range

log "deploy complete. Image omniroute:base is ready."
log "start with: systemctl --user start omniroute   (or $BIN_DIR/omniroute-up.sh)"
