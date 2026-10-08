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
cargo build --release --manifest-path benchmarks/runtime-proxy/Cargo.toml
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
