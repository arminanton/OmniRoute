# OmniRoute Container Build Architecture & Optimization Plan

## 1. Root Cause Analysis: Why Clean Builds Are Slow

Analysis of `/home/ndsadmin/_/omnirouter/src/Dockerfile` and `bin/omniroute-fix.Containerfile`:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ STAGE 1: Base (node:26-trixie-slim)                                             │
│ • `apt-get upgrade -y` downloads & updates all Debian packages from scratch.     │
│ • `npm install -g npm@latest` + custom CVE patching script.                      │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ STAGE 2: Builder                                                                 │
│ • `apt-get install python3 make g++` installs a full heavy C++ compiler.         │
│ • `node-gyp rebuild` compiles `better-sqlite3` C++ source from scratch on ARM64!│
│ • `next build` compiles dashboard and API routes.                                │
│ • `assembleStandalone.mjs` packages the server.                                  │
└────────────────────────────────────────┬─────────────────────────────────────────┘
                                         ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ STAGE 3: omniroute-fix.Containerfile (Second Layer Build)                       │
│ • Node script patches `package.json` to strip `"type": "module"`.                │
│ • `curl | sh` downloads and installs Codex CLI from the internet every build.   │
└──────────────────────────────────────────────────────────────────────────────────┘
```

### The 4 Main Bottlenecks:
1. **Compiling SQLite from C++ Source**:
   `--ignore-scripts` on `npm ci` blocks `better-sqlite3` from using its prebuilt binary, forcing `node-gyp rebuild` to compile SQLite C++ source code on the ARM64 CPU.
2. **Two-Stage Dockerfile Execution**:
   Building `omniroute:raw` via `Dockerfile` and then immediately running a second build `omniroute:base` via `omniroute-fix.Containerfile`.
3. **Repeated Remote Downloads**:
   Codex CLI is re-downloaded via `curl` on every container fix build instead of being baked in or pre-cached.
4. **`/tmp/cmux-drop-...png` Occurrences**:
   Originates from terminal multiplexer (`cmux`) paste/screenshot captures written to host `/tmp/`, captured when build commands run in interactive terminal contexts.

---

## 2. The 4-Step Build Optimization Strategy

### Optimization 1: Use Prebuilt Binaries for `better-sqlite3`
* `better-sqlite3` provides precompiled `linux-arm64` and `linux-x64` prebuilds.
* Running `prebuild-install` or verifying the prebuilt binary saves 2–3 minutes of pure C++ compiler overhead.

### Optimization 2: Single-Stage Build (Eliminate `omniroute-fix.Containerfile`)
* Fix the `"type": "module"` stripping directly inside `scripts/build/assembleStandalone.mjs`.
* Consolidate everything into a single `Dockerfile` target (`localhost/omniroute:base`), eliminating the second `podman build` command completely.

### Optimization 3: Local Binary Caching for Codex CLI
* Copy the verified local Codex binary (`/home/ndsadmin/.local/bin/codex`) into the build context or cache the release installer tarball locally, avoiding flaky external network downloads during container builds.

### Optimization 4: Podman Build Cache Mounts
* Ensure `--mount=type=cache,target=/root/.npm` and `--mount=type=cache,target=/var/cache/apt` are preserved so subsequent rebuilds take **seconds instead of minutes**.
