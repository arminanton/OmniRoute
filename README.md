# local-overrides — OUR fork's deployment infra (NEVER merged into PRs)

This is an **orphan branch** (no shared history with the feature branches). It
exists purely to **version-control + back up** the environment-specific infra
that runs the OmniRoute stack on *our* box, and that must **never** appear in an
upstream PR because upstream doesn't share our residential-egress / bot-safety
posture.

## Why an orphan branch

The runtime infra lives in `/mnt/devvm/custom/omnirouter/bin/` — a **sibling**
of the fork worktree `src/`, i.e. **outside** the repo. That keeps the feature
branches (`feat/maxai-provider`, etc.) pristine so their PR diffs contain ONLY
the product code under `src/`. But "outside the repo" also means "not backed up
by git" — a box loss would lose it. This branch captures a snapshot so it's
recoverable, without ever being a merge candidate for `main`/release.

## Contents (mirrors the on-box layout)

| Path here | Deploys to on-box |
|---|---|
| `bin/*` | `/mnt/devvm/custom/omnirouter/bin/` |
| `systemd-user/*.service` | `~/.config/systemd/user/` |
| `docker-compose.override.yml` | `/mnt/devvm/custom/omnirouter/src/` (gitignored there) |

### What this infra does
- **Residential egress**: the whole app + codex egress the NUC residential exit
  node (TELUS `66.183.196.137`) instead of the EC2 AWS IP, via in-container
  tailscale TUNs. MaxAI bot-bans datacenter IPs, so this is mandatory for us.
- **Exit-node failover**: `ts-egress-failover.sh` (codex sidecar) +
  `app-egress-failover.sh` (app's own TUN) steer NUC→laptop and fail closed.
- **Kill-switch**: baked `iptables` + `app-egress-killswitch` chain in the app
  entrypoint closes the tailscaled-process-death leak window.
- **ESM fix + codex CLI + iptables** baked via `omniroute-fix.Containerfile`.

## ⚠️ Rules
- **Do NOT merge this into any `feat/*`, `main`, or release branch.**
- It is intentionally disjoint history; `git merge` would drag infra into a PR.
- Update it by re-snapshotting the on-box files (see `snapshot.sh`).
