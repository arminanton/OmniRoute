# Runtime and streaming proxy microbenchmark

This isolated harness compares the transport overhead of the existing Node runtime, Bun's
`Bun.serve`, and a small Rust/Axum proxy. It uses one local mock SSE upstream and sends the same
request body and event stream through each gateway. It does not exercise OmniRoute credentials,
model/account routing, provider adapters, database policy checks, compression, or real-provider
quotas; results must not be presented as full OmniRoute capacity claims.

The Rust process enforces a bounded number of active requests, rejects known oversized
`Content-Length` values, streams request and response bodies, and holds its capacity permit until
the response finishes or the client disconnects. Node and Bun use equivalent in-flight limits and
stream their bodies through their native HTTP/fetch APIs.

Build the Rust candidate once:

```bash
cargo build --release --bins --manifest-path benchmarks/runtime-proxy/Cargo.toml
cargo test --manifest-path benchmarks/runtime-proxy/Cargo.toml --bin rust-chat-gateway
```

Run one runtime at a time. Container modes use the pinned official Node/Bun images and sample the
container process RSS; local modes use binaries already installed on the host. `bun-smol` enables
Bun's lower-memory, more-frequent-GC mode.

```bash
python3 benchmarks/runtime-proxy/run_bench.py --runtime node26-container --clients 100
python3 benchmarks/runtime-proxy/run_bench.py --runtime bun140-container --clients 100
python3 benchmarks/runtime-proxy/run_bench.py --runtime bun142-container --clients 100
python3 benchmarks/runtime-proxy/run_bench.py --runtime bun142-smol-container --clients 100
python3 benchmarks/runtime-proxy/run_bench.py --runtime bun-smol --bun-bin /tmp/bun-1.4.2/bun --clients 100
python3 benchmarks/runtime-proxy/run_bench.py --runtime rust --clients 100
```

Exercise admission and cancellation separately:

```bash
python3 benchmarks/runtime-proxy/run_bench.py --runtime rust --clients 100 --max-inflight 64 --allow-non2xx
python3 benchmarks/runtime-proxy/run_bench.py --runtime bun142-container --clients 100 --cancel-after-ms 100
```

The first command should show a bounded set of 503 responses at the configured capacity. The
cancellation case succeeds only if the mock upstream reports zero active streams after clients
disconnect. In the recorded 100-client run, the 64-slot admission cap accepted 64 streams, returned
503 for 36, and all three runtimes released every upstream stream after cancellation.

Replay independent agent sessions with multiple turns and tool-shaped history over a reused client
connection:

```bash
python3 benchmarks/runtime-proxy/run_bench.py --runtime rust --clients 100 --rounds 5 --context-bytes 65536
python3 benchmarks/runtime-proxy/run_bench.py --runtime bun142-container --clients 100 --rounds 5 --context-bytes 65536
python3 benchmarks/runtime-proxy/run_bench.py --runtime node26-container --clients 100 --rounds 5 --context-bytes 65536
```

Each session sends five sequential requests. Each later request includes earlier synthetic user
turns, tool calls, and tool results. The per-turn context is repeated 64 KiB text; it is a bounded
transport stress case, not a token-equivalent prompt or real provider/tool execution. Results
separate completed sessions, completed rounds, and request throughput.

The default endpoint is OpenAI Responses. To exercise OpenAI Chat Completions and tool-shaped
message history, select chat mode and a provider/model name:

```bash
python3 benchmarks/runtime-proxy/run_bench.py --runtime rust --api-path chat-completions --model openai/gpt-4o-mini --clients 100 --rounds 5 --context-bytes 262144 --chunks 100 --chunk-delay-ms 10
```

The chat payload contains previous assistant function calls and tool results followed by the next
user turn. This models the wire shape of an agent tool cycle; it does not execute tools. The same
loader can drive an externally started gateway such as Bifrost:

```bash
python3 benchmarks/runtime-proxy/load.py --port 8080 --api-path chat-completions --model openai/gpt-4o-mini --clients 100 --rounds 5 --context-bytes 262144
```

When using an external gateway, configure its provider to the same local mock upstream, use the
same request/response protocol and stream shape, and collect process or container memory separately.
Pass `--sample-pid <host-pid>` to include the external gateway process's peak RSS and CPU time in
the loader output. This samples one host process only; it does not replace a container cgroup memory
measurement. `run_bench.py` records 25 ms sampled peak RSS and `/proc/<pid>/status` `VmHWM` for its
local gateway process.
The Rust adapter is a transparent transport prototype; it does not yet implement Bifrost or OmniRoute
provider routing, authentication, retries, quotas, or request/response translation.

### Rust policy-aware chat prototype

