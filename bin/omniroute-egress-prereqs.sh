#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# omniroute-egress-prereqs.sh — idempotent host-side prerequisites for the
# TUN-mode tailscale residential-egress sidecar (omni-ts-egress).
#
# The compose sidecar routes codex traffic (TCP + UDP/QUIC + DNS) through the
# NUC residential exit node at the IP layer. For TUN-mode tailscale to work in
# ROOTLESS podman, three things must be true on the HOST before `compose up`:
#
#   1. /dev/net/tun exists (kernel tun module).
#   2. netfilter modules are loaded — tailscale programs iptables to set the
#      fwmark (0x80000) that bypasses its own tunnel for the WireGuard underlay.
#      Persisted at boot via /etc/modules-load.d/omniroute-tailscale-egress.conf;
#      this script also loads them immediately so a fresh boot needn't wait.
#   3. A valid tailscale auth key exists at .ts-sidecar-authkey, OR the sidecar's
#      persisted state (workspace/ts-egress-state/tailscaled.state) is already
#      authenticated. If neither, this script mints a fresh ephemeral key when
#      TAILSCALE_API_KEY + TAILSCALE_TAILNET are set.
#
# (The src_valid_mark sysctl is set per-container in the compose file, not here,
# because it is network-namespaced.)
#
# Run before `bin/omniroute-up.sh`. Safe to re-run.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="/mnt/devvm/custom/omnirouter"
AUTHKEY_FILE="$ROOT/.ts-sidecar-authkey"
STATE_DIR="$ROOT/workspace/ts-egress-state"
WS_TOKEN_FILE="$ROOT/workspace/codex-egress/ws-token"
MODULES=(iptable_filter iptable_nat iptable_mangle ip_tables xt_mark xt_conntrack nf_conntrack)

log() { echo "$(date -u +%H:%M:%SZ) [egress-prereqs] $*"; }

# ── 1. /dev/net/tun ──────────────────────────────────────────────────────
if [ ! -c /dev/net/tun ]; then
  log "loading tun module"; sudo modprobe tun
fi
[ -c /dev/net/tun ] && log "OK /dev/net/tun present" || { log "FATAL no /dev/net/tun"; exit 1; }

# ── 2. netfilter modules ─────────────────────────────────────────────────
missing=()
for m in "${MODULES[@]}"; do
  lsmod | grep -q "^${m}\b" || missing+=("$m")
done
if [ ${#missing[@]} -gt 0 ]; then
  log "loading netfilter modules: ${missing[*]}"
  sudo modprobe "${missing[@]}"
fi
log "OK netfilter modules loaded"

# ── 3. auth material ─────────────────────────────────────────────────────
key_valid=false
if [ -s "$AUTHKEY_FILE" ] && grep -q '^tskey-auth-' "$AUTHKEY_FILE"; then
  key_valid=true
fi
state_authed=false
if [ -s "$STATE_DIR/tailscaled.state" ]; then
  state_authed=true
fi

if $state_authed; then
  log "OK sidecar has persisted authed state (tailscaled.state)"
elif $key_valid; then
  log "OK auth key present at .ts-sidecar-authkey"
elif [ -n "${TAILSCALE_API_KEY:-}" ] && [ -n "${TAILSCALE_TAILNET:-}" ]; then
  log "no auth material — minting fresh ephemeral key via Tailscale API"
  resp="$(curl -s --max-time 20 -u "${TAILSCALE_API_KEY}:" \
    "https://api.tailscale.com/api/v2/tailnet/${TAILSCALE_TAILNET}/keys" \
    -H 'Content-Type: application/json' \
    -d '{"capabilities":{"devices":{"create":{"reusable":true,"ephemeral":true,"preauthorized":true,"tags":[]}}},"expirySeconds":7776000,"description":"omni-codex-egress TUN sidecar"}')"
  key="$(printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("key",""))' 2>/dev/null || true)"
  if [[ "$key" == tskey-auth-* ]]; then
    umask 077; printf '%s' "$key" > "$AUTHKEY_FILE"
    log "OK minted + saved fresh key to .ts-sidecar-authkey"
  else
    log "FATAL key mint failed: $(printf '%s' "$resp" | head -c 200)"; exit 1
  fi
else
  log "FATAL no auth: need .ts-sidecar-authkey, persisted state, or TAILSCALE_API_KEY+TAILSCALE_TAILNET"; exit 1
fi

log "all prerequisites satisfied — safe to compose up the ts-egress sidecar"

# ── 4. codex app-server ws capability token ──────────────────────────────
# The app-server refuses a non-loopback ws listener without auth. Mint a random
# capability token once; both the codex-egress container (--ws-token-file) and
# OmniRoute (OMNIROUTE_CODEX_APPSERVER_WS_TOKEN) read the same value.
if [ ! -s "$WS_TOKEN_FILE" ]; then
  mkdir -p "$(dirname "$WS_TOKEN_FILE")"
  umask 077; openssl rand -hex 32 > "$WS_TOKEN_FILE"
  log "minted codex app-server ws capability token"
else
  log "OK codex ws capability token present"
fi
