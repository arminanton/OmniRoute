#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# omniroute-codex-egress-up.sh — bring up the codex-egress container correctly.
#
# codex-egress uses `network_mode: container:omni-ts-egress`, which podman-compose
# handles poorly across recreates: it caches the sidecar's /proc/<pid>/ns/net path
# and fails ("open /proc/<pid>/ns/net: No such file or directory") when the sidecar
# was recreated with a new PID. So we drive codex-egress with a direct `podman run`
# ordered AFTER the sidecar is confirmed running, and we re-run it whenever the
# sidecar's netns changes (recreating codex-egress re-attaches it to the live netns).
#
# It also PINS the shared-netns resolv.conf to public resolvers (1.1.1.1/8.8.8.8):
# codex's Rust HTTP client fails intermittently against the podman bridge resolver
# (10.89.9.1) — turns hang with "failed to lookup address information: Try again" —
# but works reliably against a public resolver, whose queries still egress through
# the NUC exit node at the IP layer (no AWS DNS leak; verified via edns-client-subnet
# 66.183.196.0/24). The sidecar owns /etc/resolv.conf for the shared netns.
# ─────────────────────────────────────────────────────────────────────────
set -uo pipefail

SIDECAR="omni-ts-egress"
CODEX="omni-codex-egress"
IMAGE="localhost/omniroute:base"
ROOT="/mnt/devvm/custom/omnirouter"
WS_TOKEN="$ROOT/workspace/codex-egress/ws-token"

log() { echo "[codex-egress-up] $*"; }

# 1. Sidecar must be running (codex-egress joins its netns).
if ! podman inspect -f '{{.State.Status}}' "$SIDECAR" 2>/dev/null | grep -q running; then
  log "FATAL: $SIDECAR is not running; start the egress sidecar first"
  exit 1
fi

# 2. Pin the shared-netns resolv.conf to public resolvers (idempotent).
log "pinning resolv.conf to public resolvers (avoids codex Rust-resolver hang on 10.89.9.1)"
podman exec --user root "$SIDECAR" sh -c \
  'printf "nameserver 1.1.1.1\nnameserver 8.8.8.8\noptions timeout:2 attempts:3\n" > /etc/resolv.conf' \
  || log "WARN could not pin resolv.conf"

# 3. (Re)create codex-egress attached to the sidecar's CURRENT netns.
log "recreating $CODEX attached to the live $SIDECAR netns"
podman rm -f "$CODEX" >/dev/null 2>&1 || true
podman run -d --name "$CODEX" \
  --network "container:$SIDECAR" \
  --user 0:0 \
  --restart unless-stopped \
  -e CODEX_HOME=/home/node/.codex \
  -v /home/ndsadmin/.codex:/home/node/.codex:rw \
  -v "$WS_TOKEN:/run/ws-token:ro" \
  "$IMAGE" \
  codex app-server --listen ws://0.0.0.0:1456 \
    --ws-auth capability-token --ws-token-file /run/ws-token >/dev/null \
  && log "$CODEX started" \
  || { log "FATAL: failed to start $CODEX"; exit 1; }

# 4. Wait for the app-server readyz.
for i in $(seq 1 20); do
  if podman exec "$CODEX" node -e \
      "require('http').get('http://127.0.0.1:1456/readyz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
      2>/dev/null; then
    log "$CODEX app-server ready after $((i*2))s"
    exit 0
  fi
  sleep 2
done
log "WARNING: $CODEX app-server did not report ready in 40s"
exit 0