`rust-chat-gateway` is a second, isolated prototype for measuring a little more of the real chat
hot path. It accepts a static table of client keys with unique non-secret IDs, independently enforces
each key's fixed one-minute request budget and configured revocation flag, plus a global in-flight
cap. It validates OpenAI Chat Completions JSON, holds a shared body-memory budget in 64 KiB permits,
optionally rewrites model aliases, replaces the caller credential with a configured upstream bearer
key, and streams the upstream response with cancellation-aware lease release. The budget reserves
four times encoded body bytes plus 128 bytes per observed JSON structural token, up to 100,000
tokens, before buffering/deserializing; this conservative charge accounts for the raw buffer, parsed
JSON tree, and normalized outbound body. Client key count/ID/secret/limit size, model alias
count/name size, request body, total body budget, and in-flight configuration all have hard limits.
It preserves tool-call/tool-result JSON but does not execute tools.

Configure multiple synthetic clients with `CLIENT_KEYS_JSON`; IDs are non-secret state keys, while
`apiKey` values remain credentials and are never logged or returned. `revoked` defaults to false and
is loaded at process start, so this prototype does not provide live key updates or database-backed
revocation. The legacy `CLIENT_API_KEY` mode remains supported; `CLIENT_KEY_ID` names its state key
(default `default`) and `MAX_REQUESTS_PER_MINUTE` sets that client's limit.

```json
[
  {"id":"agent-a","apiKey":"synthetic-agent-a","maxRequestsPerMinute":120},
  {"id":"agent-b","apiKey":"synthetic-agent-b","maxRequestsPerMinute":240},
  {"id":"retired-agent","apiKey":"synthetic-retired","maxRequestsPerMinute":10,"revoked":true}
]
```

This trial does not load or dynamically revoke employee keys from OmniRoute's database, and it does
not implement account scheduling, distributed quotas, provider retries, compression, call-log
capture, or response protocol translation. The benchmark runner supplies synthetic credentials; do
not use real secrets for this harness. It binds to loopback and is not a deployable replacement.

### Synthetic account scheduler contention

Run the isolated scheduler exercise with:

```bash
cargo run --offline --manifest-path benchmarks/runtime-proxy/Cargo.toml --bin omniroute-account-scheduler-bench -- 70
cargo run --offline --manifest-path benchmarks/runtime-proxy/Cargo.toml --bin omniroute-account-scheduler-bench -- 100
```

For the selected 70- or 100-session group, it runs four sequential turns per session against six
eligible synthetic accounts (eight concurrent requests per account), plus disabled, cooling-down,
and quota-exhausted decoys. Each group compares least-loaded available-capacity scheduling with
priority-ordered fill-first selection, with session affinity disabled so the routing strategy is
visible. It reports completed sessions/turns, throughput, acquire p50/p95, capacity-wait requests,
timeouts, per-account distribution/skew, and peak per-account load. A separate four-task cancel
probe aborts requests while they hold leases and checks that every slot is released and reusable.

The TypeScript source compares connection eligibility from cached DB snapshots, `isActive`/API-key
allowlists, exclusions, terminal/cooldown/model locks, and quota state before selecting an account.
Session affinity reuses an eligible pin or chooses an LRU candidate for a new session. The Rust
`MultiGateAdmission` is a separate model of global/provider/account gates; it is not wired into
`AccountScheduler` or used by production TypeScript.
The synthetic model applies only enabled/cooldown/quota eligibility, one of the two listed account
selection modes, optional session pins, and a per-account in-flight cap. It reassigns a full affinity
pin to an eligible account with capacity, and its waiter wake-up is not FIFO. It does not reproduce
database-backed account selection, model/API-key filters, provider/global caps, distributed leases,
provider quotas, or adaptive/shared admission.

One exact routing-choice difference is covered by `account_scheduler::tests`: TypeScript selects
`providerStrategies[provider].fallbackStrategy || fallbackStrategy || "fill-first"`; after its
filters and affinity/lease handling, that default branch chooses `orderedConnections[0]`, whose
order is priority-based. The Rust scheduler's normal constructor instead chooses the least-loaded
in-flight/capacity ratio. A benchmark-only `PriorityOrderedFillFirst` mode models TypeScript's
first-candidate choice over this harness's capacity-available candidates when given the already-
filtered, priority-ordered vector; the test shows the two choices diverge while both accounts have
headroom. It is not a port of TypeScript's `maxConcurrent` or exclusive-lease behavior. It also does
not port TypeScript's candidate filtering, quota score, round-robin/weighted/P2C variants, or
persistence semantics. In this local probe `getProviderConnections()` returns one provider's rows ordered by
`priority ASC, updated_at DESC`; the request path filters that list and applies an OAuth-session
tie preference before selecting `orderedConnections[0]`. Alias-provider concatenation, affinity,
forced-connection, and exclusive-lease cases are outside this ordering assumption. Run the focused
selector tests with the cached build tree:

