# ── Immutable npm runtime/security input tree (not a release layer) ──────────
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS npm-tool-tree
COPY docker/npm-tools/package.json docker/npm-tools/package-lock.json /tmp/docker-npm-tree/
RUN --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-npm-cache,target=/root/.npm \
  npm ci --prefix /tmp/docker-npm-tree --install-strategy=nested --include=optional \
    --ignore-scripts --no-audit --no-fund --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=30000 --fetch-timeout=60000

# ── Common base with runtime deps ──────────────────────────────────────────
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS base
WORKDIR /app

# `apt-get upgrade` pulls the security-patched versions of the Debian (trixie)
# base-image packages at build time — clears the subset of container-scan CVEs
# (perl / util-linux / systemd / ncurses / zlib / tar / sqlite / shadow / pam …)
# that already have a fix published in trixie. CVEs without an upstream fix yet
# (local-only TOCTOU, etc.) remain until the distro patches them and the image
# is rebuilt; none are reachable from the proxy's request surface at runtime.
# Sharp/Pango renders Video Bridge timestamp labels with DejaVu Sans Mono.
# Without a real font, every contact-sheet label renders identically.
RUN --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends libsecret-1-0 ca-certificates fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# npm's *bundled* node_modules (brace-expansion, ip-address, tar, undici) are
# npm's own internals — not application dependencies (the app resolves its own,
# already-fixed copies) — but the container scanner reads them off
# /usr/local/lib/node_modules/npm/node_modules and reports 9 HIGH/MEDIUM CVEs.
#
# Refreshing npm does NOT fix them. Measured on npm@12.0.2 (2026-08-12, latest):
#   brace-expansion 5.0.7  (needs >= 5.0.9)   CVE-2026-69152, CVE-2026-14257
#   ip-address      10.2.0 (needs >= 10.3.1)  CVE-2026-69192/-69198/-54272
#   tar             7.5.19 (needs >= 7.5.21)  GHSA-r292-9mhp-454m
#   undici          6.27.0 (needs >= 6.28.0)  CVE-2026-16729/-16728/-15157
# Pin the complete npm12.1.0 closure and the four replacements in a private
# integrity lock. The immutable image's bundled npm11.19.1 only bootstraps this
# tree; every later install and runtime npm/npx uses the locked npm12.1.0.
# The application invokes npm at runtime (embedded service installers and
# system update/global-package discovery), so removing npm is not safe.
# Each replacement is nested and self-contained. In particular, undici stays
# on compatible6.x (^6.25.0), never8.x. No package lifecycle hooks are permitted.
COPY --chmod=444 scripts/build/install-docker-npm-tree.mjs /opt/omniroute-docker-build/install-docker-npm-tree.mjs
RUN --network=none --mount=type=bind,from=npm-tool-tree,source=/tmp/docker-npm-tree,target=/tmp/docker-npm-tree \
  set -eux; \
  chmod 755 /opt/omniroute-docker-build; \
  node /opt/omniroute-docker-build/install-docker-npm-tree.mjs; \
  node -e "const assert=require('node:assert/strict'); for (const [p,v] of Object.entries({'brace-expansion':'5.0.9','ip-address':'10.5.0','tar':'7.5.22','undici':'6.28.0'})) { assert.equal(require('/usr/local/lib/node_modules/npm/node_modules/'+p+'/package.json').version,v); console.log(p,v); }"; \
  test "$(npm --version)" = 12.1.0; \
  test "$(npx --version)" = 12.1.0; \
  test "$(npm root -g)" = /usr/local/lib/node_modules

# ── Complete locked CLI input trees (not copied into release layers) ─────────
# This branch can fetch while the application builds. Materialization later
# reads it through a readonly mount and copies only the standard global tree.
FROM base AS cli-dependencies
COPY docker/cli/package.json docker/cli/package-lock.json /tmp/docker-cli-tree/
RUN --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-npm-cache,target=/root/.npm \
  npm ci --prefix /tmp/docker-cli-tree --install-strategy=nested --include=optional \
    --ignore-scripts --no-audit --no-fund --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=30000 --fetch-timeout=60000

# ── Locked dependencies and offline prebuilt acceptance ────────────────────
FROM base AS dependencies
ENV NEXT_TELEMETRY_DISABLED=1
ENV NPM_CONFIG_LEGACY_PEER_DEPS=true

