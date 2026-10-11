---
title: "Audit Directory Preservation and Reclamation"
---

# Audit directory preservation and reclamation

**Status:** archived and removed from Maria on 2026-10-11. The protected archive was re-verified on DevVM on 2026-10-11; no raw audit payloads were pushed to GitHub.

Before cleanup, the local `/home/ubuntu/_/omni/audit` tree measured about 21 GiB. Its largest measured areas were:

| Directory | Approx. size | Findings and preservation status |
| --- | ---: | --- |
| `prime-catalog-20261006` | 5.7 GiB | Contains 4.1 GiB of `source/node_modules` and 1.4 GiB of `source/.build`. Its source revision `67503e560a` is already reachable from `origin/local`. |
| `provider-image-20261006` | 3.1 GiB | Contains a 1.4 GiB CLI dependency tree, 1.3 GiB of `source/.build`, 67 MiB of source dependencies, and small deployment logs/JSON. The generated dependency/build copies were removed; remaining snapshot files and logs are preserved in the private archive. |
| `ledger-implementation-20261006` | 3.5 GiB | Includes multiple release snapshots and two copied Git databases (454 MiB and 43 MiB). Their source commits `e3bf4b1ab5` and `7a3bf7ef73` are reachable from fork branches. |
| `ledger-release-heapcap-250f` | 2.1 GiB | Contains repeated load-test artifacts and protected private-data directories. The `250f` source commit is reachable from fork branches. |
| `codex-overlay-1327bd9155` | 1.6 GiB | Includes 1.4 GiB of generated `.build` output plus a protected staging-data directory. |
| `git-separation-20261006` | 1.5 GiB | Old repository-metadata backup, preserved in the private archive. Blue and green now have independent Git directories. |
| `antigravity-concurrency-20261006` | 832 MiB | Reverse-engineering SDK trees and IDE/Hub archives. The SDK repos are `google-antigravity/antigravity-sdk-python` at `12f9a4c3becf` and `googleapis/js-genai` at `ca5690c0999f`; both can be re-fetched at those commits. |

All 11 `ledger-release-*` commit snapshots checked during this inventory are reachable from at least one `origin/*` ref. These source revisions therefore do not need duplicate branches. This inventory does not upload copied `node_modules`, build outputs, executable bundles, raw request/response logs, or private payloads to GitHub.

Before archiving, these regenerable copies were removed: `prime-catalog-20261006/source` (5.6 GiB), `provider-image-20261006/source/.build` (1.3 GiB), `codex-overlay-1327bd9155/source/.build` (1.4 GiB), and `provider-image-20261006/cli-tree/node_modules` (1.4 GiB). Their source/installer revisions remain recoverable from the fork and the audit files left in place.

The remaining audit tree was streamed to `/mnt/devvm/custom/omni-audit-archive-20261011/audit-20261011.tar.zst` with root metadata, ACLs, xattrs, and hardlinks preserved. The file is 7,756,273,007 bytes (7.22 GiB); its uncompressed tar stream is 16,372,039,680 bytes. It is mode `0600` inside a mode-`0700` directory. The archive passed `zstd -t`, SHA-256 verification, and a full tar listing. SHA-256: `5e879fd426ea8264aef79be3151b7aac0a2b3fa169f2bf279e4120020d20a3bd`.

After verification, the local `/home/ubuntu/_/omni/audit` tree was removed in a low-priority batch. Maria's available root space increased from about 45 GiB to 62 GiB (about 17 GiB reclaimed). Some directories contained hardlinks shared across snapshots, so the physical reclaim was smaller than their individually measured `du` totals. I/O pressure rose during ext4 discard and later settled; no services or user sessions were stopped. Protected payload contents were not inspected, and the archive remains private on DevVM.
