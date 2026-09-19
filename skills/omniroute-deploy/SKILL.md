---
name: omniroute-deploy
description: Safely prepare, preflight, deploy, verify, or roll back the local OmniRoute container stack on this EC2 host using the permanent project root, `local`/`next` branch contract, immutable image identities, residential-egress safeguards, and honest brief-downtime container recreation. Use when asked to deploy/rebuild/release/update/roll back OmniRoute, prepare `next`, promote `local`, verify the live image, or optimize/test its container build. Do not use Prime Agent daemon hot-swap commands for OmniRoute.
---

# OmniRoute deploy workflow

## Permanent locations

- Project root: `/home/ndsadmin/_/omnirouter` (`/mnt/devvm/custom/omnirouter`)
- Canonical Git checkout: `/home/ndsadmin/_/omnirouter/src`
- Runtime helpers: `/home/ndsadmin/_/omnirouter/bin`
- Persistent workspace: `/home/ndsadmin/_/omnirouter/workspace`
- Reconciliation plans/evidence: `/home/ndsadmin/_/omnirouter/docs/reconciliation`

`/home/ndsadmin/_/uc-maxai-recon` is a historical, read-only forensic archive. Do not use it as the operational root.

## Branch contract

- `local`: frozen marker for the exact source commit deployed in production. Tracks `origin/local`. Do not develop on it.
- `next`: active integration/development branch checked out at `~/_/omnirouter/src`. Tracks `origin/next`.
- Feature work: branch from `next`, test/review, then merge into `next`.
- Move `local` only after a candidate is successfully deployed and verified.

Before deployment prove `local`, `next`, the candidate commit, image digest, and live container identity explicitly. Never infer deployed code only from a mutable image tag.

## Hard safety rules

1. Never mutate the live workspace or issue provider calls during build/preflight.
2. Refuse dirty or untracked source unless the owner explicitly authorizes and evidence is preserved.
3. Do not run broad searches, dependency installs, full builds, or full test suites as blocking root commands. Use bounded background/delegated work with progress.
4. Preserve the current live image by immutable digest before cutover.
5. Candidate preflight needs isolated writable state. Do not mount production `/app/data` read-only as the candidate's writable data directory.
6. Keep provider egress blocked through offline/private gates.
7. `omni-ts-egress` is part of recreation; remove/recreate it deliberately to avoid name conflicts.
8. Current container recreate has brief downtime. Do not call it seamless or zero-downtime.
9. The prototype `bin/omniroute-hotswap-deploy.sh` is not production-ready and must not be run.
10. True zero-downtime later requires simultaneous containers, a stable proxy, connection draining, and credential/background-job fencing.

## Prepare work

```bash
cd /home/ndsadmin/_/omnirouter/src
git status --short --branch
# must be clean and on next
git fetch origin next local
git switch next
git pull --ff-only origin next
git switch -c feature/<name>
```

For upstream-generic source fixes, keep host-specific egress/deploy code out of product branches. Host-specific helpers belong in the `local-overrides` orphan branch snapshot.

## Candidate pipeline

1. Freeze candidate source SHA/tree, lockfile hash, dirty state, build arguments, and expected provider files.
2. Run focused offline tests through the repository's existing environment. Tests must not require authenticated providers.
3. Build a uniquely tagged candidate image; record its immutable digest.
4. Scan packaged files/image configuration and verify no secrets.
5. Start candidate on separate private ports with isolated writable state and provider egress blocked.
6. Verify migrations, `/api/healthz`, provider/capability readiness, packaged runtime assets, and rollback compatibility.
7. Retain the current live image digest and source commit.
8. Recreate the live app/Redis/egress stack against candidate with explicit downtime notice.
9. Verify health, exact image ID, critical source hashes, runtime logs, and safe state.
10. Only then fast-forward/push `local` to deployed commit and append deployment evidence.

## Rollback

Rollback must use the retained prior image digest without rebuilding. Recreate the stack, verify health/state, then move `local` back to the restored source commit. If image/state compatibility is uncertain, stop and request owner approval.

## Verified traps

- `podman restart omniroute` keeps the old container image ID even when `omniroute:base` was retagged. Recreate the container.
- `omni-ts-egress` left alive causes a compose container-name conflict.
- Generic health does not prove provider readiness.
- Mutable `omniroute:base` caused UC code to disappear historically.
- `local` and `next` are Git roles, not physical blue/green runtime slots.
- Prime Agent's detached update-restart/session adoption mechanism does not apply to OmniRoute.

## References

- `/home/ndsadmin/_/omnirouter/docs/reconciliation/12-blue-green-deployment.md`
- `/home/ndsadmin/_/omnirouter/docs/reconciliation/13-prime-style-blue-green-architecture.md`
- `/home/ndsadmin/_/omnirouter/docs/reconciliation/MASTER-PLAN.md`
- `/home/ndsadmin/_/omnirouter/docs/reconciliation/evidence/LOCAL-NEXT-BASELINE.json`
