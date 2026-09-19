#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  OmniRoute Reconciled Build & Deploy Script
#  Builds from the canonical OmniRoute checkout at:
#  /mnt/devvm/custom/omnirouter/src
#  The checkout must be clean and on branch `next` unless an explicit ref is supplied.
#
#  LEGACY CONTROLLED-RECREATE HELPER: this has brief downtime and is not true hot-swap.
#  Applies high nofile ulimit (1048576)
#  Builds omniroute:raw -> omniroute:base -> restarts omniroute container
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="/mnt/devvm/custom/omnirouter"
SRC_DIR="$ROOT/src"
TARGET_REF="${1:-next}"
BIN_DIR="$ROOT/bin"
WORKSPACE="$ROOT/workspace"
BUILD_NOFILE_LIMIT="${OMNIROUTE_BUILD_NOFILE_LIMIT:-1048576:1048576}"

log() { echo "[deploy-reconciled] $*"; }

log "Checking canonical source directory: $SRC_DIR"
cd "$SRC_DIR" || { echo "[deploy-reconciled] FATAL: $SRC_DIR missing" >&2; exit 1; }
CURRENT_BRANCH="$(git branch --show-current)"
CURRENT_HEAD="$(git rev-parse HEAD)"
TARGET_SHA="$(git rev-parse "$TARGET_REF")"
if [ -n "$(git status --porcelain)" ]; then
  echo "[deploy-reconciled] FATAL: source tree is dirty" >&2
  exit 1
fi
if [ "$TARGET_REF" = "next" ] && [ "$CURRENT_BRANCH" != "next" ]; then
  echo "[deploy-reconciled] FATAL: default deployment requires checked-out branch next (current=$CURRENT_BRANCH)" >&2
  exit 1
fi
if [ "$CURRENT_HEAD" != "$TARGET_SHA" ]; then
  echo "[deploy-reconciled] FATAL: explicit target $TARGET_REF is not checked out; use a dedicated worktree/candidate builder" >&2
  exit 1
fi
log "Building source $TARGET_REF at $TARGET_SHA"

# ── 1. Build raw image from canonical next ─────────────────────────────
log "Building omniroute:raw from canonical source..."
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
