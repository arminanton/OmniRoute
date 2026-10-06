---
title: Paired Prime Omni extension candidate
---

This is a review artifact for both Maria and devvm, not an installed extension.
The same source and regression tests cover both hosts. `hosts.json` preserves
Maria's localhost endpoint and devvm's Tailscale endpoint. An ingress migration
can change that manifest after validation; deployment requires operator approval.

Prepare separate artifacts with `node integrations/prime-agent/omni/prepare-host.mjs
maria /tmp/prime-omni-maria-review` and the same command with `devvm` and a separate
output directory. The generator refuses to overwrite an artifact, prints safe
hashes, and never installs, reloads, reads credentials or mutates a session.
Copy each generated `index.ts` only at the approved client application stage.
Do not install the template unchanged on devvm: its fallback is Maria's URL.
`OMNI_PRIME_BASE_URL` can override either host's endpoint explicitly.

The candidate keeps configured-only alias discovery, verified context/output
metadata, response-body timeout classification and failure notifications. It adds
single-flight refresh, one bounded readiness retry, visible unknown/dynamic cost
labels, and `/omni-billing <model-id>` for provenance and native billing units.
A failed refresh does not replace the last valid provider definitions.

Prime's model SDK requires numeric costs. Unknown costs therefore still need zero
placeholders internally; labels and warnings explicitly distinguish them from free
usage. Dynamic combo cash totals require actual routed response billing evidence,
which this extension does not infer from a static catalog. No runtime/core worker
migration is claimed: the fixture tests cannot prove all saved canonical sessions
or worker reuse races in Prime's compiled daemon. Real resumed-session tests must
be run with the exact approved artifacts, on both hosts, without disrupting active
user sessions.