```bash
. "$HOME/.cargo/env"
CARGO_TARGET_DIR=/tmp/omni-runtime-proxy-target cargo test --offline \
  --manifest-path benchmarks/runtime-proxy/Cargo.toml --bin rust-chat-gateway \
  account_scheduler::tests
```

Recorded one-run measurements on the 4-CPU ARM64 host on 2026-10-09 UTC. Each run used four turns
per session, an 8 ms synthetic service delay, one CPU, six eligible accounts capped at eight
in-flight leases each, and no session affinity. `capacity_wait_requests` counts distinct acquire
calls that encountered a full eligible pool at least once. The separate cancellation probe is not
included in workload throughput.

| Sessions | Strategy | Throughput | Elapsed | Capacity waits | Timeouts | Per-account selections | Max:min skew | CV | Peak/account |
|---:|---|---:|---:|---:|---:|---|---:|---:|---:|
| 70 | Least-loaded | 3,596 req/s | 77.85 ms | 22 | 0 | 47 / 47 / 48 / 48 / 45 / 45 | 1.07 | 0.027 | 8 |
| 70 | Priority fill-first | 3,510 req/s | 79.78 ms | 22 | 0 | 64 / 64 / 52 / 32 / 32 / 36 | 2.00 | 0.300 | 8 |
| 100 | Least-loaded | 3,492 req/s | 114.55 ms | 52 | 0 | 67 / 68 / 67 / 68 / 66 / 64 | 1.06 | 0.021 | 8 |
| 100 | Priority fill-first | 3,651 req/s | 109.56 ms | 52 | 0 | 76 / 64 / 64 / 68 / 64 / 64 | 1.19 | 0.066 | 8 |

All four workloads completed every requested turn. Each separate cancel probe acquired four leases,
aborted all four holders, observed all four slots released, and successfully reacquired capacity.
These are single synthetic samples: throughput changed direction between the 70- and 100-session
runs, so they do not establish a faster strategy. They do show the fill-first distribution can be
more skewed under this contention shape. The probe does not model real request bodies, provider
latency, database/Redis work, retries, adaptive gates, or a production 70/100-agent OmniRoute load.

The captured runs used the cached Cargo target, `cargo run --offline`, CPU 0 affinity, and a
systemd user scope with `MemoryMax=1G` and `CPUQuota=100%`; no image build or egress was involved.
The first run compiled only the benchmark crate in 2.41 seconds; the second was incremental
(0.15 seconds). Sampled host headroom stayed near 20 GiB available RAM and 11 GiB free disk;
memory PSI remained zero and I/O PSI avg10 stayed below 0.2%. The cached target was about 1.10 GB
at that point (later composition-probe compilation increased it to about 1.20 GB). To reproduce
each single-size run, launch one tmux session per size:

```bash
tmux new-session -d -s omni-account-strategy-70 \
  'systemd-run --user --scope -p MemoryMax=1G -p CPUQuota=100% -- /usr/bin/env CARGO_TARGET_DIR=/tmp/omni-runtime-proxy-target /usr/bin/taskset -c 0 /home/ubuntu/.cargo/bin/cargo run --offline --manifest-path /home/ubuntu/_/omni/blue/benchmarks/runtime-proxy/Cargo.toml --bin omniroute-account-scheduler-bench -- 70'
tmux new-session -d -s omni-account-strategy-100 \
  'systemd-run --user --scope -p MemoryMax=1G -p CPUQuota=100% -- /usr/bin/env CARGO_TARGET_DIR=/tmp/omni-runtime-proxy-target /usr/bin/taskset -c 0 /home/ubuntu/.cargo/bin/cargo run --offline --manifest-path /home/ubuntu/_/omni/blue/benchmarks/runtime-proxy/Cargo.toml --bin omniroute-account-scheduler-bench -- 100'
```

### Composed account and multi-gate lease probe

`src/bin/composed-capacity-bench.rs` checks the composition boundary missing from the separate
`account_scheduler.rs` and `multi_gate_admission.rs` prototypes. A synthetic request first reserves
an account-selection slot, then atomically acquires a global, provider, and selected-account gate;
one composite lease owns both reservations. Three cap profiles make each distinct gate binding in
turn (global 20, provider 16, or per-account 4) for both 70- and 100-session groups, four turns
each. It reports completed turns, queue waits/timeouts, per-gate peaks, account selections, and
then exercises cancellation while queued and while holding a composite lease. It checks that
waiter cancellation removes the request from every gate, releases the preliminary account slot,
and that aborting an admitted request releases every gate and leaves capacity reusable.