COPY package.json package-lock.json ./
# Keep every workspace manifest in the clean install input set.
COPY open-sse/package.json ./open-sse/package.json
COPY packages/browser-pool/package.json ./packages/browser-pool/package.json
COPY scripts/build/postinstall.mjs ./scripts/build/postinstall.mjs
COPY scripts/build/postinstallSupport.mjs ./scripts/build/postinstallSupport.mjs
COPY scripts/build/native-binary-compat.mjs ./scripts/build/native-binary-compat.mjs
COPY scripts/build/build-tproxy-native.mjs ./scripts/build/build-tproxy-native.mjs
COPY scripts/build/verify-docker-native-deps.mjs ./scripts/build/verify-docker-native-deps.mjs

# Require the unchanged application lock and preserve all optional platform
# packages. No dependency install hooks, source fallback or WASM fallback.
RUN test -f package-lock.json \
  || (echo "package-lock.json is required for reproducible Docker builds" >&2 && exit 1)
RUN --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-npm-cache,target=/root/.npm \
  npm ci --include=optional --no-audit --no-fund --legacy-peer-deps --ignore-scripts \
    --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=30000 --fetch-timeout=60000
# better-sqlite3 13.0.3 already packages GNU N-API binaries. Its old gyp step
# was stamp-only. Require the actual loaded prebuilt and an in-memory query,
# plus all build/runtime native payloads and matching local Node headers.
RUN --network=none node scripts/build/verify-docker-native-deps.mjs --project-root=/app --node-root=/usr/local

# ── Builder: only the first-party TPROXY addon needs a compiler ──────────────
FROM dependencies AS builder
ENV OMNIROUTE_DOCKER_NATIVE_BUILD=1

# Preserve the TPROXY compiler toolchain. The locked local node-gyp uses only
# validated headers beside Node, never npx or a Docker-time header download.
RUN --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Build with Turbopack (stable in Next 16, the repo default). The v3.8.27-era
# TurbopackInternalError panic ("entered unreachable code: there must be a path to a
# root" in ImportTracer::get_traces) no longer reproduces on Next 16.2.9 — validated
# 2026-07-05 with clean amd64 (12min14s, image smoke-tested: /api/monitoring/health
# 200) and arm64 (qemu, exit 0, zero panic strings) builds. Turbopack cut the bare
# build from 17min to 9min on the same 32-core box. Webpack stays available as the
# escape hatch: `--build-arg`/-e OMNIROUTE_USE_TURBOPACK=0.
# See docs/ops/QUALITY_GATE_PLAYBOOK.md Parte 6.
#
# Declared as ARG+ENV, not a bare ENV: a bare ENV shadows any same-named ARG for
# the rest of the stage, so `--build-arg OMNIROUTE_USE_TURBOPACK=0` was silently
# ignored and the escape hatch above only ever worked via `-e` at runtime, never
# at build time. Turbopack compiles in native Rust memory that lives outside the
# V8 heap, so OMNIROUTE_BUILD_MEMORY_MB cannot bound it and a memory-constrained
# build host gets SIGKILLed by the cgroup OOM killer with no error message.
ARG OMNIROUTE_USE_TURBOPACK=1
ENV OMNIROUTE_USE_TURBOPACK="${OMNIROUTE_USE_TURBOPACK}"

# Next.js basePath is fixed at build time; pass OMNIROUTE_BASE_PATH here when the
# image should serve under a reverse-proxy subpath without a runtime patch.
ARG OMNIROUTE_BASE_PATH=""
ENV OMNIROUTE_BASE_PATH=$OMNIROUTE_BASE_PATH

# #10273: the dashboard's `frame-ancestors` policy is compiled into the route
# manifest by next.config.mjs (via scripts/build/dashboardEmbed.mjs), so it is
# fixed when the image is built and cannot be flipped with `-e` on a running
# container. Build with `--build-arg DASHBOARD_ALLOW_EMBED=vscode` to produce an
# image whose HTML pages may be framed by the VS Code Simple Browser
# (OmniCopilot's `dashboardOpen: "editor"`). Unset — the default — keeps every
# route on `frame-ancestors 'none'` + X-Frame-Options: DENY. Builder-stage only:
# the runner stage deliberately does not carry it, because a runtime value would
# suggest an effect it cannot have.
ARG DASHBOARD_ALLOW_EMBED=""
ENV DASHBOARD_ALLOW_EMBED=$DASHBOARD_ALLOW_EMBED

