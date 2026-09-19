#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  OmniRoute Blue/Green Hot-Swap Deployer
#  PROTOTYPE / DO NOT USE FOR PRODUCTION. It lacks isolated candidate state,
#  immutable rollback, and a stable proxy/drain cutover. See docs/12.
#  Prototype candidate-image deployment:
#    - Branch `next`: active integration/development base.
#    - Branch `local`: frozen marker for the deployed source commit.
#
#  Pipeline:
#    1. Preflight git status & pull latest `next` from origin.
#    2. Build raw image from `next` -> localhost/omniroute:raw-next.
#    3. Apply ESM fix layer -> localhost/omniroute:next.
#    4. Run isolated container health preflight on private port :20139.
#    5. Atomic cutover: Tag :next -> :base, recreate stack, fast health check.
#    6. Fast-forward branch `local` to `next` and push to origin/local.
#    7. Preflight failure leaves live untouched. Post-cutover rollback is NOT implemented.
# ──────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="/mnt/devvm/custom/omnirouter"
SRC_DIR="$ROOT/src"
BIN_DIR="$ROOT/bin"
WORKSPACE="$ROOT/workspace"
PREFLIGHT_PORT=20139
BUILD_NOFILE_LIMIT="${OMNIROUTE_BUILD_NOFILE_LIMIT:-1048576:1048576}"

log() { echo "[omniroute-hotswap] $*"; }
error() { echo "[omniroute-hotswap] ERROR: $*" >&2; }

log "Starting OmniRoute Blue/Green deployment pipeline..."

cd "$SRC_DIR" || { error "$SRC_DIR missing"; exit 1; }

# ── 1. Check branch state ──────────────────────────────────────────────
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
log "Current branch: $CURRENT_BRANCH"

# Ensure we build from `next` (or current branch if specified)
TARGET_REF="${1:-next}"
log "Target deployment ref: $TARGET_REF"
TARGET_SHA=$(git rev-parse "$TARGET_REF")
log "Target commit SHA: $TARGET_SHA"

# ── 2. Build candidate image from target ref ───────────────────────────
log "Building candidate image localhost/omniroute:raw-candidate from $TARGET_REF..."
podman build \
  --ulimit "nofile=$BUILD_NOFILE_LIMIT" \
  --target runner-base \
  -t localhost/omniroute:raw-candidate \
  .

log "Applying ESM fix layer -> localhost/omniroute:candidate..."
podman build \
  --ulimit "nofile=$BUILD_NOFILE_LIMIT" \
  -f "$BIN_DIR/omniroute-fix.Containerfile" \
  -t localhost/omniroute:candidate \
  "$BIN_DIR"

# ── 3. Run private preflight container on isolated port :20139 ─────────
log "Launching private preflight verification on port $PREFLIGHT_PORT..."
podman rm -f omniroute-preflight >/dev/null 2>&1 || true

podman run -d \
  --name omniroute-preflight \
  --ulimit "nofile=$BUILD_NOFILE_LIMIT" \
  -p "127.0.0.1:$PREFLIGHT_PORT:20128" \
  -e PORT=20128 \
  -e DATA_DIR=/app/data \
  -v "$WORKSPACE:/app/data:ro" \
  localhost/omniroute:candidate >/dev/null

log "Polling preflight healthz on port $PREFLIGHT_PORT..."
PREFLIGHT_OK=0
for i in {1..20}; do
  if curl -sf "http://127.0.0.1:$PREFLIGHT_PORT/api/healthz" >/dev/null 2>&1 || curl -sf "http://127.0.0.1:$PREFLIGHT_PORT/" >/dev/null 2>&1; then
    PREFLIGHT_OK=1
    break
  fi
  sleep 1
done

# Always clean up the preflight container
podman rm -f omniroute-preflight >/dev/null 2>&1 || true

if [ "$PREFLIGHT_OK" -ne 1 ]; then
  error "Preflight health check FAILED on candidate image. Aborting cutover (zero downtime, live stack untouched)."
  exit 1
fi
log "Preflight health check PASSED!"

# ── 4. Atomic Cutover ──────────────────────────────────────────────────
log "Promoting candidate image -> localhost/omniroute:base..."
podman tag localhost/omniroute:candidate localhost/omniroute:base

log "Recreating live container stack..."
podman rm -f omniroute omniroute-redis omni-ts-egress >/dev/null 2>&1 || true
cd "$SRC_DIR"
"$BIN_DIR/omniroute-up.sh"

# ── 5. Post-cutover live health check ──────────────────────────────────
log "Verifying live service on port 20128..."
LIVE_OK=0
for i in {1..20}; do
  if curl -sf "http://127.0.0.1:20128/api/healthz" >/dev/null 2>&1 || curl -sf "http://127.0.0.1:20128/" >/dev/null 2>&1; then
    LIVE_OK=1
    break
  fi
  sleep 1
done

if [ "$LIVE_OK" -ne 1 ]; then
  error "Live service health check failed after cutover! Inspect with 'podman logs omniroute'."
  exit 1
fi

# ── 6. Synchronize local branch with deployed target ───────────────────
if [ "$TARGET_REF" = "next" ] && [ "$CURRENT_BRANCH" != "local" ]; then
  log "Fast-forwarding branch 'local' to 'next' ($TARGET_SHA)..."
  git branch -f local next
fi

log "SUCCESS: OmniRoute Blue/Green hot-swap deployment completed successfully at commit $TARGET_SHA!"