This is a future-design experiment, not TypeScript parity. `withChatAdmission` owns a process-local,
cost-weighted global admission lease through the response lifecycle (the source default is
`mode: "shadow"`; enforcement is configurable); provider account selection happens later.
`applyExclusiveConnectionLeasePolicy` separately uses a database-backed exclusive connection
owner/lease, not an atomic numeric global/provider/account gate set. The Rust wrapper also reserves
an account slot before waiting on global/provider gates, so an account slot can be held while
another gate is full. The test checks cleanup and hard caps, not that this sequential ordering is
fair or optimal.

The single synthetic test run completed all 70/100-session turns with zero timeouts or queue-full
rejections. Each profile deliberately made a different gate binding so its cap was observed:

| Sessions | Binding profile | Global peak | Provider peak | Account-gate peak | Account-slot peak | Gate-queue peak | Throughput |
|---:|---|---:|---:|---:|---:|---:|---:|
| 70 | Global 20 | 20/20 | 20/40 | 5/8 | 8/8 | 28 | 2,511 req/s |
| 70 | Provider 16 | 16/40 | 16/16 | 4/8 | 8/8 | 32 | 1,896 req/s |
| 70 | Account 4 | 24/40 | 24/40 | 4/4 | 4/4 | 0 | 3,097 req/s |
| 100 | Global 20 | 20/20 | 20/40 | 5/8 | 8/8 | 28 | 2,152 req/s |
| 100 | Provider 16 | 16/40 | 16/16 | 5/8 | 8/8 | 32 | 1,785 req/s |
| 100 | Account 4 | 24/40 | 24/40 | 4/4 | 4/4 | 0 | 2,745 req/s |

The provider-bound cancel probe held 16 composite leases, queued four more, cancelled two, observed
account reservations fall from 20 to 18 and the provider queue from four to two, then released the
original leases and let the remaining two complete. A separate in-flight task abort also released
its global/provider/account gates and account slot; a new composite request reacquired capacity.
These short samples verify caps and cleanup, not production throughput or fairness.

Run the 70/100 composition test in a tmux session under the same cached, bounded toolchain:

```bash
tmux new-session -d -s omni-rust-composed-capacity \
  'sleep 1; systemd-run --user --scope -p MemoryMax=1G -p CPUQuota=100% -- /bin/bash -lc \
    "cd /home/ubuntu/_/omni/blue/benchmarks/runtime-proxy && /home/ubuntu/.cargo/bin/cargo fmt --check --manifest-path Cargo.toml && CARGO_TARGET_DIR=/tmp/omni-runtime-proxy-target /usr/bin/taskset -c 0 /home/ubuntu/.cargo/bin/cargo test --offline --manifest-path Cargo.toml --bin omniroute-composed-capacity-bench -- --nocapture"'
tmux set-option -p -t omni-rust-composed-capacity:0 remain-on-exit on
```

Recorded composition-test result on 2026-10-09 UTC: `cargo fmt --check` passed; Cargo reported 10
tests passed (the composition test plus the included account-scheduler and multi-gate tests), with
the 70/100 workload running inside that test. The new test-profile binary compiled in 3.84 seconds
and tests finished in 0.94 seconds. It used the cached target, offline Cargo, CPU 0, and the 1 GiB
memory / one-CPU scope above. Host headroom stayed near 20 GiB available RAM and 11 GiB free disk;
memory PSI was zero and sampled I/O PSI avg10 stayed below 1%. No image or production path was
touched.

| Sessions | Binding profile | Global peak | Provider peak | Account-gate peak | Account-slot peak | Gate-queue peak | Throughput |
|---:|---|---:|---:|---:|---:|---:|---:|
| 70 | Global 20 | 20/20 | 20/40 | 5/8 | 8/8 | 28 | 2,511 req/s |
| 70 | Provider 16 | 16/40 | 16/16 | 4/8 | 8/8 | 32 | 1,896 req/s |
| 70 | Account 4 | 24/40 | 24/40 | 4/4 | 4/4 | 0 | 3,097 req/s |
| 100 | Global 20 | 20/20 | 20/40 | 5/8 | 8/8 | 28 | 2,152 req/s |
| 100 | Provider 16 | 16/40 | 16/16 | 5/8 | 8/8 | 32 | 1,785 req/s |
| 100 | Account 4 | 24/40 | 24/40 | 4/4 | 4/4 | 0 | 2,745 req/s |

