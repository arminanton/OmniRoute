"""Initial legacy ingress/bootstrap artifact compiler; never executes host mutations.

Legacy675 is not a coordinator participant. Routing it through a new proxy does
not authorize overlapping generation traffic, shared OAuth writers or DB upgrades.
"""
from __future__ import annotations
import argparse
import json
import re
from .controller import Refused, digest, exact
import time

SCHEMA = "omni-initial-bootstrap/v1"
LEGACY_ADDRESS = "10.203.242.2"
PROXY_UID = 65534
PROXY_PORTS = {"dashboard": 21028, "api": 21029}


def validate(policy):
    exact(policy, {"schema", "transaction", "bootId", "wanNamespaceInode", "legacy", "guard", "proxyBinarySha256"})
    if policy["schema"] != SCHEMA:
        raise Refused("unsupported bootstrap schema")
    for value, pattern in ((policy["transaction"], r"[a-f0-9]{32}"),
                           (policy["bootId"], r"[a-f0-9-]{36}"),
                           (policy["proxyBinarySha256"], r"[a-f0-9]{64}")):
        if not isinstance(value, str) or not re.fullmatch(pattern, value):
            raise Refused("invalid immutable bootstrap identity")
    if type(policy["wanNamespaceInode"]) is not int or policy["wanNamespaceInode"] < 1:
        raise Refused("missing actual WAN namespace")
    legacy = policy["legacy"]
    exact(legacy, {"revision", "image", "cid", "helperSet", "stateOwner"})
    for name, pattern in (("revision", r"[a-f0-9]{40}"), ("image", r"sha256:[a-f0-9]{64}"),
                          ("cid", r"[a-f0-9]{64}"), ("helperSet", r"[a-f0-9]{64}"),
                          ("stateOwner", r"[a-f0-9]{64}")):
        if not isinstance(legacy[name], str) or not re.fullmatch(pattern, legacy[name]):
            raise Refused("invalid immutable legacy resource")
    exact(policy["guard"], {"generation", "policySha256", "outputDeniedHandle"})
    if not re.fullmatch(r"[a-f0-9]{32}", str(policy["guard"]["generation"])) or not re.fullmatch(r"[a-f0-9]{64}", str(policy["guard"]["policySha256"])):
        raise Refused("missing installed kernel-policy provenance")
    handle = policy["guard"]["outputDeniedHandle"]
    if type(handle) is not int or not 1 <= handle <= 2147483647:
        raise Refused("invalid observed final output-denied rule handle")
    return policy


def bridge_nft(policy):
    """Atomic NEW-connection redirects + narrow nonroot proxy backend permission.

    The installed kernel owner must verify original policy/namespace/lease before
    applying. Insertion is BEFORE the final deny, preserving invalid/IPv6 denies.
    Removing rules never flushes conntrack; established bridge flows need retention.
    """
    validate(policy)
    owner = "omni-bootstrap:" + policy["transaction"]
    handle = policy["guard"]["outputDeniedHandle"]
    return f'''# Exact reviewed WAN namespace only; nft -c is NOT permission to apply.
insert rule inet oe_guard output position {handle} meta skuid {PROXY_UID} oifname "app0" ip daddr {LEGACY_ADDRESS} tcp dport {{ 20128, 20129 }} accept comment "{owner}"
add table ip omni_ingress_bootstrap {{ comment "{owner}"; }}
add chain ip omni_ingress_bootstrap ingress_redirect {{ type nat hook output priority dstnat; policy accept; }}
add rule ip omni_ingress_bootstrap ingress_redirect meta skuid 0 ip daddr {LEGACY_ADDRESS} tcp dport 20128 redirect to :21028 comment "{owner}"
add rule ip omni_ingress_bootstrap ingress_redirect meta skuid 0 ip daddr {LEGACY_ADDRESS} tcp dport 20129 redirect to :21029 comment "{owner}"
'''


def legacy_nginx(policy, *, paused=False):
    validate(policy)
    identity = "legacy-" + policy["legacy"]["image"][7:23]
    result = '''# Ingress-only bootstrap; backend remains legacy app. No fake generation ACK.
user nobody nogroup;
pid /run/omni-local-next/canary/nginx.pid;
worker_processes 2;
events { worker_connections 4096; }
http {
 access_log off;
 error_log /dev/null crit;
 map $http_upgrade $upgrade_connection { default upgrade; '' ''; }
 client_body_temp_path /run/omni-local-next/canary/body;
 proxy_temp_path /run/omni-local-next/canary/proxy;
 fastcgi_temp_path /run/omni-local-next/canary/fastcgi;
 uwsgi_temp_path /run/omni-local-next/canary/uwsgi;
 scgi_temp_path /run/omni-local-next/canary/scgi;
 client_max_body_size 64m;
 client_body_timeout 3600s;
 send_timeout 3600s;
'''
    for port in (20128, 20129):
        result += f''' server {{
  listen {port + 900};
  location = /_omni_bootstrap_identity {{ allow 127.0.0.1; deny all; return 200 '{identity}'; }}
  error_page 502 504 = @uncertain;
  location @uncertain {{ default_type application/json; return 504 '{{"error":{{"type":"upstream_acceptance_uncertain","code":"upstream_acceptance_uncertain","message":"Ingress lost upstream response; request must not be replayed"}}}}'; }}
  location / {{
   proxy_intercept_errors off;
   proxy_pass http://{LEGACY_ADDRESS}:{port};
   proxy_http_version 1.1;
   proxy_buffering off;
   proxy_request_buffering off;
   proxy_cache off;
   proxy_next_upstream off;
   proxy_connect_timeout 10s;
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection $upgrade_connection;
   proxy_set_header Host $http_host;
   # Preserve existing validated end-to-end credentials. Never synthesize locality trust.
   proxy_set_header X-Omni-Generation '';
   proxy_set_header X-Omni-Canary '';
   proxy_set_header X-Omni-Internal-Authorization '';
   proxy_set_header X-Omniroute-Self-Hop '';
   proxy_set_header X-Omniroute-Lease-Owner '';
   proxy_set_header X-Omniroute-Route-Class '';
   proxy_set_header X-Omniroute-Auth-Kind '';
   proxy_set_header X-Omniroute-Auth-Id '';
   proxy_set_header X-Omniroute-Auth-Label '';
   proxy_set_header X-Omniroute-Auth-Scopes '';
   proxy_set_header X-Omniroute-Cli-Token '';
   proxy_set_header X-Omniroute-Peer-Ip '';
   proxy_set_header X-Omniroute-Via-Proxy '';
   proxy_set_header X-Omniroute-Peer-Locality '';
   proxy_set_header X-Omniroute-Trusted-Peer-Ip '';
  }}
 }}
'''
    if paused:
        result = result.replace("  location / {", "  location / {\n   default_type application/json;\n   add_header Retry-After 2 always;\n   return 503 '{\"error\":{\"type\":\"deployment_bootstrap_paused\",\"code\":\"deployment_bootstrap_paused\",\"message\":\"Admission temporarily paused before upstream dispatch\"}}';")
    return result + "}\n"


