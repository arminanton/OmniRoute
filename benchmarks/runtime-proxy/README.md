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