All workloads completed all requested turns with zero timeout/queue-full failures, and every final
gate and account-slot snapshot was idle. In the provider-bound cancel probe, four queued requests
were created while 16 leases occupied the provider gate; cancelling two removed them from the
queues and released their account slots (20 reservations became 18). After releasing the held
leases, the two remaining waiters completed; aborting a separate admitted task then returned every
gate and account slot to zero and capacity was reacquired. These short synthetic measurements
verify cap enforcement and cleanup, not production throughput or fairness. The measured order is
account-slot reservation followed by gate admission, so head-of-line effects while waiting remain
part of the design tradeoff.

### Credential-free TypeScript policy-context adapter

`src/policy_context.rs` defines a benchmark-only JSON contract (`schema_version: 1`) for a
short-lived TypeScript routing snapshot. It carries only an opaque candidate handle and explicit
eligibility facts; serde rejects missing or unknown fields and unsupported versions. It never
accepts credentials, raw API-key/session identifiers, provider-specific data, or prompt content.
Rust fails closed on a denied API-key decision, disabled/unusable connection, candidate model
restriction, active cooldown, unknown/blocked/exhausted quota state, expired context, or full
account cap. Context TTL is capped at 30 seconds; JSON input is limited to 1 MiB and 4,096
candidates. An affinity hint contains only a candidate handle, cannot outlive its parent context,
and is retained only while that candidate remains eligible and the hint is unexpired.

TypeScript remains authoritative for key authentication/revocation and key-level endpoint,
schedule, model, and quota rules; the connection allowlist; active/terminal account state; provider
quota interpretation and thresholds; cooldown/model-lock classification; model inventory and
connection-specific restrictions; cache refresh/invalidation and staleness policy; routing
strategy, combo/forced-connection semantics, and session-affinity creation/expiry. The Rust adapter
only validates the explicit projection and candidate capacity. This is a contract/parity probe,
not a production authorization or routing implementation. The JSON has no signature or MAC;
only consume it over a trusted in-process/IPC boundary after TypeScript policy evaluation, never
as an unauthenticated network request. Focused tests run with:

```bash
. "$HOME/.cargo/env" # use the Rustup toolchain rather than an older distro cargo
cargo test --offline --manifest-path benchmarks/runtime-proxy/Cargo.toml --lib policy_context::tests
```

### API-key validation cache parity slice

`src/api_key_validation_cache.rs` models only the process-local positive validation cache from
`src/lib/db/apiKeys.ts`: successful validations are reused for a strict 60-second window, denied
keys are not cached, and a successful key mutation clears the local validation/metadata caches.
The TypeScript validator checks banned/active/revoked/expiry state; a revoke writes
`revoked_at` and `is_active = 0` before clearing local caches, then attempts to delete the optional
Redis auth entry. Redis stores auth snapshots for up to one hour, and Redis read/write/delete
failures are swallowed. This means this Rust model does not establish cross-process revocation
freshness: a process-local positive can remain in another process for its remaining minute, and a
stale Redis positive may be reused after a failed delete until its TTL expires. Rust uses a local
generation number to express cache invalidation, but TypeScript does not currently export such a
generation. This is a bounded cache-behavior probe, not a Rust key validator, Redis parity
implementation, or authorization guarantee.

In `PolicyContextV1`, `schema_version` guards the wire shape only; it is not a policy/config
generation. The 30-second context expiry bounds reuse but cannot actively invalidate a snapshot
when a key or connection changes. No cross-process invalidation epoch is currently shared with
the Rust prototype.

The surrounding policy differences remain material. TypeScript connection reads are process-local
5-second TTL caches invalidated by connection writes; account selection then filters active
connections by exclusions, connection model rules/inventory, terminal status, future
`rateLimitedUntil`, provider-specific scopes, model/family lockouts, quota policy/exhaustion,
affinity, and configured routing strategy. Combo/suppression paths can intentionally retain
otherwise suppressed accounts, so those predicates are not unconditional.
The Rust context collapses those into TypeScript-provided booleans, one cooldown timestamp, one
quota enum, and an in-flight cap. TypeScript provider-quota reads mark an expired window unknown
only when `now > windowReset`; missing/error reads can return no record and some schedulers treat
unconfigured quota tracking as available. The Rust projection rejects `Unknown`. These are not
semantically equivalent and remain TypeScript-owned until separately specified and tested.

Focused tests reuse the cached build tree:

```bash
. "$HOME/.cargo/env"
CARGO_TARGET_DIR=/tmp/omni-runtime-proxy-target cargo test --offline \
  --manifest-path benchmarks/runtime-proxy/Cargo.toml --lib api_key_validation_cache::tests
```

### Synthetic multi-level admission contention

Run the independent atomic global/provider/account gate model with:

```bash
cargo run --manifest-path benchmarks/runtime-proxy/Cargo.toml --bin omniroute-multigate-admission-bench
```

