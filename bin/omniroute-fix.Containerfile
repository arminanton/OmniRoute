# ──────────────────────────────────────────────────────────────────────
#  Local ESM-crash fix layer for OmniRoute (kept OUT of the fork).
#
#  Upstream bug at the pinned commit: the Next.js standalone `server.js` is
#  CommonJS (uses require()/__dirname), but the standalone `/app/package.json`
#  still carries "type":"module", so Node 26 treats server.js as ESM and dies:
#      ReferenceError: require is not defined in ES module scope
#
#  scripts/build/assembleStandalone.mjs::patchStandalonePackageJson is meant to
#  strip "type" during the build, but it did not take effect in this image
#  build. Until the fork carries an upstream fix, we strip it in a thin derived
#  layer so the runtime image is correct. This is a build artifact fix only; it
#  touches nothing in the tracked source tree, so the fork stays PR-clean.
#
#  ALSO bakes in the codex CLI (app-server) so the codex-egress container can
#  run `codex app-server --listen ws://...` inside the TUN egress netns. Codex
#  is installed to a location OUTSIDE the runtime-mounted ~/.codex so the mount
#  (host auth/sessions) never shadows the binary. See docker-compose.override
#  codex-egress service + memory 2026-08-22.
#
#  Rebuilt by omniroute-deploy.sh on top of a freshly built omniroute:raw.
# ──────────────────────────────────────────────────────────────────────
FROM localhost/omniroute:raw

# ── ESM fix (unchanged) ────────────────────────────────────────────────
USER node
RUN node -e "const f='/app/package.json';const fs=require('fs');const p=JSON.parse(fs.readFileSync(f));if(p.type){delete p.type;fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n');console.log('[fix] stripped type:module from',f);}else{console.log('[fix] no type field; nothing to do');}"

# ── codex CLI (app-server) ─────────────────────────────────────────────
# Install the LATEST codex at build time (CODEX_RELEASE=latest) via the official
# installer, which auto-selects the correct arch (aarch64-unknown-linux-musl in
# this image). Two separations matter:
#   * CODEX_INSTALL_DIR=/usr/local/bin  -> the `codex` binary lands on PATH.
#   * CODEX_HOME=/opt/codex             -> the standalone payload lives here at
#     BUILD time, OUTSIDE the runtime bind-mount at /home/node/.codex, so the
#     mount (host sessions/skills/auth.json) never hides the binary. At RUNTIME
#     the compose service sets CODEX_HOME=/home/node/.codex (resolved live by
#     the binary) so codex uses the shared host auth/sessions.
# Pin the installer to a build arg for reproducibility if needed; default latest.
USER root
ARG CODEX_RELEASE=latest
# iptables + iproute2 are also installed here (Debian trixie base) so the app's
# in-container residential-egress TUN (bin/omniroute-app-egress-entrypoint.sh)
# can program an always-on kill-switch. Without them the app container has NO
# netfilter tooling (tailscale programs routes via netlink), so a tailscaled
# PROCESS death would tear down the TUN and revert the default route to the AWS
# bridge -> leak. The kill-switch (allow lo + app-egress0 + WireGuard fwmark +
# tailnet + bridge, DROP everything else) makes that leak impossible regardless
# of tailscaled/exit-node state. Build-time apt uses the host network (the TUN
# is not up during build), so this fetches fine. Local infra only (this file is
# gitignored), so the fork/PR stays clean.
RUN set -eux; \
    apk add --no-cache curl bubblewrap iptables iproute2 2>/dev/null || (apt-get update && apt-get install -y --no-install-recommends curl bubblewrap iptables iproute2) || true; \
    mkdir -p /opt/codex /usr/local/bin; \
    CODEX_RELEASE="${CODEX_RELEASE}" \
    CODEX_INSTALL_DIR=/usr/local/bin \
    CODEX_HOME=/opt/codex \
    CODEX_NON_INTERACTIVE=true \
    sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'; \
    /usr/local/bin/codex --version; \
    chmod -R a+rX /opt/codex /usr/local/bin/codex

USER node
