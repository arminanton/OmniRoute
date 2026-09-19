# Why OmniRoute does not copy Prime Agent's physical blue/green slots

Prime Agent needs `/mnt/devvm/custom/prime-deploy/{blue,green}` because its daemon executes host files directly. Rebuilding or changing the live folder can break a running daemon, and seamless recovery depends on stable socket/state adoption by a detached coordinator.

OmniRoute has a different runtime boundary:

- application source is copied into an immutable OCI image;
- the running container is pinned to an image ID;
- only `/app/data` and operational helpers are mounted from the host;
- source edits and Git branch switches on the host do not alter the running container;
- a candidate can be built from the same source checkout without touching live runtime files.

Therefore the preferred structure is:

```text
~/_/omnirouter/src        one canonical source checkout
  local                   deployed-source marker
  next                    active integration branch

OCI images
  previous digest         rollback target
  candidate digest        private preflight target
  deployed digest         current live target
```

## What is retained from Prime Agent

- `local` and `next` branch discipline
- exact immutable source and image identities
- preflight before cutover
- append-only deployment ledger
- a known rollback target
- bounded, scripted verification
- fail closed on uncertain state

## What is not copied

- two physical Git clones merely to protect source files
- claims of session-preserving daemon adoption
- pointer flips without a stable traffic front door
- treating a mutable image tag as deployment identity

## Future true blue/green option

If zero-downtime OmniRoute cutover becomes necessary, implement container-level blue/green:

1. Stable Caddy/nginx/HAProxy front door on public ports.
2. `omniroute-blue` and `omniroute-green` on separate private ports.
3. Separate candidate writable state or strict one-writer/background-job fencing.
4. Capability readiness and provider egress checks.
5. Connection draining and atomic proxy target switch.
6. Rollback by proxy switch to retained healthy container.

This is materially different from Prime Agent's host-daemon adoption system and should be designed independently.
