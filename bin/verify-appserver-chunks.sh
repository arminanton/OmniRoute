#!/usr/bin/env bash
# Verify the rebuilt omniroute image actually bundled the Codex app-server
# executor. Compares against the known dead-build baseline (all app-server
# proof strings = 0 because that image was built off feat/prime-agent-cli-catalog
# which lacks the executor). PASS = the three proof strings are now > 0.
set -uo pipefail
IMG="${1:-omniroute}"   # container name (or pass an image via a throwaway ctr)
cd /mnt/devvm/custom/omnirouter

podman unshare bash -c '
set -uo pipefail
mnt=$(podman mount '"$IMG"' 2>/dev/null)
if [ -z "$mnt" ]; then echo "MOUNT FAILED for '"$IMG"'"; exit 2; fi
BUILD="$mnt/app/.build"
CH="$BUILD/next/server/chunks"
total=$(find "$CH" -name "*.js" 2>/dev/null | wc -l)
cexec=$(grep -rl "CodexExecutor" "$CH" 2>/dev/null | wc -l)
tstart=$(grep -rl "thread/start" "$CH" 2>/dev/null | wc -l)
appsrv=$(grep -rl "CodexAppServerExecutor" "$BUILD" 2>/dev/null | wc -l)
flag=$(grep -rl "OMNIROUTE_CODEX_APP_SERVER_ENABLED" "$BUILD" 2>/dev/null | wc -l)
ctrans=$(grep -rl "codexTransport" "$BUILD" 2>/dev/null | wc -l)
turn=$(grep -rl "turn/start" "$CH" 2>/dev/null | wc -l)
captok=$(grep -rl "capability-token" "$BUILD" 2>/dev/null | wc -l)
podman umount '"$IMG"' >/dev/null 2>&1

echo "=== REBUILT IMAGE chunk audit ($(date -u +%H:%M:%SZ)) ==="
printf "  total server chunks           : %s\n" "$total"
printf "  CodexExecutor                 : %s\n" "$cexec"
printf "  thread/start        [PROOF]   : %s   (was 0)\n" "$tstart"
printf "  turn/start          [PROOF]   : %s   (was 0)\n" "$turn"
printf "  CodexAppServerExecutor [PROOF]: %s   (was 0)\n" "$appsrv"
printf "  OMNIROUTE_CODEX_APP_SERVER_ENABLED [PROOF]: %s   (was 0)\n" "$flag"
printf "  capability-token              : %s   (was 0)\n" "$captok"
printf "  codexTransport                : %s   (was 25)\n" "$ctrans"
echo
if [ "$tstart" -gt 0 ] && [ "$appsrv" -gt 0 ] && [ "$flag" -gt 0 ]; then
  echo "RESULT: PASS  ✅  app-server executor IS bundled (all 3 proof strings > 0)"
  exit 0
else
  echo "RESULT: FAIL  ❌  app-server executor STILL missing (a proof string is 0)"
  exit 1
fi
'
