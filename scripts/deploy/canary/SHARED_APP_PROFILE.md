# Explicit shared existing APP namespace profile

The installed egress topology/controller supports only omni-wan, omni-app and
omni-probe. Its actual publisher continuously verifies the existing APP inode,
interface pins/node firewall, timed kernel gate, selected residential exit and
calibrated probes before publishing `/run/omni-egress/public/residential-v1.json`.
There is no installed per-generation namespace or helper-forwarding producer.

Schema2 `shared-existing-app-v1` is a distinct app-only alternative. Schema1
continues requiring isolated generation namespaces. No old validator is relaxed,
no existing attestation is copied/rebound, and no synthetic forwarding flag is
created. All applications have the same trusted owner/UID/shared DB; this is not
a tenant-isolation claim. PID/mount namespaces, immutable images, read-only roots,
UID10001/no capabilities/no-new-privileges and existing residential boundaries
remain in place. Browser/Codex/browser-login stay single existing processes.

| Role        | Dashboard | API   | Embed WS | Live WS |
| ----------- | --------- | ----- | -------- | ------- |
| blue        | 30128     | 30129 | 30131    | 30132   |
| green       | 30228     | 30229 | 30231    | 30232   |
| maintenance | 30328     | 30329 | 30331    | 30332   |

Each descriptor binds schema/profile, unique32hex generation, slot, image/revision,
`namespace:omni-app`, `address:10.203.242.2`, stateOwner and actual helperSet hash.
The fixed runtime derives ports from the slot; caller ports/commands/networks are
not accepted. Original resolver/public-attestation/static-host mounts stay fixed.
Maintenance mounts only the reviewed image-matched entry/loader and is never a
traffic generation or frontdoor target.

Root installs the adapter/modules with exact implementation/binary fingerprints
and a schema2 layout using `activation:approved-shared-existing-app-v1`. It binds
exact blue/green runtime/image/receipt records, one maintenance record/entryReceipt,
listeners21028/21029, private readiness key and reviewed schemaProofSha256. Schema
compatibility is an actual review bound to those exact images in the root-owned
layout, not an unproduced external “verified” file. Stable helper identity is
observed directly from exact existing CID/image/running PID/APP inode and sockets;
helperSet is the digest of ordered `{role,cid,image}` observations. Native CDP is
inherently unauthenticated inside this existing namespace and is not mislabeled
as authenticated or forwarded to another namespace.

After explicit approval, the fixed installed protocol operations are:

```sh
printf '{}' | sudo /opt/omni-local-next/canary-host/adapter --protocol=1 provision-shared-profile
printf '{}' | sudo /opt/omni-local-next/canary-host/adapter --protocol=1 observe-shared-profile
printf '{}' | sudo /opt/omni-local-next/canary-host/adapter --protocol=1 start-maintenance
```

Before ordinary overlap, `produce-schema-proof` runs bounded nonroot/networkNONE
image migration observers and read-only actual shared SQLite schema/protocol
queries, writes private schema-proof.produced.json, and returns its byte SHA.
Root reviews that exact record into schema-proof.json and binds its SHA in layout.
The collector verifies actual bytes, exact old/candidate image/revision pair and
current DB schema. Only identical migration chains are automatically observed;
changed SQL chains require a separate explicit compatibility review. No format-valid
random hash alone authorizes compatibility.

These require a fresh root-private shared-profile-approval.json binding the exact
transactionDigest/expiry. The producer verifies original actual APP namespace,
fresh real egress attestation/helper identity, then inserts only two owned WAN
output permissions before the observed final deny. UID0/65534 can reach only the
four traffic backend ports; only UID0 reaches maintenance diagnostic ports.
The fixed persistent mutation lock serializes all privileged mutations. Durable
intent/commit journals bind exact layout/transaction/owner tags; a repeated approved
provision adopts only two already-observed narrow rules, never duplicates them.
An unexpected partial/foreign rule set is refused without flushing anything.
Maintenance launch journals intent before its unique CID creation and refuses
ambiguous/incomplete retries rather than spawning a duplicate owner.
NGINX workers are explicitly nobody/nogroup UID65534. No NIC, namespace, route,
forward rule, public ingress port, namespace node firewall or residential gate is
replaced. Installed guardian interface/node-firewall expectations therefore remain
unchanged and its original renewable attestation applies to every cohort process.
Do not restart the guardian/topology merely to add a release: its ensure operation
intentionally closes the gate before revalidation.

The observer derives actual namespace/address/public claim, helper CID/image/PID,
per-generation container identity/privileges, role-bound manager responses and
maintenance image/RO entry mounts. Maintenance uses strict nontraffic503 witness
(database/protocol/coordination-three true) without overriding overall readiness.
Ordinary traffic still needs full paired state/schema/lifecycle readiness; unknown
counts retain old. The original conversation exchange and body-lifetime drain
protocol remain required. Retire only the exact drained app CID, never the shared
namespace or helper roles. Legacy675 cannot become an overlap peer by using this
profile; its separately reviewed bootstrap still applies.

Proxy config and actual-forwarded generation ACK use the companion retained asset
store and frontdoor helper. Static config marker supplies expected ID only; actual
app headers/bodies through dashboard/API must agree. Immutable delayed dashboard
chunks must remain available from retained static assets. No POST replay/mirroring. Actual marker/header/body probes execute in the verified
WAN namespace via fixed /usr/bin/ip and /usr/bin/python3.12, with key only stdin,
boot/inode rechecked around the bounded request; host loopback is not substituted.

Private evidence: actual93 blue/green/maintenance simultaneously served their own
301xx/302xx/303xx managers with separate CIDs in the same private networkNONE inode,
real shared coordinator/background ownership and generation headers. Overall503
was retained because no peer proof was completed. Different container-local CLI
identities correctly rejected peer auth; each role was probed with its real local
identity. A separate isolated Linux WAN/APP fixture proved UID65534's exact four
port grant, denied untrusted UID and node-local/public bypass, and exercised a
same-namespace authenticated fixture helper. These are honest private proofs,
not an assertion of production rollout or real provider entitlement. No live
namespace/firewall/Serve/service changes were made.
