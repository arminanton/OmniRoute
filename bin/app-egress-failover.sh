#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# app-egress-failover.sh — exit-node health watcher for the OmniRoute APP's
# own in-container tailscale TUN (omni-app-egress inside the `omniroute`
# container). Sibling to ts-egress-failover.sh (which steers the codex
# omni-ts-egress sidecar); this one steers the WHOLE-APP residential egress
# added in bin/omniroute-app-egress-entrypoint.sh.
#
# Requirement (William): NUC primary, armin-win-laptop fallback; keep the app's
# internet egress residential; never let it fall back to the EC2 AWS IP.
#
# ── Why this is SIMPLER than the codex watcher (no iptables kill-switch) ──
# The codex sidecar runs the stock tailscale image, whose entrypoint EXITS on
# `tailscale down`, and whose leak mode is "exit node removed -> bridge route".
# It therefore needs an iptables DROP kill-switch for fail-closed.
#
# The APP TUN is different and was VERIFIED 2026-08-24:
#   * `tailscale set --exit-node=<ip>` cleanly switches the exit node without
#     disturbing the app (the failover primitive). GOOD.
#   * Pointing the TUN at an OFFLINE exit node FAILS CLOSED NATURALLY: tailscale
#     keeps the 0.0.0.0/1 + 128.0.0.0/1 routes captured into the TUN, so packets
#     enter a tunnel with no reachable exit and are DROPPED. Live proof: egress
#     via an offline node -> curl rc=28 timeout, egress IP never became the AWS
#     IP (75.101.225.196). So as long as an exit node stays SET, there is no leak.
# Therefore this watcher NEVER unsets the exit node. When both candidates are
# down it simply LEAVES the TUN pinned to the (now-down) node -> fail closed by
# tailscale's own routing. When a healthy candidate returns, it re-points.
#
# ── Residual window this does NOT cover (documented, not handled here) ──
# If the tailscaled PROCESS itself dies, its TUN device (app-egress0) is torn
# down and the default route reverts to the bridge -> potential AWS leak. Closing
# that window requires an always-on iptables kill-switch baked into the image
# (iptables is not currently in omniroute:base). Tracked separately; this watcher
# assumes tailscaled stays alive (it is a stable long-running daemon).
#
# Driven via `podman exec` into the app container (rootless podman = `podman`).
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_CONTAINER="${APP_EGRESS_CONTAINER:-omniroute}"
TS_BIN="${APP_EGRESS_TS_BIN:-/run/app-egress/bin/tailscale}"
SOCK="${APP_EGRESS_SOCK:-/run/app-egress/tailscaled.sock}"
INTERVAL="${APP_EGRESS_WATCH_INTERVAL:-20}"
ENGINE="${CONTAINER_ENGINE:-podman}"
LOGFILE="${APP_EGRESS_LOG:-/mnt/devvm/custom/omnirouter/workspace/logs/app-egress-failover.log}"

# Exit-node candidates in priority order: NUC primary, laptop fallback.
# (Both currently share the same TELUS residential line 66.183.196.137, so a
# failover preserves the residential IP reputation — ideal for MaxAI.)
NUC_IP="${APP_EGRESS_NUC_IP:-100.100.95.35}"
LAPTOP_IP="${APP_EGRESS_LAPTOP_IP:-100.76.165.46}"
CANDIDATES=("$NUC_IP" "$LAPTOP_IP")

mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true
log() { echo "$(date -u +%H:%M:%SZ) [app-egress-failover] $*" | tee -a "$LOGFILE" >&2; }

ts() { "$ENGINE" exec "$APP_CONTAINER" "$TS_BIN" --socket="$SOCK" "$@" 2>/dev/null; }

# Return 0 if the given exit-node IP is a peer that is currently Online.
node_online() {
  local ip="$1"
  ts status --json 2>/dev/null | python3 -c "
import json,sys
ip='$ip'
try: d=json.load(sys.stdin)
except: sys.exit(1)
for p in (d.get('Peer') or {}).values():
    if ip in (p.get('TailscaleIPs') or []):
        sys.exit(0 if p.get('Online') else 1)
sys.exit(1)
" 2>/dev/null
}

# Current exit-node IP, or empty when none is set.
current_exit_ip() {
  ts status --json 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except: print(''); sys.exit()
es=d.get('ExitNodeStatus') or {}
print((es.get('TailscaleIPs') or [''])[0].split('/')[0])
" 2>/dev/null
}

# Is tailscaled reachable at all (socket answering)? Detection only — we log
# LOUDLY if it's gone so the residual-leak window is at least visible.
tailscaled_alive() {
  ts status >/dev/null 2>&1
}

# Bring egress up through a specific exit node (does NOT disturb the app).
set_exit() {
  local ip="$1"
  ts set --exit-node="$ip" --exit-node-allow-lan-access=true >/dev/null 2>&1 \
    && log "egress via exit node $ip" \
    || log "WARN failed to set exit node -> $ip"
}

log "watching $APP_CONTAINER app-TUN every ${INTERVAL}s (primary=$NUC_IP fallback=$LAPTOP_IP, engine=$ENGINE)"
DAEMON_WARNED=0
while true; do
  if ! "$ENGINE" inspect "$APP_CONTAINER" >/dev/null 2>&1; then
    log "app container gone; nothing to steer"; sleep "$INTERVAL"; continue
  fi
  state="$("$ENGINE" inspect -f '{{.State.Status}}' "$APP_CONTAINER" 2>/dev/null || echo unknown)"
  if [ "$state" != "running" ]; then
    log "app container state=$state; waiting"; sleep "$INTERVAL"; continue
  fi

  # tailscaled liveness: if the daemon is dead the TUN is gone and egress can
  # leak. We cannot restart it cleanly from here, but we make it VISIBLE.
  if ! tailscaled_alive; then
    if [ "$DAEMON_WARNED" -eq 0 ]; then
      log "ALERT app-TUN tailscaled not answering (socket dead) — egress may NOT be residential; recreate the app container to rebuild the TUN."
      DAEMON_WARNED=1
    fi
    sleep "$INTERVAL"; continue
  fi
  DAEMON_WARNED=0

  cur="$(current_exit_ip || true)"
  chosen=""
  for ip in "${CANDIDATES[@]}"; do
    if node_online "$ip"; then chosen="$ip"; break; fi
  done

  if [ -z "$chosen" ]; then
    # Both exit nodes down -> LEAVE pinned to the current (down) node so the app
    # TUN fails CLOSED naturally (verified). Do NOT unset the exit node.
    log "ALL exit nodes DOWN (NUC+laptop) -> leaving TUN pinned to '${cur:-?}' (fails closed, no AWS leak)"
  elif [ "$chosen" != "$cur" ]; then
    log "exit node -> $chosen (was '${cur:-none}', health-driven)"
    set_exit "$chosen"
  fi
  sleep "$INTERVAL"
done
