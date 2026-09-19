#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  OmniRoute Reconciled Build & Deploy Script
#  Builds from the reconciled clean repository at:
#  /mnt/devvm/custom/omniroute-uc-maxai-reconcile-9492357/repo
#
#  Applies high ulimits (nofile=1048576, nproc=247058)
#  Builds omniroute:raw -> omniroute:base -> restarts omniroute container
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="/mnt/devvm/custom/omnirouter"
RECONCILE_SRC="/mnt/devvm/custom/omniroute-uc-maxai-reconcile-9492357/repo"
BIN_DIR="$ROOT/bin"
WORKSPACE="$ROOT/workspace"
BUILD_NOFILE_LIMIT="${OMNIROUTE_BUILD_NOFILE_LIMIT:-1048576:1048576}"

log() { echo "[deploy-reconciled] $*"; }

log "Checking source directory: $RECONCILE_SRC"
cd "$RECONCILE_SRC" || { echo "[deploy-reconciled] FATAL: $RECONCILE_SRC missing" >&2; exit 1; }

# ── 1. Build raw image from reconciled fork ────────────────────────────
log "Building omniroute:raw from reconciled repository..."
podman build \
  --ulimit "nofile=$BUILD_NOFILE_LIMIT" \
  --target runner-base \
  -t localhost/omniroute:raw \
  .

# ── 2. Apply ESM fix layer -> omniroute:base ───────────────────────────
log "Applying ESM fix layer -> omniroute:base..."
podman build \
  --ulimit "nofile=$BUILD_NOFILE_LIMIT" \
  -f "$BIN_DIR/omniroute-fix.Containerfile" \
  -t localhost/omniroute:base \
  "$BIN_DIR"

# ── 3. Workspace ownership check ───────────────────────────────────────
mkdir -p "$WORKSPACE/redis"
log "Setting workspace ownership to ndsadmin (uid/gid 400)..."
chown -R 400:400 "$WORKSPACE" 2>/dev/null || podman unshare chown -R 0:0 "$WORKSPACE"

# ── 4. Recreate the container with the newly built image ─────────────
log "Removing old container instance to bind newly built image..."
podman rm -f omniroute omniroute-redis omni-ts-egress >/dev/null 2>&1 || true

log "Starting recreated omniroute stack with newly built image..."
cd "$ROOT/src"
"$BIN_DIR/omniroute-up.sh"

# ── 5. Health verification ─────────────────────────────────────────────
log "Waiting for OmniRoute health check on port 20128..."
for i in {1..30}; do
  if curl -sf http://127.0.0.1:20128/api/healthz >/dev/null 2>&1 || curl -sf http://127.0.0.1:20128/ >/dev/null 2>&1; then
    log "SUCCESS: OmniRoute container is healthy and serving on port 20128!"
    exit 0
  fi
  sleep 1
done

log "WARNING: Container restarted but healthz check timed out after 30s. Check logs with 'podman logs omniroute'."
