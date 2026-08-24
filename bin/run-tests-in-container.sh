#!/usr/bin/env bash
# Run the OmniRoute unit test suite inside the omniroute:base container, where
# glibc 2.41 loads the native better-sqlite3 (the host is Oracle Linux 8.10 /
# glibc 2.28, which cannot dlopen the prebuilt — the EL8 limitation). This is the
# CI-equivalent environment. Pass test file globs/paths as args (relative to the
# repo root); defaults to the codex + previously-red set.
set -uo pipefail
SRC=/mnt/devvm/custom/omnirouter/src
IMG=localhost/omniroute:base

TESTS="${*:-}"
if [ -z "$TESTS" ]; then
  echo "usage: $0 <test-file...>  (paths relative to repo root)" >&2
  exit 2
fi

exec podman run --rm --user 0:0 \
  -v "$SRC":/src -w /src \
  -e DISABLE_SQLITE_AUTO_BACKUP=true \
  "$IMG" \
  node --max-old-space-size=8192 \
    --import tsx/esm \
    --import ./open-sse/utils/setupPolyfill.ts \
    --import ./tests/_setup/isolateDataDir.ts \
    --test --test-force-exit --test-concurrency=8 \
    $TESTS