It runs 70- and 100-session groups, four turns per session, with global cap 20, Codex-provider cap
16, and five synthetic account gates capped at four each. It prints requested/completed/rejected
counts, observed gate peaks, queue depth, and elapsed time; timed-out acquisition fails the run. The
prototype normalizes duplicate requirements to the strictest cap, sorts gate keys, admits all gates
atomically, and drops every reservation when a waiter or lease is cancelled. It is process-local
with a 10-second wait limit and 256 queued waiters per gate. It does not implement shared Redis
admission or the production adaptive-controller feedback loop.

### SQLite cross-process coordination protocol probe

Run the Rust/TypeScript interoperability test with:

```bash
cargo test --manifest-path benchmarks/runtime-proxy/Cargo.toml --test coordination_sqlite_interop -- --nocapture
```

The test creates a disposable database under the local system temp directory and removes it after
the test. It launches separate Rust and TypeScript processes to check a shared cap-1 resource,
independent-resource progress, cancellation cleanup, release, renewal and expiry, fencing, and owner
checks. `coordination_sqlite.rs` matches the existing `omni-coordination/v1` SQLite/WAL schema and
atomic lease operations. This first Rust slice accepts only static gates; it rejects adaptive
requirements rather than silently applying a different cap. Use a dedicated local POSIX volume for
coordination, never NFS or the application data DB.

### SQLite quota bucket storage probe

Run the raw bucket-storage interoperability test with:

```bash
cargo test --manifest-path benchmarks/runtime-proxy/Cargo.toml --test quota_bucket_sqlite_interop -- --nocapture
```

The test asks TypeScript to migrate a temporary `DATA_DIR`, then alternates actual
`quotaConsumption.ts` writes/reads with Rust writes/reads on that same temporary SQLite file. The
Rust adapter refuses to create the table and checks the migration-defined columns and composite key
before using the documented UPSERT. It covers only `(api_key_id, dimension_key, bucket_index)` row
storage and current/previous bucket reads. It does not select SQLite versus Redis, read key/account
policy, resolve pools/plans, calculate fair-share, or enforce quota decisions.

```bash
python3 benchmarks/runtime-proxy/run_bench.py \
  --runtime rust-chat-gateway --api-path chat-completions --model cx/gpt-5.6 \
  --clients 100 --rounds 5 --context-bytes 262144 --chunks 100 --chunk-delay-ms 10
```

The runner injects fake client/upstream keys, maps the requested model to a fake upstream label, and
adds the fake client bearer to each generated request. To target a separately configured gateway,
`load.py --auth-token <synthetic-key>` adds a bearer header; it never prints the token. The response
path remains streaming while the bounded chat request is read and validated before forwarding.

### Bifrost comparison