# Docker containers cannot run the MITM/Agent-Bridge stack (no host DNS/cert
# access), so keep @/mitm/manager on the graceful stub (#3390). This flag is
# Docker-only: npm/Electron/VPS builds must bundle the REAL manager (#6344).
ENV OMNIROUTE_MITM_STUB=1

# Raise the V8 heap ceiling for the build. The webpack production optimization
# pass needs more than V8's default ceiling (~2 GB) for a codebase this size; a
# memory-constrained Docker build otherwise dies with "FATAL ERROR: ... JavaScript
# heap out of memory" during the builder stage (#4076). Turbopack's compile is
# native (Rust) and less V8-heap-bound, but the prerender/export phase still runs
# on V8, so keep the ceiling. NODE_OPTIONS propagates to the spawned `next build`
# child (build-next-isolated.mjs → resolveNextBuildEnv spreads process.env).
# Build-only; the runtime heap is set separately on the runner stage
# (OMNIROUTE_MEMORY_MB). Override: `--build-arg OMNIROUTE_BUILD_MEMORY_MB=6144`.
# Default raised 4096 → 6144 (#10060): the Next 16 production pass on a codebase
# this size intermittently OOMs a build worker at 4 GB on memory-tight hosts.
ARG OMNIROUTE_BUILD_MEMORY_MB=6144
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_BUILD_MEMORY_MB}"

# Cap Next.js build worker pools. Next 16 defaults to `os.cpus().length - 1`
# workers for page-data collection (31 on a 32-core builder); on memory-tight
# hosts 31 workers + webpack's multi-GB heap blow past RAM and a worker dies
# with SIGSEGV at teardown ("worker exited with code: null and signal: SIGSEGV"),
# silently leaving no standalone bundle. Next derives the worker count from
# CIRCLE_NODE_TOTAL (workers = N-1). (#10060)
#
# Lowered 8 → 3 (7 workers → 2) in #11419, then 3 → 2 (2 workers → 1) in #7518.
# Every page-data worker inherits NODE_OPTIONS above, so the ceiling is per
# PROCESS, not per build: 7 workers on a 16 GB GitHub runner (ubuntu-24.04 /
# ubuntu-24.04-arm, 4 vCPU) exhausted the host and buildkit failed the whole
# step with `ResourceExhausted: ... cannot allocate memory`. The compile phase
# always finished ("✓ Compiled successfully in 4.2min"); the kernel killed the
# build right after "Collecting page data using N workers".
#
# #11419's first fix (8 → 3) modeled the per-worker peak as an INFERENCE
# (2560 MB, guessed from "7 workers didn't fit") and assumed the parent
# process's RSS tracked the V8 heap ceiling. Both assumptions were wrong: a
# live VPS reproduction (issue #7518, dmesg OOM-killer report) measured the
# real per-process RSS directly at ~4.5 GB, independent of the NODE_OPTIONS
# heap flag (Turbopack itself is native/Rust, outside the V8 heap) — and it
# applies to the parent process too, not just workers. 2 workers (3 processes
# × 4.5 GB = 13.5 GB) still didn't fit the 12.288 GB (75%) budget on a 16 GB
# runner, matching the still-live publish failures after #11419 merged. 1
# worker (2 processes × 4.5 GB = 9 GB) fits with headroom to spare.
# tests/unit/docker-build-memory-budget.test.ts does the arithmetic against
# the measured figure and fails if either knob is raised past what a 16 GB
# runner holds. Override for a big builder: `--build-arg
# OMNIROUTE_BUILD_WORKERS=8`.
ARG OMNIROUTE_BUILD_WORKERS=2
ENV CIRCLE_NODE_TOTAL=${OMNIROUTE_BUILD_WORKERS}

