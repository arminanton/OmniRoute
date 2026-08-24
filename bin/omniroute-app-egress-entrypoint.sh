#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  OmniRoute app residential-egress wrapper (local-only; mounted via the
#  gitignored docker-compose.override.yml). Runs as the container ENTRYPOINT
#  BEFORE the app: brings up an in-container tailscaled TUN so the WHOLE app
#  process — dashboard + every provider (MaxAI, web providers, etc.) — egresses
#  the NUC residential exit node instead of the datacenter IP. Then execs the
#  original entrypoint so nothing else about the app changes (its bridge, ports,
#  redis, and codex control-plane hop all stay exactly as before; only INTERNET
#  egress is tunneled).
#
#  Why in-container TUN (not joining the ts-egress netns): joining another
#  container's netns forces the app to give up its own published ports (the
#  portal path 127.0.0.1:20128) and bridge DNS (redis). A self-contained TUN
#  keeps ALL of that intact — the app still owns its bridge + ports; the tunnel
#  only changes the default route for outbound internet.
#
#  Prereqs (declared on the service in the override): user root, --device
#  /dev/net/tun, cap NET_ADMIN + NET_RAW, sysctl net.ipv4.conf.all.src_valid_mark=1,
#  and the host netfilter modules loaded (already done for ts-egress via
#  /etc/modules-load.d). Fails OPEN by design ONLY if explicitly told to (see
#  APP_EGRESS_REQUIRE); otherwise it fails CLOSED — if the tunnel can't come up
#  the app still starts but egress is NOT residential, so we log LOUDLY.
# ──────────────────────────────────────────────────────────────────────
set -uo pipefail

TSB="${APP_EGRESS_BIN:-/run/app-egress/bin}"
TS_STATE_DIR="${APP_EGRESS_STATE:-/run/app-egress/state}"
TS_SOCK="/run/app-egress/tailscaled.sock"
AUTHKEY_FILE="${APP_EGRESS_AUTHKEY_FILE:-/run/app-egress/authkey}"
EXIT_NODE="${APP_EGRESS_EXIT_NODE:-100.100.95.35}"
HOSTNAME_TS="${APP_EGRESS_HOSTNAME:-omni-app-egress}"
WAIT_SECS="${APP_EGRESS_WAIT_SECS:-45}"
TUN_DEV="${APP_EGRESS_TUN_DEV:-app-egress0}"
# Always-on kill-switch toggle. Default ON when iptables is present (baked into
# omniroute:base). Set APP_EGRESS_KILLSWITCH=0 to disable (e.g. debugging).
KILLSWITCH="${APP_EGRESS_KILLSWITCH:-1}"

log() { echo "[app-egress] $*" >&2; }

# ── Always-on egress kill-switch ─────────────────────────────────────────
# Belt-and-suspenders leak prevention (William, 2026-08-24). The exit-node-down
# case already fails closed naturally (tailscale keeps 0/1+128/1 captured into
# the TUN; an offline exit node drops traffic — verified). The ONE window that
# does NOT cover is tailscaled PROCESS death: the TUN device (app-egress0) is
# torn down and the default route reverts to the bridge -> AWS leak. This chain,
# hooked into OUTPUT, DROPs all non-tunnel/non-local egress so a leak is
# impossible regardless of tailscaled/exit-node state. It ALLOWS:
#   * loopback (lo)
#   * the tailscale TUN itself (app-egress0) — the tunnel path
#   * the WireGuard underlay (fwmark 0x80000/0xff0000) — so the tunnel can rebuild
#   * the tailnet CGNAT range (100.64.0.0/10) — peer/control traffic
#   * the podman bridge (10.89.0.0/16) — redis, bridge DNS, codex ts-egress hop
# Everything else DROPs. Mirrors the PROVEN codex ts-egress-failover.sh chain.
engage_killswitch() {
  [ "$KILLSWITCH" = "1" ] || { log "kill-switch disabled (APP_EGRESS_KILLSWITCH=$KILLSWITCH)"; return 0; }
  if ! command -v iptables >/dev/null 2>&1; then
    log "WARN iptables not present — CANNOT engage kill-switch (tailscaled-death leak window stays OPEN). Rebuild image with iptables."
    return 1
  fi
  # Build the chain deterministically (idempotent: flush then repopulate).
  iptables -N app-egress-killswitch 2>/dev/null || true
  iptables -F app-egress-killswitch
  # Responses to already-accepted INBOUND connections (portal :20128, api :20129)
  # must ALWAYS be allowed regardless of egress interface — this is why the app
  # kill-switch needs a conntrack rule the codex sidecar (no inbound ports) omits.
  iptables -A app-egress-killswitch -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  iptables -A app-egress-killswitch -o lo -j RETURN
  iptables -A app-egress-killswitch -o "$TUN_DEV" -j RETURN
  iptables -A app-egress-killswitch -m mark --mark 0x80000/0xff0000 -j RETURN
  iptables -A app-egress-killswitch -d 100.64.0.0/10 -j RETURN
  iptables -A app-egress-killswitch -d 10.89.0.0/16 -j RETURN
  # Also allow the private LAN ranges the bridge/host may use for DNS etc.
  iptables -A app-egress-killswitch -d 127.0.0.0/8 -j RETURN
  iptables -A app-egress-killswitch -d 10.0.0.0/8 -j RETURN
  iptables -A app-egress-killswitch -d 172.16.0.0/12 -j RETURN
  iptables -A app-egress-killswitch -d 192.168.0.0/16 -j RETURN
  iptables -A app-egress-killswitch -j DROP
  # Hook into OUTPUT exactly once.
  iptables -C OUTPUT -j app-egress-killswitch 2>/dev/null || iptables -I OUTPUT 1 -j app-egress-killswitch
  log "kill-switch ENGAGED (allow established/lo/$TUN_DEV/fwmark/tailnet/bridge/RFC1918, DROP else — no AWS leak even if tailscaled dies)."
}

