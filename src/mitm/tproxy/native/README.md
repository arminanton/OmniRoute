# TPROXY transparent-socket native addon

Tiny N-API addon for Fase 3 / Epic A (TPROXY transparent capture mode). Node's
`net` module cannot `setsockopt(IP_TRANSPARENT)` before `bind()`, which TPROXY
requires (otherwise the kernel drops the redirected packets). `transparent.c`
does `socket()`+`SO_REUSEADDR`+`IP_TRANSPARENT`+`bind()`+`listen()` and returns
the raw fd; Node adopts it via `server.listen({ fd })` and reads the original
destination from `socket.localAddress`/`localPort` (TPROXY preserves it — no
`SO_ORIGINAL_DST`/NAT).

## Status: integrated, runtime opt-in

The addon is loaded conditionally by `../transparentSocket.ts` and is wired
through the capture manager, local-only API route, CA installer, and Traffic
Inspector toggle. TPROXY remains disabled unless an operator starts a capture
session. It requires Linux, a packaged/loadable addon, and `CAP_NET_ADMIN` at
runtime; a JavaScript-only or non-Linux install continues to run with TPROXY
capture unavailable.

**Viability proven on the VPS (kernel 6.8.0-124):** the prebuilt `.node`,
compiled under one Node version, loaded under a different one (N-API is
ABI-stable) and, as root, created the IP_TRANSPARENT socket which Node adopted
via `server.listen({ fd })`. The TPROXY iptables/ip-rule apply+revert was also
validated against the same kernel (see PR #4139).

## Why the addon is compiled

`transparent.c` is first-party source in this repository, not an npm package
that supplies a platform binary. The compiled `build/` and `prebuilds/`
directories are git-ignored, so a fresh source checkout has no `.node` binary
to package. The current Linux build therefore compiles the small C addon from
source. This compile has not been measured separately from the Next.js build;
it is not established as a significant part of overall build time.

## Build behavior

```bash
npm run build:native:tproxy      # developer convenience -> build/Release/transparent.node
```

The convenience script uses `npx node-gyp`. The normal release path uses
`scripts/build/build-tproxy-native.mjs`, which resolves the lock-installed
`node-gyp`, validates the active Node headers and architecture, and runs before
standalone assembly. It does not use `npx`, install a global tool, or download
headers implicitly. A host build is best-effort: if Linux headers or the C
toolchain are missing, the app still builds and TPROXY is unavailable. Docker
sets `OMNIROUTE_DOCKER_NATIVE_BUILD=1`, installs `python3`, `make`, and `g++`,
and requires the build to succeed. A separate verifier checks the receipt and
the standalone binary against the source, headers, Node runtime, and target
architecture.

## Standalone packaging

1. `build-next-isolated.mjs` invokes the best-effort helper on Linux before
   `assembleStandalone.mjs` copies native assets. Docker makes that helper
   strict, then runs `verify-docker-native-deps.mjs --require-tproxy`.
2. The assembler copies only
   `build/Release/transparent.node` to the same relative path in standalone.
3. `transparentSocket.ts` resolves that binary module-relative for source runs
   and cwd-relative for standalone runs.

The builder passes its active Linux architecture to `node-gyp`; the Docker
verifier checks that the binary and standalone copy match the target. This
supports matching Linux x64 and ARM64 builds. Non-Linux builds skip the addon.
Although the loader also recognizes `native/prebuilds/transparent.node`, the
current builder does not generate that path and the standalone assembler does
not copy it. There is no CI-produced prebuild matrix yet.

## Runtime validation

The full intercept → TLS-terminate → decrypt → capture (`source:"tproxy"`) →
re-encrypted forward → upstream round-trip was validated end-to-end on the VPS
(kernel 6.8.0), including the anti-loop fix (PR #4229). Wired via the capture
manager (#4208), the local-only route + CA installer (#4211), and the Traffic
Inspector toggle (#4216).
