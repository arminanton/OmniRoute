# OmniRoute container candidate deployment

OmniRoute does not need Prime Agent's two physical source clones. The running service executes immutable source baked into an OCI image; `/app` is not a source bind mount. Editing or checking out `~/_/omnirouter/src` does not change the running service until a new image is built and a new container instance is created.

## Branch contract

| Branch | Contract |
|---|---|
| `local` | Frozen marker for the exact source commit deployed in production. It tracks `origin/local` and is not used for development. |
| `next` | Active integration/development branch checked out at `~/_/omnirouter/src`. New feature branches start here and return here after review. It tracks `origin/next`. |

Current verified baseline is recorded in `../evidence-index/LOCAL-NEXT-BASELINE.json`.

## Candidate-image workflow

```text
feature/* -> review/tests -> next
                           |
                           v
                     candidate image
                           |
                 isolated private preflight
                           |
                     controlled recreate
                           |
                           v
                live image + branch local
```

1. Confirm `next` is clean and synchronized.
2. Build a candidate image from the exact `next` commit.
3. Record source SHA, tree, lockfile hash, dirty state, and image digest.
4. Start a private candidate on separate ports and isolated writable state. A production workspace must not be mounted read-only as the candidate's writable `/app/data`.
5. Keep provider egress blocked; verify packaged files, migrations, `/api/healthz`, readiness, and rollback compatibility.
6. Preserve the current live image by immutable digest before cutover.
7. Recreate the live container against the candidate image. This causes brief downtime; it is not Prime Agent-style zero-loss daemon adoption.
8. Verify live health and safe runtime metadata.
9. Only after successful cutover, fast-forward `local` to the deployed `next` commit and push `origin/local`.

## Rollback

Rollback selects the retained prior image digest, recreates the container with the persistent workspace, verifies health, and moves `local` to the restored deployed commit. Do not rebuild during rollback.

## Important limitation

The current `scripts/omniroute-hotswap-deploy.sh` was an initial prototype and must not be treated as production-ready. It lacks a stable front-door proxy, isolated candidate state, immutable prior-image rollback, and transactional branch/ledger handling. It should be replaced or hardened before use.

True zero-downtime container blue/green would require two simultaneous app containers, separate writable state/credential-writer ownership, a stable reverse proxy, connection draining, background-job fencing, and atomic proxy target switching. That is a separate design; physical source-clone slots alone do not provide it.