COPY . ./
# The complete compile is offline. Missing payloads/headers cannot trigger
# hidden recovery downloads. Any required external input must be explicit.
RUN --network=none --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-next-cache,target=/app/.build/next/cache \
  mkdir -p /app/data \
  && npm run build \
  && rm -rf /app/.build/next/standalone/node_modules/better-sqlite3 \
  && cp -a /app/node_modules/better-sqlite3 /app/.build/next/standalone/node_modules/better-sqlite3 \
  && node scripts/build/verify-docker-native-deps.mjs --project-root=/app --node-root=/usr/local --require-tproxy --standalone-root=/app/.build/next/standalone \
  && node --input-type=module -e "import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url'; const standaloneRoot = '/app/.build/next/standalone/node_modules/'; const require = createRequire('/app/.build/next/standalone/package.json'); for (const pkg of ['@atjsh/llmlingua-2', '@huggingface/transformers', 'js-tiktoken']) { const resolved = require.resolve(pkg); if (!resolved.startsWith(standaloneRoot)) throw new Error(pkg + ' resolved outside standalone: ' + resolved); await import(pathToFileURL(resolved).href); } const onnxRuntime = require.resolve('onnxruntime-node'); if (!onnxRuntime.startsWith(standaloneRoot)) throw new Error('onnxruntime-node resolved outside standalone: ' + onnxRuntime); await import(pathToFileURL(onnxRuntime).href);"

# ── Runner base ────────────────────────────────────────────────────────────
FROM base AS runner-base

LABEL org.opencontainers.image.title="omniroute" \
  org.opencontainers.image.description="Unified AI proxy — route any LLM through one endpoint" \
  org.opencontainers.image.url="https://omniroute.online" \
  org.opencontainers.image.source="https://github.com/diegosouzapw/OmniRoute" \
  org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOSTNAME=0.0.0.0
# Runtime heap ceiling. 1024MB is enough for normal traffic but can be tight
# for large fusion-combo panels (many models fanned out in parallel, each
# response buffered in full — see open-sse/services/fusion.ts::FUSION_DEFAULTS
# .maxPanel, issue #1905). Override at `docker run` time with
# `-e OMNIROUTE_MEMORY_MB=2048` (or higher) if you raise fusionTuning.maxPanel
# above the default cap.
ENV OMNIROUTE_MEMORY_MB=1024
ENV NODE_OPTIONS="--max-old-space-size=${OMNIROUTE_MEMORY_MB}"

# Data directory inside Docker — must match the volume mount in docker-compose.yml
ENV DATA_DIR=/app/data
# Docker copies the ownership of an existing image directory into a fresh named
# volume. Both token and Codex-home mounts must be writable by UID 1000 even when
# an app profile mounts the volume before the Codex sidecar starts.
RUN mkdir -p /app/data /run/codex-appserver /home/node/.codex

# `npm run build` (build-next-isolated → assembleStandalone) bundles ALL runtime
# files into .build/next/standalone/ — .next, node_modules, migrations, scripts,
# docs, and the previously hand-COPY'd modules below (@swc/helpers, pino-*, split2,
# migrations). assembleStandalone copies them straight from the builder's
# node_modules, so they are present regardless of NFT/Turbopack trace behaviour.
# The old per-module overrides were therefore pure duplication and were removed
# (build-output-isolation cleanup). See scripts/build/assembleStandalone.mjs
# (EXTRA_MODULE_ENTRIES) for the single source of truth.
COPY --from=builder --chown=node:node /app/.build/next/standalone ./
# better-sqlite3 is the one exception still copied explicitly: assembleStandalone
# only syncs its native build/ dir; the JS wrapper (lib/, package.json) is left to
# Next.js tracing. bootstrap-env requires SQLite BEFORE the standalone server
# starts, so guarantee the complete package independent of trace behaviour.
COPY --from=builder --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
# migrations land at <standalone>/migrations via assembleStandalone; point the runtime at them.
ENV OMNIROUTE_MIGRATIONS_DIR=/app/migrations

# Docker healthcheck script — not traced by Next.js standalone output, so copy
# it explicitly. The HEALTHCHECK CMD references it as `node healthcheck.mjs`.
COPY --from=builder --chown=node:node /app/scripts/dev/healthcheck.mjs ./healthcheck.mjs

# COPY sets ownership while creating the runtime tree. Preserve ownership of
# the existing /app inode and the small writable/mount directories without a
# second recursive walk over the complete standalone tree. UID/GID stay 1000.
RUN chown node:node /app /app/data /run/codex-appserver /home/node/.codex \
  && chmod 700 /run/codex-appserver /home/node/.codex

EXPOSE 20128

# Drop to non-root before ENTRYPOINT/CMD so every derived stage (runner-cli,
# runner-web) also runs as a non-root user unless they explicitly switch back.
USER node

# Check the final complete SQLite COPY as the actual non-root runtime user.
RUN --network=none node -e "const assert=require('node:assert/strict'); assert.equal(require('better-sqlite3/package.json').version,'13.0.3'); const db=require('better-sqlite3')(':memory:'); assert.equal(db.prepare('SELECT 1 AS ok').get().ok,1); db.close()"

