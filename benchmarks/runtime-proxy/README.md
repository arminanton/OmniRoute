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

Exercise OmniRoute's actual TypeScript request-admission wrapper with the same deterministic
multi-turn bodies and a local streaming response:

```bash
node --import tsx/esm benchmarks/runtime-proxy/chat-admission-sessions.ts --clients 100 --rounds 5
```

This covers request-body admission, correlation IDs, concurrency/byte leases, and release when SSE
responses close. It does not run the Next production bundle, routing/database account selection,
call-log artifact persistence, provider adapters, or real model/tool execution.

Sweep `--clients 1,15,30,70,100` and repeat each point at least three times. The result reports
header and first-body-byte latency, completion latency, successful streams, throughput, peak
gateway RSS, and CPU time. Tune `--chunks`, `--chunk-delay-ms`, and `--chunk-bytes` to test other
stream shapes. Run with the same CPU affinity and process limits for every runtime.

The Node and Bun adapters are benchmark-only and bind to loopback. They are not authenticated
production proxies. The Rust candidate is a transport proof of concept, not a replacement for the
OmniRoute policy, provider, quota, or protocol layers.
