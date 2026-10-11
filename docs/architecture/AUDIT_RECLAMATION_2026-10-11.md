# Audit directory preservation and reclamation

**Status:** inventory complete; archive and deletion pending. No audit files have been removed.

The local `/home/ubuntu/_/omni/audit` tree is about 21 GiB. Its largest measured areas are:

| Directory | Approx. size | Findings and preservation status |
| --- | ---: | --- |
| `prime-catalog-20261006` | 5.7 GiB | Contains 4.1 GiB of `source/node_modules` and 1.4 GiB of `source/.build`. Its source revision `67503e560a` is already reachable from `origin/local`. |
| `provider-image-20261006` | 3.1 GiB | Contains a 1.4 GiB CLI dependency tree, 1.3 GiB of `source/.build`, 67 MiB of source dependencies, and small deployment logs/JSON. The generated trees are reproducible; confirm the source snapshot hash against the fork before removing its remaining source files. |
| `ledger-implementation-20261006` | 3.5 GiB | Includes multiple release snapshots and two copied Git databases (454 MiB and 43 MiB). Their source commits `e3bf4b1ab5` and `7a3bf7ef73` are reachable from fork branches. |
| `ledger-release-heapcap-250f` | 2.1 GiB | Contains repeated load-test artifacts and protected private-data directories. The `250f` source commit is reachable from fork branches. |
| `codex-overlay-1327bd9155` | 1.6 GiB | Includes 1.4 GiB of generated `.build` output plus a protected staging-data directory. |
| `git-separation-20261006` | 1.5 GiB | Old repository-metadata backup. Blue and green now have independent Git directories; compare every remaining backup ref with the fork before removing this copy. |
| `antigravity-concurrency-20261006` | 832 MiB | Reverse-engineering SDK trees and IDE/Hub archives. The SDK repos are `google-antigravity/antigravity-sdk-python` at `12f9a4c3becf` and `googleapis/js-genai` at `ca5690c0999f`; both can be re-fetched at those commits. |

All 11 `ledger-release-*` commit snapshots checked during this inventory are reachable from at least one `origin/*` ref. These source revisions therefore do not need duplicate branches. This inventory does not upload copied `node_modules`, build outputs, executable bundles, raw request/response logs, or private payloads to GitHub.

The safe reclamation sequence is to copy the audit tree as an access-restricted, compressed archive to `/mnt/devvm/custom/omni-audit-archive-20261011/`, verify its checksum and readable archive listing, then remove the local audit tree in low-priority batches while watching Maria's I/O pressure. This preserves protected evidence off-host without publishing it to the fork. Regenerable `node_modules`, `.build` output, CLI trees, and the obsolete Git-metadata backup can then be removed from the archive if a smaller retained evidence set is desired.

**Not yet done:** no archive has been transferred or verified, and no audit data has been deleted. Protected payload contents were not inspected.
