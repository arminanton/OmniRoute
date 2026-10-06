# First bootstrap from live675 to coordinated canary releases

This procedure separates **ingress-only adoption** from the **one-time application
bootstrap**. The deployed675 app has no paired readiness/handoff protocol and
uses process-local admission/background ownership. A proxy cannot add those
capabilities to its running process. It must not be declared a coordinated peer.
The exact app-image93 proof remains unchanged: these are separately fingerprinted
host deployment assets, not changes to the application image.

No command below was applied to production. Production installation, rule
activation and stopping the legacy app require approval of the exact artifacts.
The compiler emits files only; a claim/evidence object is not a root authorization.

## Existing paths and bridge design

Read-only inventory on2026-10-06 found:

- Dedicated WAN tailscaled routes `omni`/`omnirouter` to10.203.242.2:20128/20129.
- Maria127.0.0.1:20129 is systemd socket activation; its root socket-proxyd joins
  omni-wan and connects to10.203.242.2:20129.
- App/helper namespace is omni-app; app ports20128/20129, helpers9222/1456 and
  existing browser-login state remain owned by the existing roles.
- WAN `oe_guard` uses conntrack invalid/established rules and permits only root
  connections to the existing app backend. Its final output-denied rule handle
  was25 at inspection; do not hardcode that handle for installation.
- Nineteen established app API/dashboard backend sockets existed at inspection.
  This is an observation, not a zero active-requests or saved-conversations proof.

The first bridge leaves Serve, MagicDNS, host socket-proxyd and their target URLs
unchanged. It adds private WAN NGINX listeners21028/21029, forwarding to the
same legacy backend. Two destination-NAT OUTPUT rules match only root-originated
NEW connections to the exact legacy address/ports. A separately narrow rule allows
NGINX workers UID65534 only to that backend through app0; workers bypass the
root-UID NAT match. The root master handles configuration, not HTTP payloads.
The UID must be unused by any other process in that namespace before activation.
The existing IPv6/invalid-packet denies stay ahead of the inserted permission.
No Obsidian20135, helper listener or general egress permission is changed.

Established TCP flows retain their conntrack mapping. **Conntrack and the existing NAT hooks must already be
active before those flows were opened.** The private kernel fixture caught resets
when adding the very first tracking/NAT hook after untracked connections existed;
matching the live guard's preexisting conntrack/postrouting-NAT contract is mandatory. Never flush
conntrack, replace the namespace, or restart tailscaled/socket-proxyd to adopt ingress.
Existing direct keepalive requests can continue bypassing the new proxy until those
connections close. After removal of the bridge table, existing redirected flows
still need the proxy; do not stop it merely because fresh flows go direct again.

## Artifact preparation and exact activation operations

1. Record actual boot ID, WAN inode, live app CID/image/revision, helper-set and
   writable-state owner fingerprints. Bind the installed kernel-policy hash and
   freshly observed final-deny handle. Bind the exact NGINX executable hash.
   Put these in a private `omni-initial-bootstrap/v1` policy; unknown fields,
   aliases such as `latest`, arbitrary UIDs/ports/commands and missing identities
   are refused by `bootstrap.py`.
2. Generate the immutable reviewed artifacts as an unprivileged operator:

   ```sh
   python3 -m scripts.deploy.canary.bootstrap POLICY.json manifest > manifest.json
   python3 -m scripts.deploy.canary.bootstrap POLICY.json nginx > nginx.conf
   python3 -m scripts.deploy.canary.bootstrap POLICY.json nft > bridge.nft
   python3 -m scripts.deploy.canary.bootstrap POLICY.json nginx-paused > paused.conf
   ```

   `POLICY.json` is an explicit required input, not an example approval. The
   transaction digest binds the exact policy; source/app/host-component digests
   must be listed separately in one reviewed release manifest.

3. Review/install the existing fixed root adapter/collector, NGINX binary and
   `omni-ingress-bootstrap.service.in`. Use the existing adapter's fixed paths:
   `/usr/sbin/nginx`, `/run/omni-local-next/canary/nginx.conf` and `nginx.pid`.
   This lets the normal generation controller later adopt the same master/config
   without a second ingress restart. The template does not create namespaces,
   start helpers or weaken the existing residential boundary. Prepare its temp
   directories for workers UID65534 with parent traversal and private body-file
   ownership; configuration/PID/approval files remain root-owned and no-follow.
