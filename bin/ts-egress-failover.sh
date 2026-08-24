#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# ts-egress-failover.sh — exit-node health watcher + kill-switch for the
# OmniRoute TUN-mode tailscale egress sidecar (omni-ts-egress).
#
# Requirement (William, 2026-08-22): NUC primary, armin-win-laptop fallback;
# if BOTH are down, CUT egress (fail closed) so no codex traffic ever leaves
# via the EC2's own AWS IP.
#
# ── Why this is more than "swap the exit node" ───────────────────────────
# The sidecar runs TUN-mode tailscale: its default route points into
# tailscale0. Verified 2026-08-22:
#   * `tailscale set --exit-node=<ip>` cleanly switches the exit node WITHOUT
#     killing the container (the failover primitive). GOOD.
#   * `tailscale down` DROPS THE CONTAINER (the tailscale image entrypoint
#     exits on `down`), and removing the exit node reverts routing to the
#     bridge default -> egress LEAKS to the EC2 AWS IP (75.101.225.196).
# So fail-closed CANNOT be "remove the exit node" or "tailscale down". It must
# be a real packet DROP, enforced inside the sidecar netns and independent of
# host routing (the host's own tailscale exit state is out of our control).
#
# Mechanism: a dedicated `ts-killswitch` iptables chain in the sidecar, hooked
# into OUTPUT. When ALL exit nodes are down, we ENGAGE it (insert a DROP for
# non-tunnel, non-local egress); when a healthy node returns, we DISENGAGE it
# and `tailscale set` the new exit. The chain always RETURNs loopback, the
# tailscale0 tunnel, the WireGuard underlay (fwmark 0x80000), the tailnet
# (100.64/10) and the bridge (10.89/16) so the tunnel can always rebuild.
#
# We drive the sidecar via `podman exec` (rootless podman = `podman`, not
# `docker`).
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

SIDECAR="${TS_EGRESS_CONTAINER:-omni-ts-egress}"
SOCK="/tmp/tailscaled.sock"
INTERVAL="${TS_EGRESS_WATCH_INTERVAL:-20}"
ENGINE="${CONTAINER_ENGINE:-podman}"
LOGFILE="${TS_EGRESS_LOG:-/mnt/devvm/custom/omnirouter/workspace/logs/ts-egress-failover.log}"

# Exit-node candidates in priority order: NUC primary, laptop fallback.
NUC_IP="100.100.95.35"
LAPTOP_IP="100.76.165.46"
CANDIDATES=("$NUC_IP" "$LAPTOP_IP")

mkdir -p "$(dirname "$LOGFILE")" 2>/dev/null || true
log() { echo "$(date -u +%H:%M:%SZ) [ts-egress-failover] $*" | tee -a "$LOGFILE" >&2; }

ts()  { "$ENGINE" exec "$SIDECAR" tailscale --socket="$SOCK" "$@" 2>/dev/null; }
ipt() { "$ENGINE" exec "$SIDECAR" iptables "$@" 2>/dev/null; }

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

# Ensure the ts-killswitch chain exists (idempotent). Applied inside the netns.
ensure_killswitch_chain() {
  ipt -N ts-killswitch 2>/dev/null || true
  # Rebuild deterministically each time we (dis)engage so ordering is stable.
  ipt -F ts-killswitch
  ipt -A ts-killswitch -o lo -j RETURN
  ipt -A ts-killswitch -o tailscale0 -j RETURN
  ipt -A ts-killswitch -m mark --mark 0x80000/0xff0000 -j RETURN
  ipt -A ts-killswitch -d 100.64.0.0/10 -j RETURN
  ipt -A ts-killswitch -d 10.89.0.0/16 -j RETURN
  # The final DROP is added ONLY when engaged (see engage_killswitch).
}

killswitch_engaged() {
  ipt -C OUTPUT -j ts-killswitch 2>/dev/null
}

engage_killswitch() {
  ensure_killswitch_chain
  ipt -A ts-killswitch -j DROP
  killswitch_engaged || ipt -I OUTPUT 1 -j ts-killswitch
  log "FAIL CLOSED: kill-switch engaged (DROP non-tunnel egress; no AWS leak)"
}

disengage_killswitch() {
  if killswitch_engaged; then
    ipt -D OUTPUT -j ts-killswitch 2>/dev/null || true
    log "kill-switch disengaged (healthy exit node available)"
  fi
}

# Bring egress up through a specific exit node (does NOT kill the container).
set_exit() {
  local ip="$1"
  disengage_killswitch
  ts set --exit-node="$ip" --exit-node-allow-lan-access=true >/dev/null 2>&1 \
    && log "egress via exit node $ip" \
    || log "WARN failed to set exit node -> $ip"
}

log "watching $SIDECAR every ${INTERVAL}s (primary=$NUC_IP fallback=$LAPTOP_IP, engine=$ENGINE)"
while true; do
  if ! "$ENGINE" inspect "$SIDECAR" >/dev/null 2>&1; then
    log "sidecar container gone; nothing to steer"; sleep "$INTERVAL"; continue
  fi
  # Skip steering while the sidecar isn't running (e.g. mid-restart).
  state="$("$ENGINE" inspect -f '{{.State.Status}}' "$SIDECAR" 2>/dev/null || echo unknown)"
  if [ "$state" != "running" ]; then
    log "sidecar state=$state; waiting"; sleep "$INTERVAL"; continue
  fi

  cur="$(current_exit_ip || true)"
  chosen=""
  for ip in "${CANDIDATES[@]}"; do
    if node_online "$ip"; then chosen="$ip"; break; fi
  done

  if [ -z "$chosen" ]; then
    # Both exit nodes down -> engage kill switch (unless already engaged).
    killswitch_engaged || { log "ALL exit nodes DOWN (NUC+laptop) -> kill switch"; engage_killswitch; }
  elif [ "$chosen" != "$cur" ] || killswitch_engaged; then
    # A healthy candidate differs from current (or we were failed-closed) -> route.
    log "exit node -> $chosen (was '${cur:-CUT}', health-driven)"
    set_exit "$chosen"
  fi
  sleep "$INTERVAL"
done
