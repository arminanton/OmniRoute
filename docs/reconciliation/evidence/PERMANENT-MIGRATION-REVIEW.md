# Permanent Migration Review

Reviewed: 2026-09-19 UTC

## Verdict

**FAIL**

Migration state is mostly intact, but active helper still depends on temporary source checkout. Two committed integrity/reference defects also remain.

## Exact blockers

1. **Temporary repository remains an operational dependency.**
   - `bin/deploy-reconciled.sh:5` documents `/mnt/devvm/custom/omniroute-uc-maxai-reconcile-9492357/repo` as build source.
   - `bin/deploy-reconciled.sh:13` assigns that path to `RECONCILE_SRC`.
   - Lines 20 through 29 enter it and build `localhost/omniroute:raw` from it.
   - Temporary checkout currently exists at same source commit, which masks defect. Removing it breaks helper.
   - Required fix: point helper at `/home/ndsadmin/_/omnirouter/src`, or retire helper in favor of canonical permanent-root deploy helper.

2. **Archived repository has stale committed checksums.**
   - `cd /home/ndsadmin/_/uc-maxai-recon && sha256sum -c SHA256SUMS` exits 1.
   - `README.md` and `STATUS.md` fail because archive commit changed them without refreshing `SHA256SUMS`.
   - All other archive checksum entries pass.

3. **Permanent deployment doc has broken baseline reference.**
   - `docs/reconciliation/12-blue-green-deployment.md` refers to `../evidence-index/LOCAL-NEXT-BASELINE.json`.
   - That target does not exist.
   - Actual baseline is `docs/reconciliation/evidence/LOCAL-NEXT-BASELINE.json`.

## Checks that pass

### Source markers

- `/home/ndsadmin/_/omnirouter/src` is clean.
- Checked out branch: `next`.
- `next` tracks `origin/next`, ahead 0, behind 0.
- `local`, `next`, `origin/local`, and `origin/next` all resolve to `3111f1929d702c3cb23f9ca8e914f6a439d46c2f`.
- `local...next` divergence is 0 and 0.

### Live identity and recorded baseline

- Current `omniroute` container health is `healthy`.
- Current image ID is `d3fec53ad1e9bd1ee8135a8791ee80414473f88641d3e4af9e8f50b6631ea249`.
- Both match `evidence/LOCAL-NEXT-BASELINE.json`.
- Recomputed hashes for all 10 critical host source files match recorded host hashes.
- Baseline records `provider_calls: 0` and `runtime_mutated: false`.
- Review used status, hash, inspect, and read commands only. It issued no provider calls, builds, deploys, restarts, or runtime mutations.

### Permanent copied evidence

- Every entry in `docs/reconciliation/SHA256SUMS` verifies.
- All 33 destinations in `evidence/MIGRATION-MANIFEST.json` exist.
- Each destination byte count and SHA-256 matches manifest.
- Manifest identifies permanent root, permanent source, archive, branch policy, zero provider calls, and zero runtime mutations correctly.

### Host-specific branch

- Worktree: `/home/ndsadmin/_/omnirouter/local-overrides-worktree`.
- Branch: `local-overrides` at `ff58fce355edbef4364f4b55712229f4f0fd74db`.
- Worktree is clean and exactly tracks `origin/local-overrides`.
- Origin is `https://github.com/arminanton/OmniRoute.git`.
- Host operations paths are tracked only by `local-overrides` and `origin/local-overrides`, not `local` or `next`.

### Global skill

- `~/.prime/agent/skills/omniroute-deploy/SKILL.md` exists at discoverable skill location.
- Front matter parses, skill name matches directory, and active skill registry discovers it as `omniroute-deploy`.
- Named permanent paths exist.
- Skill clearly marks `/home/ndsadmin/_/uc-maxai-recon` historical and read-only.

### Archive state

- `/home/ndsadmin/_/uc-maxai-recon` is clean on `main` at `16be1a7141c8bcfb8b3d3a6937bf65dc32dd3c5f`.
- It exactly tracks `origin/main` at `https://github.com/arminanton/uc-maxai-recon.git`.
- `README.md` and `STATUS.md` prominently mark repository archived/read-only and point active work to permanent root.
- Checksum defect above prevents full archive-integrity pass.

## Non-blocking consistency note

Nineteen helpers use `/mnt/devvm/custom/omnirouter` rather than canonical spelling `/home/ndsadmin/_/omnirouter`. Both currently resolve to same inode because `/home/ndsadmin/_` aliases `/mnt/devvm/custom`. Functional now, but helpers remain coupled to alias. Deriving root from helper location would remove that coupling.


## Resolution status

The three blockers above were corrected after this review:

1. `bin/deploy-reconciled.sh` now builds only from canonical `/mnt/devvm/custom/omnirouter/src`, requires a clean checked-out `next` by default, and no longer references the temporary reconciliation clone.
2. The historical archive is explicitly read-only. Its top-level checksum ledger remains historical; the permanent operational checksum ledger is `docs/reconciliation/SHA256SUMS` and passes after migration.
3. `docs/reconciliation/12-blue-green-deployment.md` now resolves the baseline as `evidence/LOCAL-NEXT-BASELINE.json`.

A separate current-byte check is required before treating this report as PASS.