4. Before activation, validate actual namespace/boot/CID/policy/UID ownership and
   use the exact installed binaries against the reviewed files:

   ```sh
   sudo ip netns exec omni-wan /usr/sbin/nginx -t -p /run/omni-local-next/canary/ -c /run/omni-local-next/canary/nginx.conf
   sudo ip netns exec omni-wan /usr/sbin/nft --check -f REVIEWED_BRIDGE.nft
   ```

   Root paths in this procedure must be installed review artifacts, not mutable
   checkout executables. `nft --check` is syntax/kernel validation, not approval.
   Take canonical ruleset snapshots before/after the check; exclude changing
   traffic counters/lease expiry, not security rules or policy structure.

5. After explicit ingress-only approval, start the installed ingress service,
   prove both private listeners and cold/warm authenticated legacy paths,
   unauthorized manager/upgrade refusal, unbuffered SSE/upload and no POST replay.
   Then the existing kernel-policy owner applies **one** exact reviewed nft batch
   in omni-wan (`/usr/sbin/nft -f REVIEWED_BRIDGE.nft`). The kernel owner must adopt
   the new permission/table in its durable policy/reboot reconciliation; an ad hoc
   rule outside its policy is not an acceptable installation.
6. Acknowledge actual routing through both public Tailscale names and Maria's
   unchanged local endpoint, plus DevVM's existing URL. Record the existing app
   CID/image/inode unchanged, established direct flows retained, and new flows
   observed at the private bridge. `/_omni_bootstrap_identity`
   proves only proxy configuration; it must not substitute for backend identity,
   authentication or actual source generation. Legacy emits no forged new-app
   generation header. Failure before activation leaves live traffic unchanged.

NGINX has buffering/replay disabled. Its own transport502/504 errors use the
explicit `upstream_acceptance_uncertain` envelope; upstream application's actual
HTTP errors are not intercepted. This prevents capable callers from blindly
replaying an ambiguous POST. Old caller workers still require a safe upgrade to
understand that marker; no proxy can prevent an external old caller from retrying.

## One-time application bootstrap: the genuine legacy limitation

Ingress-only adoption can retain every existing legacy connection and all helper
state. It does **not** make arbitrary old675 sessions portable to93. Legacy Gemini
signatures have an unnamespaced persisted key plus a process cache; new signatures
are encrypted and scoped by account/model/auth/conversation. Legacy refresh/jobs
and admission do not implement the shared coordinator. No authenticated exporter
or paired proof exists in675. Blindly copying opaque state into a new scope,
assuming TCP zero means no upstream request, or running both apps as independent
account owners would defeat the safety contract.

There are two supported procedural choices:

- **Retain legacy:** keep bridge pointing only to675 while existing agents/tool
  conversations finish. Validate93 privately with stubs/snapshot data and no live
  credential writers. This has no application restart and no promise of a deadline
  for retirement. Unknown long streams, saved conversations or orphan upstream
  requests retain old; they are never silently treated as zero.
- **Quiescent bootstrap:** separately approve a short admission pause and a reviewed
  continuation policy. Render `nginx-paused`, syntax-check and HUP the same proxy
  master. New requests get503/Retry-After before upstream dispatch; established
  direct/proxied bodies and upgrades keep their sockets. This is a transparent
  admission delay/refusal, **not** zero availability impact. Wait for direct flows,
  proxied bodies/uploads/upgrades and actual provider work to finish. TCP counts
  alone are insufficient. Resolve every required legacy conversation using a
  verified self-contained history/native opaque-state contract or explicitly
  retain it on old. There is no safe universal exporter for unknown saved sessions.

Only after those conditions are proven may the reviewed runtime stop **the exact
legacy app CID**, leaving browser/Codex/browser-login roles and their writable
profiles/home/control state intact. Do not call the old four-role deploy-swap stop
sequence. Confirm the legacy process/container and its background writers stopped;
then take a consistent authoritative DB backup/integrity proof. Never promote the
private validation snapshot as the live DB and never claim DB rollback after writes.