def check_transition(policy, phase, evidence):
    """Fail-closed bootstrap sequencing, distinct from normal canary overlap."""
    validate(policy)
    if evidence.get("transactionDigest") != digest(policy):
        raise Refused("bootstrap evidence belongs to another transaction")
    required = {
        "bridge-ready": {"legacyIdentity", "kernelBoundary", "privateAuth", "privateStreams", "proxyUidUnused", "nginxSyntax"},
        "bridge-selected": {"existingConnectionsRetained", "bothFrontdoors", "legacyIdentity", "noDuplicatePost"},
        "admission-paused": {"acknowledgedIngress", "newAdmissionsPreDispatch", "retainedLegacyConnections"},
        "legacy-stopped": {"newAdmissionsPaused", "directConnectionsZero", "proxiedBodiesZero", "webSocketsZero", "upstreamWorkZero", "legacyConversationsResolved", "legacyBackgroundStopped", "legacyContainerStopped"},
        "baseline-ready": {"legacyContainerStopped", "liveDatabaseOwner", "schemaCompatible", "stableHelpers", "fencedMaintenance", "authenticatedColdWarm", "coordinationCapabilities"},
        "ordinary-canary": {"bothGenerationsCoordinated", "pairedConversationProof", "acknowledgedIngress", "schemaCompatible", "stableHelpers"},
    }.get(phase)
    if required is None:
        raise Refused("unsupported initial bootstrap phase")
    checks = evidence.get("checks")
    if not isinstance(checks, dict) or set(checks) != required:
        raise Refused("unknown/missing bootstrap evidence")
    for check in checks.values():
        exact(check, {"ok", "proof"})
        if check["ok"] is not True or not isinstance(check["proof"], str) or not re.fullmatch(r"[a-f0-9]{64}", check["proof"]):
            raise Refused("bootstrap condition unproven; retain legacy")
    return {"schema": SCHEMA, "transactionDigest": digest(policy), "phase": phase,
            "claim": "ingress-only" if phase.startswith("bridge-") else "quiescent-baseline" if phase in ("legacy-stopped", "baseline-ready") else "coordinated-canary"}


class BootstrapJournal:
    """Use the existing no-follow/fsynced Journal, on a separate bootstrap directory.

    This state machine records verified phase acknowledgments; it neither signs
    evidence nor executes source checkouts or privileged commands.
    """
    NEXT = {None: "bridge-ready", "bridge-ready": "bridge-selected",
            "bridge-selected": "admission-paused", "admission-paused": "legacy-stopped",
            "legacy-stopped": "baseline-ready", "baseline-ready": "ordinary-canary"}

    def __init__(self, journal, policy, clock=time.time):
        self.journal, self.policy, self.clock = journal, validate(policy), clock

    def checkpoint(self, phase, evidence):
        current = self.journal.read()
        if current is not None:
            exact(current, {"schema", "transactionDigest", "phase", "evidenceDigest", "recordedAt"})
            if current["schema"] != "omni-initial-bootstrap-journal/v1" or current["transactionDigest"] != digest(self.policy):
                raise Refused("bootstrap journal belongs to different immutable resources")
        previous = current["phase"] if current else None
        if self.NEXT.get(previous) != phase:
            raise Refused("initial bootstrap phase skipped or replayed")
        check_transition(self.policy, phase, evidence)
        record = {"schema": "omni-initial-bootstrap-journal/v1", "transactionDigest": digest(self.policy),
                  "phase": phase, "evidenceDigest": digest(evidence), "recordedAt": self.clock()}
        self.journal.write(record)
        return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("policy")
    parser.add_argument("artifact", choices=("nft", "nginx", "nginx-paused", "manifest"))
    args = parser.parse_args()
    with open(args.policy, encoding="utf8") as handle:
        policy = json.load(handle)
    validate(policy)
    print(bridge_nft(policy) if args.artifact == "nft" else legacy_nginx(policy, paused=args.artifact == "nginx-paused") if args.artifact in ("nginx", "nginx-paused") else json.dumps({"transactionDigest": digest(policy), "policy": policy}, sort_keys=True))


if __name__ == "__main__":
    main()