# Warns if the mounted data volume has wrong ownership
COPY --chmod=755 scripts/check-permissions.sh /app/check-permissions.sh
ENTRYPOINT ["/app/check-permissions.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "dev/run-standalone.mjs"]

# ── Runner Web (web-cookie providers: Gemini Web, Claude Turnstile) ───────────
#
#  Two image flavors:
#    runner-base  →  omniroute:VERSION        Lean base (~500 MB). No browsers.
#    runner-web   →  omniroute:VERSION-web    +Chromium/Playwright (~800 MB).
#
#  Use runner-web when you need web-cookie providers (gemini-web, claude-web,
#  claude-turnstile). For all other providers runner-base is sufficient.
#
#  Build:
#    docker build --target runner-web -t omniroute:web .
#  Compose:
#    build:
#      context: .
#      target: runner-web
FROM runner-base AS runner-web

USER root

# Copy playwright and playwright-core from the builder stage.
# The slim runtime image does not have playwright in node_modules, so npx falls
# back to a registry download — unreliable on CI runners (exits 127 on failure).
# Copying from the builder avoids any network access at image-build time and also
# ensures the same playwright version is available at runtime for web-session providers.
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright

# Install Playwright browser binaries + OS dependencies under root, then hand
# ownership of the browsers cache to the node user.
# PLAYWRIGHT_BROWSERS_PATH overrides the default ~/.cache/ms-playwright so the
# browsers land under /home/node which persists across image layers and is
# accessible to the non-root runtime user.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright
RUN --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && node node_modules/playwright/cli.js install chromium --with-deps \
  && chown -R node:node /home/node/.cache \
  && rm -rf /var/lib/apt/lists/*

USER node

FROM runner-base AS runner-cli

# Drop back to root briefly so we can install system + global npm packages,
# then return to the `node` non-root user before the CMD inherited from
# runner-base runs.
USER root

# The CLI image can use the internal ChatGPT Web (Codex) Chromium sidecar over
# CDP without installing a second browser in this container.
COPY --from=builder /app/node_modules/playwright-core ./node_modules/playwright-core
COPY --from=builder /app/node_modules/playwright ./node_modules/playwright

# Install system dependencies required by openclaw (git+ssh references).
RUN --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-apt-cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,id=s/92ca8a61-c1ba-421f-a389-d48ac7258c2d-apt-lists,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates docker.io docker-compose \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system url."https://github.com/".insteadOf "ssh://git@github.com/"

# Lock all four CLI trees (Codex0.153.2, Claude2.1.260, Droid0.212.0,
# OpenClaw2026.9.1) without changing standard global package or bin paths.
# Nested installation keeps each complete dependency/resource tree contained.
# Deny broad hooks; only the reviewed, hashed setup entrypoints run offline.
COPY --chmod=444 scripts/build/install-docker-cli-tree.mjs scripts/build/setup-docker-clis.mjs scripts/build/verify-docker-clis.mjs /opt/omniroute-docker-build/
RUN --network=none --mount=type=bind,from=cli-dependencies,source=/tmp/docker-cli-tree,target=/tmp/docker-cli-tree \
  chmod 755 /opt/omniroute-docker-build \
  && node /opt/omniroute-docker-build/install-docker-cli-tree.mjs \
  && node /opt/omniroute-docker-build/setup-docker-clis.mjs

USER node

# Prove the installed CLIs and their packaged native bindings work offline as
# the final runtime user, without login, providers, first-run setup or updates.
RUN --network=none node /opt/omniroute-docker-build/verify-docker-clis.mjs

# Combined deployment target for CLI and browser-backed providers. The browser
# revision follows the project's locked Playwright version, never a runtime download.
FROM runner-cli AS runner-browser-cli
USER root
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
  --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  apt-get update \
  && apt-get install -y --no-install-recommends xvfb xauth x11vnc novnc websockify \
  && node node_modules/playwright/cli.js install chromium --with-deps \
  && chmod -R a+rX /ms-playwright \
  && chown root:root /app
COPY --chmod=444 scripts/build/verify-browser-runtime.mjs /opt/omniroute-docker-build/verify-browser-runtime.mjs
USER node
RUN --network=none node /opt/omniroute-docker-build/verify-browser-runtime.mjs
