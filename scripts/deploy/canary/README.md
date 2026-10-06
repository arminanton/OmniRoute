# Staged canary cutover implementation

This is source for review and disposable testing, **not an installed deployment
mechanism**. Nothing here updates production services, containers, namespaces,
Tailscale, Prime endpoints, firewall rules or the installed deploy-swap controller.
The existing deployer is a stop/start transaction; do not bypass its restrictions.

## Implemented contracts

- `controller.py` binds immutable old/candidate manifests and readiness proofs,
  requires distinct blue/green generation namespaces/addresses, rejects overlapping
  helper upgrades, and journals promotion intent before selecting admission.
- Owner-private no-follow journal, persistent lock inode, atomic replacement and
  file/directory fsync preserve recovery decisions. The actual observed front-door
  generation is authoritative after a crash. Unknown selection is refused.
- No approval, stale readiness, missing overlap check or invalid configuration
  means no selection. Host adapter approval must bind the exact transaction digest.
- Healthy long SSE/WebSocket requests have no forced deployment drain deadline.
  Retention requires bodies, uploads, WebSockets, conversation pins and upstream
  permits to be finished/fenced; selection alone does not permit termination.
- Retained-old switch-back changes new admission only. It never restores a database,
  replays a POST or claims to repair failed in-flight responses.
- `runtime.py` compiles app-only generation-specific argv from the existing strict
  residential runtime, retaining UID, caps, read-only root, no-pull, resolver,
  mounts, quotas and namespace security choices. Receipt validation is a compiler
  gate, **not** proof or authorization to execute the output.
- `host.py` permits only the fixed root-installed, fingerprint-bound adapter
  protocol. Its staged adapter and collector refuse privileged checkout execution; actual
  installation requires a separate review of namespace provisioning, fixed policy,
  egress attestation, helper gateway and state ownership.
  No fallback to arbitrary commands or the stop-all deployer exists.
- `proxy.py` renders unbuffered SSE/POST and WS upgrade configuration, disables
  upstream retries/mirroring, strips internal selection/auth headers and generates
  both listeners from one generation. Its private generation endpoint proves the
  selected config only; host ACK must additionally observe **actual app generation**
  on new authenticated requests through dashboard/API front doors.
- Trusted forwarded protocol is configuration, not a caller header or `$scheme`
  guessed behind Tailscale's TLS termination. Ingress policy must attest that trust.
- `readiness.py` separates headers/body/JSON/semantic/generation failures and records
  only redacted category, status, elapsed time and proof hash. No response bodies,
  URLs, keys, exception strings or subprocess stderr become diagnostics.
- `ingress.mjs` is a real unprivileged HTTP/upgrade ingress core used in the network
  fixtures. Selection affects subsequent requests synchronously across listeners,
  while existing body/upgrade sockets stay attached to their original backend.
  There is no HTTP canary-selection endpoint. This core is not installed, does not
  yet provide a production control socket/authorization, and does not stand in for
  testing NGINX workers or the actual Tailscale path.

## Tests

Run from repository root:

```sh
python3 -m unittest discover -s tests/integration -p test_canary_controller.py -v
node --test tests/integration/canary-ingress.test.mjs
```

The network fixture keeps 100 SSE responses, an upload and an upgraded WebSocket
on the old backend during admission switch. New dashboard/API requests reach the
candidate. It verifies single dispatch of every POST, unchanged Authorization,
stripped forged internal selection headers, and completion-based counters.
Tests use only loopback listeners and no inference calls or user state.

## Remaining mandatory installation/acceptance gates

1. Current deployed `67503e560a` has process-local account permits. Both overlapping
   images must support the same enabled shared-capacity, OAuth-refresh, scheduled-job
   and conversation/cache coordination contracts. An approved compatibility bootstrap
   may be required before seamless future promotions are possible.
2. Root adapter implementations must provision generation-specific namespaces and
   attest residential egress separately for each. Existing per-generation loopback
   helper addresses require stable, policy-verified forwarding; do not duplicate
   Chrome profiles, Codex token writers or browser-login control ownership.
3. DB migrations and startup effects must be proven old/new compatible. Private
   snapshot validation alone does not authorize a stale snapshot for live service.
