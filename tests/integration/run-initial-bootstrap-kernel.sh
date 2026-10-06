#!/bin/bash
# Explicit disposable kernel proof. No production namespace/firewall/Serve changes.
set -euo pipefail
: "${OMNI_TEST_NGINX_BINARY:?Set the reviewed private NGINX binary path}"
bootstrap_repo=$(cd "$(dirname "$0")/../.." && pwd)
bootstrap_node=$(readlink -f "$(command -v node)")
bootstrap_private=$(mktemp -d /tmp/omni-bootstrap-kernel-XXXXXX)
bootstrap_lab="omni-bootstrap-lab-$(python3 -c 'import uuid;print(uuid.uuid4().hex[:12])')"
bootstrap_created=0
bootstrap_inode=0
stop_owned() {
  local owned_pid=$1
  [ "$owned_pid" != 1 ] || return
  if [ "$(sudo -n stat -Lc '%i' "/proc/$owned_pid/ns/net" 2>/dev/null || true)" = "$bootstrap_inode" ]; then
    sudo -n kill -"$2" "$owned_pid" 2>/dev/null || true
  fi
}
cleanup() {
  if [ "$bootstrap_created" = 1 ] && [ "$(sudo -n stat -Lc '%i' "/run/netns/$bootstrap_lab" 2>/dev/null || true)" = "$bootstrap_inode" ]; then
    while read -r owned_pid; do stop_owned "$owned_pid" TERM; done < <(sudo -n ip netns pids "$bootstrap_lab")
    sleep 0.2
    while read -r owned_pid; do stop_owned "$owned_pid" KILL; done < <(sudo -n ip netns pids "$bootstrap_lab")
    sudo -n ip netns del "$bootstrap_lab"
  fi
  rm -rf -- "$bootstrap_private"
}
trap cleanup EXIT
sudo -n ip netns add "$bootstrap_lab"
bootstrap_created=1
bootstrap_inode=$(sudo -n stat -Lc '%i' "/run/netns/$bootstrap_lab")
sudo -n ip netns exec "$bootstrap_lab" ip link set lo up
sudo -n ip netns exec "$bootstrap_lab" ip address add 10.203.242.2/32 dev lo
cat > "$bootstrap_private/seed.nft" <<'NFT'
table inet oe_guard {
 chain output {
  type filter hook output priority -10; policy drop;
  ct state invalid drop
  ct state established,related accept
  oifname "lo" accept
  counter drop comment "output-denied"
 }
}
table ip oe_nat {
 chain postrouting {
  type nat hook postrouting priority srcnat; policy accept;
 }
}
NFT
sudo -n ip netns exec "$bootstrap_lab" nft -f "$bootstrap_private/seed.nft"
cd "$bootstrap_repo"
sudo -n ip netns exec "$bootstrap_lab" env OMNI_TEST_BOOTSTRAP_KERNEL=1 OMNI_TEST_NAMESPACE_NAME="$bootstrap_lab" OMNI_TEST_NAMESPACE_INODE="$bootstrap_inode" OMNI_TEST_NGINX_BINARY="$OMNI_TEST_NGINX_BINARY" "$bootstrap_node" --test tests/integration/initial-ingress-bootstrap.test.mjs