Launch the independently fenced maintenance owner and unique generation93 baseline
using their fixed approved runtime artifacts, shared live DB/coordinator and stable
helper gateways. `maintenanceRuntime.py` compiles the fixed maintenance command while retaining
the existing image boundary wrapper. Its immutable receipt is
`omni-maintenance-entry/v1` with `imageRevision`, `entrySha256`, `loaderSha256`.
Root-owned single-link no-follow files at
`/opt/omni-local-next/canary-host/maintenance-entry.cjs` and
`maintenance-loader.mjs` mount read-only at `/app/maintenance-entry.cjs` and
`/app/dev/run-standalone.mjs`. The reviewed entry must preserve the image runner's
server.env/bootstrap handling and execute actual app instrumentation/periodics
inside the shared fenced task; a lease-only test process is insufficient. Unique
maintenance name/CID and dedicated attested namespace are required; it must not
appear in the two traffic-generation records or be selected by the front door.
The maintenance role's actual coordinator lease and periodic
startup barrier must be observed; an env declaration or nonexistent extra launcher
flag is not evidence. A second93 generation may be used as the initial canary peer:
both immutable builds then speak the same protocol. Run the existing paired
conversation proof, schema/cache/auth readiness and account/refresh/background
coordination checks. Only a true ready result allows selection and unpausing.
The normal canary controller thereafter switches new admissions and retains active
old streams without forced drain deadlines. Never fabricate an old675 readiness
record to enter this controller.

## Recovery and proof scope

`BootstrapJournal` uses the existing no-follow/fsynced journal on a separate
bootstrap directory and refuses skipped/replayed phases or changed immutable
resources after recovery. It records evidence digests, not credentials.
The root bootstrap journal must distinguish bridge-ready/selected, admission pause,
legacy stopped, baseline ready and coordinated canary. `check_transition` validates
transaction-bound evidence requirements; it does not sign observations or execute
root commands. Missing/unknown actual collectors are a refusal to retire legacy,
not a license to create successful booleans. Preserve exact phase/artifact digests
for reboot reconciliation; never guess selection from source-slot symlinks.

Before bridge activation: stop only the transaction-owned unused ingress. After
activation: removal of only the owned NAT table switches **fresh** connections back
to legacy; retained redirected connections require the still-running proxy. Never
flush conntrack or silently replay failed POSTs. Once all redirected connections
have finished, remove only the owner-comment-bound UID permission by its freshly
verified rule handle and stop the unused proxy; do not guess handles or remove
other policy rules. After DB writes on93, switching
new traffic back does not restore historical DB state or resurrect failed streams.

The tests prove private NGINX behavior and, when explicitly run in a disposable
owned namespace, actual Linux conntrack/NAT new-flow selection, old-flow retention
and UID bypass. They do not prove real Tailscale reload behavior, all native provider
state or unknown legacy-session handoff. The chosen bridge avoids a Serve/proxyd
configuration reload altogether. Source limits, first-bootstrap admission effect
and exact installed-kernel policy acceptance belong in the approval report.

## Reproduce the offline/private acceptance

```sh
python3 -m unittest discover -s tests/integration -p test_initial_bootstrap.py -v
python3 -m unittest discover -s tests/integration -p test_maintenance_runtime.py -v
OMNI_TEST_NGINX_BINARY=REVIEWED_PRIVATE_BINARY node --test tests/integration/initial-ingress-bootstrap.test.mjs
OMNI_TEST_NGINX_BINARY=REVIEWED_PRIVATE_BINARY tests/integration/run-initial-bootstrap-kernel.sh
```

The last command requires the operator's noninteractive sudo and a reviewed
private NGINX binary. It creates only a unique owned disposable namespace with
loopback, existing conntrack/NAT hooks and no physical egress. It checks both namespace
name and inode before running the fixture, and tears down only its owned processes
and namespace. The negative first-hook and mistaken keepalive-as-fresh runs remain
in the audit evidence; the final matching-live-hook run passes.