4. Install/test the chosen ingress and acknowledged routing control; verify 30/70/100
   real protocol conversations through TLS, slow consumers, cancellation, uploads,
   long streams, WS, continued tool turns, cold catalogs, real completion and helper
   compatibility. NGINX is not installed on this test host, so its reload semantics
   have **not** been demonstrated by these network-core fixtures.
5. Prove one-time migration of both dedicated Tailscale Serve mappings and Maria's
   socket-forwarded loopback target. Devvm public and Maria local names may stay
   unchanged if both front doors target the same stable proxy. Do not change Prime
   URLs merely because backend generations change.
6. Root-controller fingerprints, fixed adapter binaries/configs, seccomp/namespace
   policy, observation/disk/RAM budget and retained-generation retirement/GC require
   review. No garbage collector/force-kill path is provided here.
7. Present exact image, test evidence, state compatibility, initial migration impact,
   switch-back limitations and retained-old plan; obtain explicit operator approval
   before production installation or promotion.

## Staged privileged adapter and collector

`adapter` and `boundary-check` are isolated-Python entry wrappers. They refuse
checkout execution (including when invoked by root), fingerprint every root-owned
installed helper module and the existing runtime launcher, and import only from
that reviewed root installation. `adapter.py` implements the fixed operations:
read-only overlap/approval/admission/drain verification, validate-proxy,
select-proxy and start-candidate. Mutations require a fixed root-private lock plus
an exact fresh root-installed launch/selection approval. Podman starts are detached
and require a full CID acknowledgment. No operation installs or changes network
namespaces, helper services, tailscaled or firewall rules.

`boundary.py` checks a fresh per-generation `residential-v1.json` against the
current boot, actual namespace inode and 15-second attestation contract. It also
requires independently refreshed, root-private helper-forwarding evidence; an
operator's root-reviewed schema-overlap proof; exact running CID/image/revision;
and authenticated app-origin `/api/canary-readiness` observations. The runtime
compiler mounts the generation's own attestation and resolver; it never reuses a
live namespace claim for a different namespace. Missing provisioning/proofs are
hard refusals, not permission to launch with the old namespace or weaker isolation.

The readiness endpoint contract is `omni-canary-readiness/v1` with actual configured
coordination protocol/capabilities and lifecycle counts. The collector rejects
unknown/missing state. A retired generation additionally needs pending upload,
conversation pin and upstream lease counts; unavailable observations must retain
it rather than assume zero. The other ledger implementation supplies this endpoint.

The two wrappers are source candidates only. Installing them would require a
reviewed root-private `layout.json`, fixed binary/module hashes, root-provisioned
run directory and namespaces, root-maintained residential/helper attestations,
root-private readiness credentials, explicit compatibility records and separately
reviewed launch/selection approvals. No installation recipe automatically produces
approval or synthesizes a successful boundary claim. These requirements prevent
running untrusted source checkouts as root or bypassing the existing egress guard.

The adapter acknowledges proxy selection before applying the old generation's
reversible admission fence. Fencing refuses active-generation selection or retained
conversation pins. Recovery repeats that fence idempotently after observed cutover.
Switch-back first clears the retained generation's fence under fresh exact selection
approval, rechecks readiness, switches new admission and then fences the displaced
candidate. `POST /api/canary-drain` is manager-authenticated and generation-bound;
it does not send SIGTERM or interrupt healthy existing response bodies/WebSockets.
Unknown nullable counters fail closed and cannot authorize retirement.

NGINX PID/control uses the dedicated fixed canary run directory; reload must never
signal an unrelated system NGINX master. Raw NGINX error logging is disabled to avoid
credential-bearing URI leakage. Syntax-check stderr is captured by the fixed adapter
and reported only as a redacted operation failure. Access metadata contains no URI,
headers, body, key, model prompt or operator-supplied request ID.

Schema compatibility and stable maintenance-owner attestations bind the exact
old/new generation pair. Maintenance evidence includes current boot, stable helper
artifact set, an independently verified healthy/fenced owner and a short freshness
lease. Traffic replicas must actually suppress periodic registration through the
startup barrier and verify the shared owner's live ownership probe; environment
flags alone are not readiness. This source adds no arbitrary maintenance helper
launch role. Its provisioning/upgrade is independently reviewed infrastructure.