The checked-in `bifrost-config.example.json` pins a local OpenAI-compatible mock provider, disables
request logging, and sets the client/provider worker pools and queue to 128. The official Bifrost
client documentation describes larger defaults (300 global workers and 1,000 provider workers) and
warns that larger pools increase baseline memory ([client configuration](https://github.com/maximhq/bifrost/blob/dev/docs/deployment-guides/config-json/client.mdx),
[provider concurrency](https://github.com/maximhq/bifrost/blob/dev/docs/quickstart/gateway/provider-configuration.mdx)).

For the recorded probe, Bifrost ran from the pinned ARM64 image `maximhq/bifrost:v1.3.9-arm64`
(digest `sha256:a5931720a1fb22bcbe73bc2eb59c50e6a9cbdf24754666305f3fd091b541933b`) with a two-GiB
memory limit and loopback-only listener. A fresh instance has no dashboard password by default, so
keep it bound to loopback ([gateway setup](https://github.com/maximhq/bifrost/blob/dev/docs/quickstart/gateway/setting-up.mdx)).
The Rust mock and loader commands above can then be used unchanged against Bifrost's port; add
`--sample-pid $(podman inspect --format '{{.State.Pid}}' <container-name>)` to sample the gateway
process's RSS and CPU time.

### Reproducible Bifrost run

On a rootless-Podman ARM64 host, this keeps Bifrost and the mock on loopback and uses only a dummy provider key:

```bash
set -euo pipefail
cargo build --release --manifest-path benchmarks/runtime-proxy/Cargo.toml
API_PATH=/v1/chat/completions PORT=3900 CHUNKS=100 CHUNK_DELAY_MS=10 CHUNK_BYTES=64 taskset -c 2-3 benchmarks/runtime-proxy/target/release/omniroute-runtime-mock-upstream-bench &
MOCK_PID=$!
BIFROST_DATA=$(mktemp -d /tmp/omni-bifrost-bench-data.XXXXXX)
cleanup() { podman stop --time=3 omni-bifrost-bench >/dev/null 2>&1 || true; podman rm -f omni-bifrost-bench >/dev/null 2>&1 || true; kill "$MOCK_PID" 2>/dev/null || true; rm -rf "$BIFROST_DATA"; }
trap cleanup EXIT
cp benchmarks/runtime-proxy/bifrost-config.example.json "$BIFROST_DATA/config.json"
podman run -d --name omni-bifrost-bench --network=host --memory=2g --memory-swap=2g -v "$BIFROST_DATA":/app/data:Z,U -e APP_HOST=127.0.0.1 -e APP_PORT=8080 -e BIFROST_ENCRYPTION_KEY=benchmark-only-key -e BIFROST_OPENAI_KEY=benchmark-dummy docker.io/maximhq/bifrost:v1.3.9-arm64
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null; then break; fi
  sleep 1
done
curl -fsS http://127.0.0.1:8080/health
BIFROST_HOST_PID=$(podman inspect --format '{{.State.Pid}}' omni-bifrost-bench)
taskset -a -pc 0-1 "$BIFROST_HOST_PID"
taskset -c 4-7 python3 benchmarks/runtime-proxy/load.py --port 8080 --clients 100 --rounds 5 --round-gap-ms 5 --context-bytes 262144 --api-path chat-completions --model openai/gpt-4o-mini --sample-pid "$BIFROST_HOST_PID"
```

The fresh Bifrost UI/API has no password by default. Do not expose this test listener beyond loopback.

For the comparable four-core, 1,000-simultaneous-session run, pin each component to a disjoint CPU
set and use the Rust mock upstream for every adapter. The example matches the repeated run from
2026-10-08: a 16 KiB synthetic context, 20 chunks spaced 25 ms apart, and a 1,024-request admission
cap. The devvm has eight logical CPUs, so these CPU sets leave no core shared between gateway,
upstream, and load generator:

```bash
python3 benchmarks/runtime-proxy/run_bench.py --runtime rust --upstream-runtime rust --clients 1000 --rounds 1 --context-bytes 16384 --chunks 20 --chunk-delay-ms 25 --max-inflight 1024 --gateway-cpus 0-3 --upstream-cpus 4-5 --load-cpus 6-7
python3 benchmarks/runtime-proxy/run_bench.py --runtime node --upstream-runtime rust --clients 1000 --rounds 1 --context-bytes 16384 --chunks 20 --chunk-delay-ms 25 --max-inflight 1024 --gateway-cpus 0-3 --upstream-cpus 4-5 --load-cpus 6-7
python3 benchmarks/runtime-proxy/run_bench.py --runtime bun140-container --upstream-runtime rust --clients 1000 --rounds 1 --context-bytes 16384 --chunks 20 --chunk-delay-ms 25 --max-inflight 1024 --gateway-cpus 0-3 --upstream-cpus 4-5 --load-cpus 6-7
```

On 2026-10-08, each runtime completed 1,000/1,000 requests in three sequential trials on the
aarch64 devvm. Node 25.8.1 and Rust 1.94.0 ran on the host; Bun 1.4.0 ran in the cached official
container with a 512 MiB cap. Rootless Podman lacks a delegated cpuset controller on that host, so
the harness applies `taskset -a -p` to the running container's host PID after startup. The recorded
p95/RSS/CPU table and limitations are in `docs/architecture/RUNTIME_AND_DATA_PLANE_BENCHMARKS.md`.
The load uses one synthetic request per session; it does not execute tools or exercise real
provider/account policies. Repeat the three commands serially at least three times each when
comparing a different host or runtime version.

To probe beyond the requested 70–100 sessions, build the Rust proxy and mock once and run the
Rust-only scale points. These single-trial results use an unpinned eight-CPU devvm and should not be
compared directly with the four-core table:

```bash
cargo build --release --manifest-path benchmarks/runtime-proxy/Cargo.toml
python3 benchmarks/runtime-proxy/run_bench.py --runtime rust --upstream-runtime rust --clients 5000 --rounds 1 --context-bytes 16384 --chunks 20 --chunk-delay-ms 25 --max-inflight 10240
python3 benchmarks/runtime-proxy/run_bench.py --runtime rust --upstream-runtime rust --clients 10000 --rounds 1 --context-bytes 16384 --chunks 20 --chunk-delay-ms 25 --max-inflight 10240
```

For loads above 1,000, pass `--upstream-runtime rust`. The Node mock is convenient for small tests,
but an earlier 10,000-client run against it returned 1,375 gateway 502s; that was not a valid Rust
gateway capacity measurement. The Rust benchmark adapter includes the `reqwest` error chain in its
local 502 body. The loader retains at most 512 bytes of non-2xx response body and records whether a
failure occurred during connect, request write, response headers, or response body, without
retaining the synthetic prompt or a full upstream response.

For a 70–100-session, multi-turn run where the gateway, mock provider, and load client all share a
four-CPU allocation, pin each process to the same set. This is a more realistic CPU-contention check
than giving the gateway four exclusive cores; the mock is still local and no real model/provider
capacity is involved:

```bash
run_target() {
  python3 benchmarks/runtime-proxy/run_bench.py \
    --runtime "$1" --upstream-runtime rust --clients "$2" --rounds 5 \
    --context-bytes 262144 --chunks 100 --chunk-delay-ms 10 --max-inflight 128 \
    --upstream-port "$3" --gateway-port "$4" \
    --gateway-cpus 0-3 --upstream-cpus 0-3 --load-cpus 0-3 --allow-non2xx
}
run_target node 70 64120 64121
run_target bun140-container 70 64122 64123
run_target rust 70 64124 64125
run_target node 100 64126 64127
run_target bun140-container 100 64128 64129
run_target rust 100 64130 64131
```

The 70-session runs completed 350/350 once for each runtime. Three 100-session trials per runtime
completed 500/500 requests each; results and limitations are in
`docs/architecture/RUNTIME_AND_DATA_PLANE_BENCHMARKS.md`. Change the port pairs on each rerun so
previous local socket state cannot interfere. For repeated 100-session runs, invoke the three
100-client rows two more times with fresh port pairs; inspect the `failed` count in each JSON result
because `--allow-non2xx` lets the sweep continue after a failed trial. The four-CPU co-located
5,000/10,000 sweep had
intermittent 502s. A 10,000-session diagnostic retry
captured `Connection reset by peer (os error 104)` from the local mock connection; repeated runs
varied substantially, so treat that as a mock-path saturation signal rather than a gateway or real
provider limit. Keep it separate from the successful isolated-gateway comparison.

Sweep `--clients 1,15,30,70,100` and repeat each point at least three times. The result reports
header and first-body-byte latency, completion latency, successful streams, throughput, peak
gateway RSS, and CPU time. Tune `--chunks`, `--chunk-delay-ms`, and `--chunk-bytes` to test other
stream shapes. Run with the same CPU affinity and process limits for every runtime.

The Node and Bun adapters are benchmark-only and bind to loopback. They are not authenticated
production proxies. The Rust candidate is a transport proof of concept, not a replacement for the
OmniRoute policy, provider, quota, or protocol layers.

For a higher-fidelity front-door test, `omni-admission-node` runs the production TypeScript
`withChatAdmission` / `admitChatRequest` path behind a small local HTTP adapter. The loader runs in
a separate Python process, so its request bodies do not count toward gateway RSS:

```bash
python3 benchmarks/runtime-proxy/run_bench.py --runtime omni-admission-node --clients 100 --rounds 5 --context-bytes 262144
```

This measures body buffering/parsing, actual V8-derived admission budgeting, correlation IDs, and
stream-lifetime lease release. It still uses a deterministic local SSE handler; provider routing,
database account selection, persistent artifact capture, and model/tool execution remain outside
this harness. The reported health snapshot includes the effective byte budget and peak admission
occupancy. Run the Node suite on an isolated builder with the same heap and cgroup limits as the
target deployment.

Use a longer synthetic stream to verify that byte-budget waiters stay queued until capacity is
released instead of receiving an early 503:

```bash
python3 benchmarks/runtime-proxy/run_bench.py --runtime omni-admission-node --clients 70 --rounds 5 --context-bytes 262144 --chunks 100 --chunk-delay-ms 10
python3 benchmarks/runtime-proxy/run_bench.py --runtime omni-admission-node --clients 100 --rounds 5 --context-bytes 262144 --chunks 100 --chunk-delay-ms 10
# Three-second streamed responses to test lease turnover under slower upstreams.
python3 benchmarks/runtime-proxy/run_bench.py --runtime omni-admission-node --clients 100 --rounds 5 --context-bytes 262144 --chunks 300 --chunk-delay-ms 10
```

On 2026-10-08 the 70-session run completed 350/350 requests and three 100-session runs completed
1,500/1,500. Requests were up to 1,311,987 bytes; peak in-flight byte charges stayed below 70 MiB
and queued reservations below 64 MiB. This is a local admission-plus-mock-stream check, not a claim
about 70–100 real provider sessions.
One slower 100-session trial at 300 chunks per response also completed 500/500 requests in 22.4s;
first-body p95 was 3.07s and completion p95 was 6.22s while the admission queues drained.
