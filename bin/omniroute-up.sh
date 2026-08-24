#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────
#  OmniRoute stack controller (rootless podman, this EC2 box).
#
#  Invoked by the systemd user unit ~/.config/systemd/user/omniroute.service
#  on every boot / reboot / EC2 stop-start. Modelled on the box convention in
#  ~/.config/systemd/user/cmx-postgres.service:
#
#    - If the containers already exist (stopped after a reboot / stop-start),
#      just `podman start` them. podman-compose errors 125 ("name already in
#      use") if you `up` an existing stack, so we avoid that path.
#    - Only fall back to `podman-compose up` to CREATE the stack fresh (first
#      run, or after a prune when the containers are gone but the bind-mounted
#      workspace survives).
#
#  The compose file pins container_name (omniroute, omniroute-redis), so we
#  drive off those fixed names rather than the compose project name.
#
#  GITHUB_TOKEN/GH_TOKEN are unset so nothing here is scoped to the wrong gh
#  account; this stack has no git interaction at runtime anyway.
# ──────────────────────────────────────────────────────────────────────
set -uo pipefail

SRC_DIR="/mnt/devvm/custom/omnirouter/src"
BIN_DIR="/mnt/devvm/custom/omnirouter/bin"
APP="omniroute"
REDIS="omniroute-redis"
TS_EGRESS="omni-ts-egress"
PROFILE="base"

log() { echo "[omniroute-up] $*"; }

cd "$SRC_DIR" || { echo "[omniroute-up] FATAL: $SRC_DIR missing" >&2; exit 1; }

# ── Residential egress prerequisites (netfilter modules, /dev/net/tun, auth,
# ws-token) must be satisfied before the ts-egress TUN sidecar can come up.
# Idempotent + cheap; safe to run every boot.
if [ -x "$BIN_DIR/omniroute-egress-prereqs.sh" ]; then
  log "ensuring residential-egress prerequisites"
  "$BIN_DIR/omniroute-egress-prereqs.sh" || log "WARN egress prereqs returned non-zero (sidecar may not come up)"
fi

start_existing() {
  # Redis first so the app's REDIS_URL is reachable the moment it starts.
  local started=0
  if podman container exists "$REDIS"; then
    log "starting existing $REDIS"
    podman start "$REDIS" >/dev/null 2>&1 && started=$((started+1))
  fi
  if podman container exists "$APP"; then
    log "starting existing $APP"
    podman start "$APP" >/dev/null 2>&1 && started=$((started+1))
  fi
  # The TUN residential-egress sidecar is always-on (no profile). Start it if it
  # exists; it is not counted toward the 2-of-2 core check so its absence never
  # forces a full recreate of the app+redis pair.
  if podman container exists "$TS_EGRESS"; then
    log "starting existing $TS_EGRESS (residential egress sidecar)"
    podman start "$TS_EGRESS" >/dev/null 2>&1 || log "WARN failed to start $TS_EGRESS"
  fi
  # Return success only if BOTH expected core containers were present+started.
  [ "$started" -eq 2 ]
}

recreate_fresh() {
  # Post-reboot the tmpfs runroot (/run/user/400) is wiped, which can leave the
  # persistent container records in a stale state that `podman start` refuses.
  # Clear any half-existing containers by name, then recreate from compose.
  # The bind-mounted workspace on persistent storage is untouched, so no data
  # is lost, only the container instances are rebuilt around the same volume.
  log "clearing any stale container records before fresh create"
  podman rm -f "$APP" "$REDIS" >/dev/null 2>&1 || true
  compose_up
}

compose_up() {
  log "creating stack fresh via podman-compose (profile=$PROFILE)"
  # No --build here: the image is built once out-of-band (deploy step). If the
  # image is somehow absent this will build it, which is slow but correct.
  # --in-pod=false: don't create a shared project pod. podman refuses --userns
  # together with --pod, and the override uses keep-id userns so the workspace
  # is owned by host ndsadmin (uid/gid 400). Without this the create fails with
  # "--userns and --pod cannot be set together".
  podman compose --in-pod=false --profile "$PROFILE" up -d
}

if start_existing; then
  log "existing containers started"
else
  log "one or more containers absent or unstartable -> recreate fresh"
  recreate_fresh || { log "recreate FAILED"; exit 1; }
fi

# ── Wait for the app healthcheck (node healthcheck.mjs) to report healthy ──
for i in $(seq 1 60); do
  status="$(podman inspect -f '{{.State.Health.Status}}' "$APP" 2>/dev/null || true)"
  if [ "$status" = "healthy" ]; then
    log "$APP healthy after $((i*3))s"
    exit 0
  fi
  # If there is no healthcheck defined, running is good enough.
  if [ -z "$status" ]; then
    run_state="$(podman inspect -f '{{.State.Status}}' "$APP" 2>/dev/null || true)"
    if [ "$run_state" = "running" ]; then
      log "$APP running (no healthcheck reported)"
      exit 0
    fi
  fi
  sleep 3
done

log "WARNING: $APP did not become healthy in 180s (last status: ${status:-none})"
# Do not hard-fail the unit on a slow first boot; the app may still come up.
exit 0