start_tun() {
  if [ ! -x "$TSB/tailscaled" ]; then
    log "WARN tailscaled not found at $TSB — SKIPPING residential egress (traffic will be DATACENTER)."
    return 1
  fi
  mkdir -p "$TS_STATE_DIR" "$(dirname "$TS_SOCK")"

  log "starting tailscaled TUN (state=$TS_STATE_DIR)"
  "$TSB/tailscaled" \
    --state="$TS_STATE_DIR/tailscaled.state" \
    --socket="$TS_SOCK" \
    --tun="$TUN_DEV" \
    >/tmp/app-egress-tailscaled.log 2>&1 &
  TSD_PID=$!

  # Wait for the daemon socket.
  for _ in $(seq 1 20); do
    [ -S "$TS_SOCK" ] && break
    sleep 0.5
  done

  # Bring the node up. Reuse persisted state if present (no authkey needed);
  # otherwise use the authkey file if one is mounted.
  local up_args=(--socket="$TS_SOCK" up --hostname="$HOSTNAME_TS"
    --exit-node="$EXIT_NODE" --exit-node-allow-lan-access=true --accept-dns=false)
  if [ -f "$AUTHKEY_FILE" ]; then
    up_args+=(--authkey="file:$AUTHKEY_FILE")
  fi
  log "tailscale up --exit-node=$EXIT_NODE (accept-dns=false)"
  if ! "$TSB/tailscale" "${up_args[@]}" >/tmp/app-egress-up.log 2>&1; then
    log "WARN 'tailscale up' failed:"; sed 's/^/[app-egress]   /' /tmp/app-egress-up.log >&2 || true
    return 1
  fi

  # Verify the exit node is actually engaged + egress is residential before we
  # trust it. Do NOT hard-block boot forever; log the verdict.
  for _ in $(seq 1 "$WAIT_SECS"); do
    if "$TSB/tailscale" --socket="$TS_SOCK" status 2>/dev/null | grep -qi "exit node"; then
      log "exit node engaged."
      return 0
    fi
    sleep 1
  done
  log "WARN exit node not confirmed within ${WAIT_SECS}s (check /tmp/app-egress-tailscaled.log)."
  return 1
}

if start_tun; then
  log "residential egress ACTIVE — app internet traffic routes via exit node $EXIT_NODE."
  # TUN is up (app-egress0 exists) -> lock egress with the always-on kill-switch
  # so a LATER tailscaled process death can never revert to the AWS bridge route.
  # Engaged only on the success path: engaging it without the TUN present would
  # DROP all egress and break the app. Best-effort (never blocks boot).
  engage_killswitch || log "WARN kill-switch not engaged (see message above); relying on tailscale natural fail-closed only."
else
  if [ "${APP_EGRESS_REQUIRE:-0}" = "1" ]; then
    log "FATAL residential egress REQUIRED (APP_EGRESS_REQUIRE=1) but not active — refusing to start."
    exit 1
  fi
  log "PROCEEDING WITHOUT residential egress (fail-open). Set APP_EGRESS_REQUIRE=1 to fail closed."
fi

# Hand off to the app's real entrypoint + command.
log "exec: $*"
exec "$@"
