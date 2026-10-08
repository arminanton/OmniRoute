# Runtime and inference data-plane investigation

**Status:** Active evaluation on `feat/inference-runtime-reliability`. These are isolated benchmark
results, not production capacity claims. No deployment is part of this work.

## OpenAPI surface and plane boundary

The canonical `docs/openapi.yaml` currently contains 705 route templates, 1,029 operations, and 118
component schemas. The API route inventory checker now verifies that source files and the spec agree
on every path, exported method, and path parameter; it reports 705/705 routes and the documented
public copy at `public/openapi.yaml` is byte-identical to the canonical spec.

The contract has two broad surfaces. The `/api/v1/` prefix contains 98 route templates and 135
operations, including inference-compatible chat, Responses, Messages, embeddings, image, audio,
rerank, moderation, model discovery, relay, and provider-specific endpoints. The `/api/v1beta/`
surface has two route templates and two operations. The remaining 605 routes and 892 operations
cover dashboard/control-plane work such as provider credentials, model and routing configuration,
keys, quotas, usage, conversations, MCP/A2A, CLI tools, browser sessions, backups, logs, and local
services.

This supports a staged boundary: retain Next.js for the dashboard and administrative workflows;
evaluate a separate inference service for protocol handling, provider execution, streaming,
cancellation, admission, and usage events. A Rust service is the first candidate because that is the
preferred implementation language for this project. Bifrost/Go remains an optional comparison, not
an assumed performance winner. The main `/api/v1/chat/completions` route does not select Bifrost;
the Go sidecar is exposed through the relay endpoints.

All 1,029 operations now have unique, deterministic method/path-derived `operationId` values. The
contract is still stronger on route coverage than schema completeness: 179 operations have
success response content schemas and 139 declare operation-level security. Another 836 operations
still lack an explicit success-body schema after excluding intentional `204` responses; 14 of those
have no declared `2xx` status and need route-by-route status review. The OpenAI chat, Anthropic
Messages, OpenAI Responses, token-count, embedding, image-generation, audio, moderation, rerank,
OCR, Jina classify/segment, legacy completions, and WebSocket-handshake paths now describe their
principal request/response shapes and streaming media. The remaining contract pass must compare
authentication and request/response schemas with each handler before calling the entire OpenAPI
document semantically complete. The core inference paths also list the accepted bearer/API-key
headers, dashboard session cookie, and anonymous mode when `REQUIRE_API_KEY` is disabled. For other
routes with confirmed configuration-dependent access, the spec includes anonymous alternatives
where the handler allows them, including model discovery, combo/routing metadata, and API Explorer
endpoints. This pass also documents the local pressure/admission 503 body and its `Retry-After` and
`x-request-id` headers on the seven chat routes that share the admission path; `ApiErrorResponse`
now includes the `code` and `reason` fields emitted by the handler. The contract test checks those
routes and headers against the implementation. It adds typed management responses for the model
picker/alias/catalog APIs, provider connection list/create/detail/update/delete, cursor-agent
availability, provider quota-window and web-session metadata, provider batch-test request/results,
provider credential-validation inputs/results, API key list/create, combo list, usage
analytics/history/budget, and call-log summary/detail endpoints. It also types the v1 root catalog,
provider suggestions/plugin manifest, and quota preflight. The OpenAI single-model response now
describes provider context/input/output limits and capabilities. The Gemini v1beta model-list and
generation routes also describe native request/response formats. The spec has 133 component
schemas. All 98 operations previously missing
`x-loopback-only` under routeGuard's local-only prefixes are now annotated; the route-guard checker
and unit test enforce those markers.

## Request path through the current monolith

The public URL surface is still a single Next.js/Node process. `open-sse` is a library inside
that process, not an independently scheduled service. An inference request crosses these layers:

| Responsibility | Current implementation | Data-plane consequence |
| --- | --- | --- |
| HTTP entry and caller identity | `src/app/api/v1/*/route.ts`, `src/proxy.ts`, `src/server/authz/policies/clientApi.ts` | Next route dispatch and authz run for every request; API keys, dashboard sessions, and keyless-local policy meet here. |
| Chat protocol and request preparation | `src/sse/handlers/chat.ts`, `open-sse/handlers/chatCore.ts`, `open-sse/translator/*` | Body normalization, guardrails, compression, reasoning, protocol conversion, account selection, retries, and usage hooks share the Node event loop. |
| Provider routing and transport | `open-sse/services/combo.ts`, `open-sse/config/providerRegistry.ts`, `open-sse/executors/*`, `open-sse/utils/proxyFetch.ts` | Provider and account selection, fallback, quotas, upstream HTTP/WebSocket behavior, streaming, and cancellation are coupled to the same process state. |
| Admission and response lifetime | `src/shared/middleware/chatBodyAdmission.ts`, `src/shared/middleware/ingestByteAdmission.ts`, `open-sse/utils/earlyStreamKeepalive.ts` | Process-local count/byte queues bound request bodies and stream leases; a Rust service would need equivalent per-key fairness, pressure, and cancellation semantics. |
| Persistent usage and continuation | `src/lib/usage/callLogs.ts`, `src/lib/usage/callLogArtifacts.ts`, `src/lib/db/responsesContinuationStore.ts`, `src/lib/db/*` | SQLite rows, artifact files, quota bookkeeping, and Responses continuation history are updated across the request lifecycle; this persistence boundary must be designed before moving traffic between processes. |
| Control plane and tools | `src/app/dashboard/*`, `src/app/api/settings/*`, `src/app/api/a2a/*`, `open-sse/mcp-server/*` | Dashboard configuration, model/provider credentials, API-key scopes, quotas, MCP/A2A, and conversation inspection must remain available if inference moves. |

The initial split should keep the dashboard and admin API in Next.js, then let a Rust inference
service own direct HTTP ingress for a deliberately small endpoint set. It must not synchronously
call Next.js on each token. The service needs a versioned configuration/policy cache and explicit
key-revocation behavior; it cannot treat the current process-local caches or SQLite writes as
automatically shared state. PostgreSQL/Valkey are possible later tools, not requirements for the
transport prototype. The first migration gate is one OpenAI-compatible chat route with auth,
streaming, tool calls, cancellation, quota/account policy, and call-log parity, followed by a
controlled comparison under identical mock upstreams.

## Resource-pressure 503 path

The observed `resource_pressure` response is generated locally before provider dispatch. `chatCore`
calls `checkResourcePressureGuard()` at request setup; the chat-body admission layer uses the same
guard before reading large request bodies. The immediate check compares `process.memoryUsage().heapUsed`
with `HEAP_PRESSURE_THRESHOLD_MB`, calculated as 85% of `v8.heap_size_limit` with a 400 MiB floor
unless an explicit environment override is set. It returns 503 with `Retry-After: 5` at chat core;
the pre-body admission wrapper maps the same critical state to `Retry-After: 2`.
The 2026-10-08 04:51–05:00 warnings recorded 1,823–1,935 MiB against 1,822 MiB. That threshold
matches the 85%-of-heap rule for the configured 2 GiB old-space limit. The 503 therefore confirms
that the local JavaScript heap guard fired; it does not identify what raised heap use.

The same guard files are byte-identical in the current blue and green checkouts, so this feature
branch did not introduce the absolute threshold. The guard also runs an asynchronous sample about
once per second for V8 heap, process RSS/external/array-buffer bytes, cgroup current/high/max/events,
and memory PSI. It enters sampled critical state after two elevated samples and recovers after one
sample where tracked ratios are below 75% and PSI is below 15. A cached critical state is reused
while its sample is at most 30 seconds old; stale state fails open. PSI is read from host
`/proc/pressure/memory`, not the app's cgroup pressure file, so it can reflect unrelated host work.

The history snapshot at 05:11 recorded a 4 GiB app cgroup at 3.56 GiB, zero OOM counters, and
`NODE_OPTIONS=--max-old-space-size=2048`, while detailed capture was enabled. This is consistent
with a process nearing its configured V8 heap ceiling while the cgroup still had some headroom; it
does not prove logging caused the heap rise. The heap-shed warning in the feature branch now records
PID/time, route family, resolved provider/model labels, immediate heap/threshold, and the most recent
numeric V8/RSS/external/array-buffer/cgroup/PSI sample with its age. Logs include a validated UUID
correlation ID, and the rejected response returns it in `x-request-id`; malformed caller values are
replaced with a generated UUID. Route labels are allowlisted families, and no prompt, raw path,
header, or credential data is added. If no sample exists on a first-request trip, sample fields are
explicitly `null`; cached cgroup/PSI values can be up to one second old.

The immediate absolute-heap rejection now also records event-time process RSS, heap total, external
bytes, array-buffer bytes, and V8 used/limit values, so a first rejection has useful process context
even before the asynchronous sampler has published its first snapshot. The existing per-request
`process.memoryUsage()` call supplies those process values; the extra V8 heap snapshot runs only on
the rejection path. Validation also caught a correlation-propagation regression: a new call passed
`reqId` outside its scope in `handleSingleModelChatImplementation`. It now uses that function's
`runtimeOptions.correlationId`; the chat-admission binding suite passed 10/10 after the fix.

## Read-only observation of the running candidate

The root-managed `omni-local-next-app` is a candidate-slot container, not a change to `green`. Its
image label points to commit `6c6e6b16539e7cf43398fba5dc9b2e5bf4a7eed3`; it started at 2026-10-07
19:46 UTC with a 4 GiB memory cap, two CPU quota, and `NODE_OPTIONS=--max-old-space-size=2048`.
The call-log profile is `full-capture-v1`: stream-chunk capture is enabled, the pipeline artifact
limit is 10 MiB, per-stream retention is 256 KiB, and client text retention is 4 MiB. At 2026-10-08
12:17:30 UTC its log recorded V8 `heapUsed=1,869 MiB` above the `1,822 MiB` threshold and returned
503. An earlier cluster at 04:56–05:00 recorded 1,826–1,911 MiB against the same threshold.

A five-minute host/cgroup sample from 12:19:25–12:24:20, starting about two minutes after the later
guard trip, measured Node-process RSS at 3,318–3,335 MiB, high-water RSS at 3,841 MiB, and process
swap at 499 MiB. Cgroup memory was 4,028–4,044 MiB against 4,096 MiB; its swap was 833 MiB, anon
memory 3,005–3,021 MiB, file cache 942 MiB, and slab about 27 MiB. The `memory.events` max counter
was 1,534 but OOM and OOM-kill stayed zero; PSI some/full remained 0.00 during the sample, while
host available memory was 16.2–16.5 GiB. Podman's 3.149 GB stats reading is about 1 GiB below
`memory.current`; the cgroup file-cache and kernel figures account for most of that difference.
These measurements show a near-cap container and a Node process well above the V8 heap alone, but
the process/cgroup sample does not share an exact timestamp with the 12:17 heap reading.

The container's authenticated health route returned only its public liveness view; the supplied
`~/.omni-mg` credential received HTTP 403 from `/api/providers`, so its management scope or validity
does not grant this candidate's management detail endpoint. The call-log database has no row for
the 12:17 guard event (its latest row is three connection tests at 11:49), and the deployed
resource-pressure log has no request/correlation ID. This confirms that an early heap rejection is
currently not joined to a call-log record.

The call-log summary rows do show the workload immediately preceding the earlier guard cluster.
From 03:22–03:36 UTC there were 38 successful `codex/gpt-6-luna-max` requests with mean input
338,155 tokens, maximum 354,057, and mean duration 13.7 seconds. From 04:12–04:56 there were 80
more with mean input 377,071 tokens, maximum 398,367, mean duration 17.3 seconds, and one request
lasting 97.991 seconds. All 118 were marked as having pipeline details, but every artifact was
missing. Repeated local heap-guard 503s began at 04:56 and continued through 05:00, reporting
1,826–1,911 MiB against 1,822 MiB. This timing supports large-context traffic plus capture as a
plausible contributor; missing artifacts prevent verifying the request bodies or assigning
causality.

Artifact persistence is also missing: the latest file in the mounted `call_logs` directory
predates this candidate's 19:46 start. Its logs contain one generic
`Call-log artifact worker failed` warning at 03:36; the running image filesystem has neither
`/app/src/lib/usage/callLogArtifactWorker.js` nor its `.ts` source, while the current worker resolver
expects one of those runtime paths. This strongly suggests an image-packaging gap in artifact
capture; the exact worker failure reason and whether it explains every missing artifact still need
to be confirmed. The repository's Node and Bun Dockerfiles now fail their image build if the
colocated worker is absent, and the standalone-bundling unit test covers it. The separate
`deploy-swap/runtime-profile-v1/Candidate.Containerfile` that produced this running image is outside
the blue checkout and has not been changed. The feature branch now rate-limits payload-free
artifact-preparation refusal diagnostics with reason and reserved-byte estimates, and reports
worker spawn/write failures by a sanitized code. The live container and its data were observed
read-only.

The full-capture path does bounded synchronous work before handing an artifact to a worker. The
writer's weighted queue is capped at 128 MiB and serializes one artifact at a time; `reserveCallLogArtifactPreparation`
walks the raw payload synchronously before projecting it and posting a structured clone to that
worker. A large artifact can therefore spend main-thread time on request snapshots and the size
estimate even though JSON serialization and disk writes are off-thread. Treat capture load as a
plausible contributor to latency and peak heap until matched process telemetry proves or rules it
out.

## Isolated streaming proxy results

The harness in `benchmarks/runtime-proxy/` sends a small JSON request through each gateway to the
same local mock SSE server. Each response contains 200 events, spaced 10 ms apart, with a 64-byte
delta field (about 26 KiB total response). The 100-client case measures 100 simultaneously active
streams. Three trials per runtime used the same Python load generator and mock upstream, pinned to
CPUs 2–3. Node used the production base image's Node 26.10.0 digest; Bun used the official 1.4.0 and
1.4.2 images; Rust was built in release mode with rustc 1.94.0. Node and Bun containers had a 512
MiB limit. These proxy-only runs exclude Next.js, OmniRoute policy/auth/account routing, provider
SDKs, tool-call loops, and real provider quotas.

| Runtime | Trials | Completed | First body p50 / p95 | Completion p50 / p95 | Gateway peak RSS | CPU seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Node 26.10.0 | 3 | 100/100 each | 144 / 218 ms | 2,228 / 2,297 ms | 87.5 MiB | 0.82 |
| Bun 1.4.0 | 3 | 100/100 each | 133 / 138 ms | 2,203 / 2,210 ms | 41.1 MiB | 0.44 |
| Bun 1.4.2 | 3 | 100/100 each | 60 / 65 ms | 2,130 / 2,135 ms | 38.8 MiB | 0.34 |
| Rust/Axum/Reqwest | 3 | 100/100 each | 108 / 110 ms | 2,164 / 2,167 ms | 8.1 MiB | 0.21 |

In this transport-only workload, Bun 1.4.2 had the lowest first-byte latency, Rust the lowest
process footprint, and Node the highest footprint and latency. Bun 1.4.2's first-byte median was
about 2.2× lower than the repository's pinned Bun 1.4.0. Rust used about one-fifth of Bun's RSS, but
its first-byte latency was higher in this local proxy test. The mock server accounts for nearly all
completion time; these numbers measure only loopback gateway overhead, not model generation.

The same harness also tested bounds and cancellation once per runtime. With `MAX_INFLIGHT=64` and
100 clients, each gateway accepted 64 streams and returned 36 explicit 503 capacity responses. In
the cancellation case, all 100 clients disconnected after response headers and the mock upstream
reported zero active streams afterward for Node, Bun, and Rust. This validates bounded admission
and cleanup in the prototype adapters; real tool-call loops and account scheduling remain untested.

Bun `--smol` was tested once as an exploratory mode: RSS fell by only a few MiB while first-byte
latency rose substantially. It is excluded from the repeated comparison table because that trial's
load generator was not pinned identically.

## Multi-turn, persistent-session transport run

The harness now replays five sequential streamed requests for each independent agent session over a
reused HTTP/1.1 client connection. Later requests contain earlier user turns plus synthetic
`function_call` and `function_call_output` history. Each user turn adds 64 KiB of synthetic text;
the largest JSON body is 328,947 bytes. The mock upstream emits 50 SSE chunks at 10 ms intervals.
This models repeated requests and growing conversation bodies, but it does not run a real model,
execute a tool, or match 64 KiB to a token count.

At 70 sessions, all three runtimes completed 350/350 requests in one trial each. At 100 sessions,
each runtime completed 500/500 requests in all three trials. The table shows the median across
those three 100-session trials; completion time includes the mock stream delay.

| Runtime | Successful sessions / requests | First body p50 / p95 | Completion p50 / p95 | Peak RSS | CPU seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Node 26.10.0 | 100 / 500, each trial | 34.1 / 202.2 ms | 584.8 / 754.4 ms | 112.4 MiB | 1.82 |
| Bun 1.4.2 | 100 / 500, each trial | 23.3 / 51.3 ms | 541.2 / 579.7 ms | 63.1 MiB | 0.65 |
| Rust/Axum/Reqwest | 100 / 500, each trial | 21.5 / 102.0 ms | 535.6 / 624.9 ms | 43.3 MiB | 0.39 |

In this scenario, Rust had the smallest measured gateway footprint and CPU use; Bun had the lowest
first-body p95 and slightly higher aggregate request throughput; Node used more memory and CPU.
The first-byte p95 spread varied between trials, especially for Node and Rust. This validates that
the prototype transports can carry 70–100 concurrent persistent client sessions through repeated
requests without failure. It does not demonstrate 70–100 full OmniRoute agent workloads: database
lookups, tenant limits, account scheduling, production logging, provider adapters, actual tool
execution, and provider quotas are outside this harness.

The Rust prototype streams both request and response bodies and holds its bounded semaphore permit
until the response finishes or is cancelled. Rust does not use a garbage collector; its memory-safety
model comes from compile-checked ownership and borrowing. The benchmark demonstrates a small proxy
process, not a safe replacement for OmniRoute's provider, quota, security, cache, and tool-execution
behavior.

## One thousand simultaneous transport sessions

The same 1,000-session transport workload was repeated with the gateway pinned to four CPUs, the
Rust mock upstream on two CPUs, and the Python load client on two CPUs of the eight-CPU aarch64
devvm. Each session sent one 16,524-byte JSON body and received 20 SSE chunks at 25 ms intervals;
the admission cap was 1,024. This isolates a four-core gateway from the local mock and load client.
The devvm reports eight logical CPUs and 14 GiB total memory, so this pins the gateway to four
cores but does not reproduce Maria's 24 GiB memory configuration.
Node 25.8.1 and Rust 1.94.0 ran on the host. Bun 1.4.0 ran in its cached official image with a 512
MiB memory cap; because rootless Podman has no delegated cpuset controller, the harness pins the
container's host PID with `taskset`. The table reports medians from three sequential trials. Every
runtime completed 1,000/1,000 in all three trials.

| Runtime | First body p95 | Completion p95 | Gateway peak RSS | Gateway CPU | Throughput median (range) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rust/Axum/Reqwest | 541 ms | 1,112 ms | 35.7 MiB | 0.40 s | 526 req/s (523–532) |
| Node 25.8.1 | 913 ms | 1,429 ms | 207.6 MiB | 1.95 s | 440 req/s (431–461) |
| Bun 1.4.0 | 2,060 ms | 2,583 ms | 65.3 MiB | 0.79 s | 360 req/s (355–360) |

For this bounded synthetic transport test, Rust used about one-sixth the Node gateway RSS and one-
fifth of its CPU; Bun used more RSS than Rust and less than Node. Rust had the lowest first-body
and completion p95 in the measured range. This is a local transport result, not a full OmniRoute
agent-capacity or provider-quota claim.

The repeatable run command is documented in `benchmarks/runtime-proxy/README.md`. It pins the four-
CPU gateway, two-CPU Rust mock, and two-CPU load generator separately. Rootless Podman on the devvm
does not delegate the `cpuset` cgroup controller, so Bun's container process is pinned by host PID
with `taskset` after startup. This keeps the CPU allocation comparable without changing the
container's cgroup configuration.

## Rust scale beyond the target session count

With the same Rust mock upstream and load generator sharing the unpinned eight-CPU devvm, the Rust
proxy was exercised at 5,000 and 10,000 simultaneous sessions. Each sent one 16,525-byte JSON body
and received 20 mock SSE chunks at 25 ms intervals. Both single trials completed every request.

| Sessions / requests | First body p95 | Completion p95 | Gateway peak RSS | Gateway CPU | Throughput |
| --- | ---: | ---: | ---: | ---: | ---: |
| 5,000 / 5,000 | 1,529 ms | 1,968 ms | 173.5 MiB | 1.96 s | 1,846 req/s |
| 10,000 / 10,000 | 1,820 ms | 2,108 ms | 335.4 MiB | 3.80 s | 2,486 req/s |

An earlier 10,000-client run against the Node mock returned 1,375 `502 mock upstream unavailable`
responses. The bounded error-body preview identified the Node mock as the failing upstream; switching
the scale test to the Rust mock removed those failures. These 5k/10k runs are one trial each and test
only this Rust transport adapter. The four-core 1k comparison above is the repeatable CPU-bounded
result; neither benchmark executes model generation, tool calls, database policy, or call-log capture.

## Whole-host four-CPU saturation probe

A separate single-trial probe pinned the Rust gateway, Rust mock, and Python load generator to the
same four CPUs, modeling a host where the test harness competes with the gateway rather than having
dedicated helper cores. It completed 1,000/1,000 requests, but at 5,000 sessions returned 138
generic proxy `502` responses and at 10,000 returned 402. After adding a bounded error-body preview
and preserving the `reqwest` source chain in this benchmark-only adapter, another co-located 5,000
run returned one 502 and one 10,000 run returned 83. The captured failure was `Connection reset by
peer (os error 104)` while sending to the local mock; prior repeated 10,000 runs varied from zero to
429 failures. This points to the constrained, co-located loopback mock connection path, but the
specific close behavior is not isolated. The stress results are not evidence of OmniRoute or a real
provider failing. Gateway peak RSS was 174.8 MiB at 5,000 and 389.6 MiB at 10,000 in the earlier
failed trials. The separate 70–100 long-lived-session probe on the same four-CPU set is more
representative of the requested agent count. With five sequential turns per
session, 262,144 bytes of synthetic user text per turn, bodies up to 1,311,987 bytes, and 100 SSE
chunks spaced 10 ms apart, the 70-session run completed 350/350 requests. Three 100-session trials
each completed 500/500 requests; median first-body p95 was 66.8 ms, completion p95 1,184.8 ms,
gateway peak RSS 61.3 MiB, and gateway CPU 0.85 seconds. This supports the transport prototype at
70–100 synthetic active sessions on a shared four-CPU set. It does not include OmniRoute auth,
routing/account policy, database work, provider SDKs, persistent call-log capture, tool execution,
or real upstream quotas, so it is not yet a production-capacity claim.

## Production admission middleware with long-lived streams

The `omni-admission-node` adapter also exercises OmniRoute's actual TypeScript
`withChatAdmission` / `admitChatRequest` code, including the byte-budget queue and release at the end
of an SSE stream. On 2026-10-08, the prior implementation failed a 100-session test with 1.31 MiB
requests and one-second streams: 55/100 sessions finished and 417/500 requests succeeded. The
normal-pressure byte wait stopped at about 250 ms even though the configured queue window was 30
seconds, so requests shed with `inflight_bytes_budget` before stream completion freed capacity.

The fix makes byte waiters use the configured, bounded queue window and charges known-length queued
bodies against a shared 64 MiB queued-byte cap. Critical pressure still sheds immediately, bodies
larger than the entire byte budget still fail immediately, and the active in-flight budget remains
separate. Focused admission/resource tests pass 111/111.

The post-fix long-stream run used a 100-chunk SSE response at 10 ms per chunk and five sequential
requests per session. Each request carried 262,144 bytes of synthetic user text plus prior
synthetic function-call and tool-result history in a JSON body up to 1,311,987 bytes. At 70
sessions, 350/350 requests completed in 6.58 seconds; first-body p95 was
102.1 ms, completion p95 was 1,174.9 ms, and gateway peak RSS was 265.1 MiB. At 100 sessions, all
three trials completed 500/500 requests with no failures in 7.84–7.95 seconds. Across those trials,
median throughput was 63.7 requests/s, first-body p95 was 1,004 ms, completion p95 was 2,047 ms,
gateway peak RSS was 343.1 MiB, and gateway CPU was 3.0 seconds. Peak in-flight byte charges were
73.21 MiB against the 70 MiB (73,400,320-byte) limit; peak queued reservations were 19.92 MiB against
the separate 64 MiB limit. Queue counters returned to zero after each run.

A slower single trial used 300 chunks per response (3 seconds of streamed body time) at 100
sessions, with the same 1.31 MiB maximum request and five turns per session. It completed 500/500
requests without errors in 22.4 seconds. First-body p95 was 3.07 seconds and completion p95 was
6.22 seconds because waiters joined as stream leases became available. Peak in-flight charge was
73.21 MiB, queued reservations peaked at 19.92 MiB, and all counters returned to zero. This is one
trial; it shows queue drainage for this stream duration, not a sustained throughput guarantee.

This confirms the admission queue waits and drains under this local workload; it is not 100 full
agent sessions and does not include actual provider routing, tool execution, account scheduling,
database activity, or persistent call-log artifact writes. It also does not claim that 63.7 requests/s
is a production ceiling or that an upstream provider will accept the same burst. Those full-server
and real-provider checks remain necessary before treating 70–100 agents as validated capacity.

## Repeated request-log payload

The call-log path stores both the client request body and a reconstructed `effectiveInput`. For an
ordinary Responses request, those arrays can be identical. The new snapshot format records
`effectiveInputRef: "body.input"` only when both bounded representations are exactly equal; the
continuation store reads the existing `body.input` in that case. When continuation reconstruction
changes the input, or the text limits differ, the full effective input is kept.

On the incident-shaped synthetic Responses payload (3.058 MiB wire JSON), the serialized request
pipeline changed from 6.008 MiB to 3.058 MiB, saving 2.95 MiB per captured call. In a 100-request
heap run, the modeled retained snapshots were 344.2 MiB before dedup and 339.8 MiB after dedup. Most
of the direct benefit is reduced artifact size; the measured retained-object reduction is smaller
because strings are immutable and bounded logging retains a limited array tail.

The same 729-message/86-tool artifact shape was passed through the production queue estimator. Its
estimated artifact footprint fell from 96.2 MB to 65.1 MB, and the synchronous estimate took a median
3.83 ms before dedup versus 2.51 ms after. The writer reserves twice that estimate plus 64 KiB:
192.5 MB before dedup exceeds its 128 MiB total queue budget, while 130.3 MB after dedup fits by
about 3.7 MiB for an otherwise empty queue. This is one synthetic, single-artifact reservation;
other in-flight reservations consume the same budget. It shows the existing reference-based dedup
reduces queue pressure as well as serialized bytes, without removing distinct reconstructed
continuation inputs. This estimator run used Node 25.8.1 on the devvm, pinned to CPUs 2–3.

Call-log artifact schema 6 now stores references instead of a second copy when the top-level
request body exactly equals `pipeline.clientRawRequest.body`, or the top-level response equals
`pipeline.clientResponse.body`. `readCallArtifact()` expands those references before returning
data, so log detail and Responses continuation consumers keep their existing shape; distinct
payloads and older schema-5 artifacts remain unchanged. A synthetic 500,000-character request
round-tripped with the default 512 KiB artifact cap while omitting more than 450 KiB of duplicated
JSON. The logger now skips a second protection clone when the client snapshot exactly matches the
top-level request/response field; the conservative preparation reservation still accounts for
both source snapshots that are already live. This reduces a later transient copy and stored bytes,
but it does not eliminate the original parsed request plus the logger's bounded snapshot.

Schema 7 extends that exact-value compaction to repeated `pipeline.openaiRequest.body`,
`pipeline.providerRequest.body`, and `pipeline.providerResponse.body` values. The on-disk file keeps
one body and stores references for identical stages; `readCallArtifact()` expands them back to the
original object layout. No substring, approximate, or lossy text deduplication occurs. A synthetic
100 KiB request and 30 KiB response duplicated across client/OpenAI/provider stages saved more than
300 KiB, and a separate cap test confirms that fallback artifacts do not retain references after
their body-bearing pipeline is omitted. The focused artifact-cap/worker/drain suites passed 28/28.

## Build/runtime evaluation

The production Node image's exact base digest (`node:26.10.0-trixie-slim`) passed native dependency
validation after `npm ci --include=optional --ignore-scripts` installed 2,529 packages in about 40
seconds (4.1 GiB of `node_modules`). Its Next.js 16.3.8/Turbopack build was run with two pinned CPUs,
one page-data worker, a 3 GiB V8 heap setting, and a 5 GiB container limit. After about 27 minutes,
the build process exited 137 while still in optimized compilation. The container had repeatedly
hit its memory cap; because the diagnostic container used `--rm`, its final cgroup counters were not
preserved. No usable standalone bundle was produced. The devvm recovered after the container exited.

The repository's `Dockerfile.bun` path was tested with the pinned Bun 1.4.0 image and the same 5 GiB
limit. Its install resolved 9,470 package entries and installed 2,405 packages in about 50 seconds.
The image passed the `wreq-js` and `bun:sqlite` smoke checks. Bun emitted nested-override and peer
version warnings and compiled optional `libxmljs2` from C++ with `node-gyp`; rootless
`fuse-overlayfs` also spent several minutes processing the dependency layer. The optimized Next
build had not completed after about 22 minutes. The builder container disappeared without a final
exit code or usable image. Its last sampled cgroup was at the 5 GiB memory cap with reclaim events
but no OOM kill. These constrained runs show that neither path completed a release build within the
devvm budget; use a dedicated builder with more memory and native overlay storage for a valid
wall-time comparison.

The Bun base image has a `node` compatibility fallback but no `npm` executable. The package
`prebuild` hook originally invoked `npm run check:native-deps`, so the hook was changed to call the
Node script directly; the Bun builder then passed that hook and the docs sync check. There is no
checked-in `bun.lock`, and `Dockerfile.bun` installs before copying `package-lock.json`, so a clean
Bun build resolves package ranges independently from the npm lock. Add a Bun lockfile and compare
its resolved graph before considering that image reproducible. Bun 1.4.2's stream-proxy microbench
was close to 1.4.0; a full Bun 1.4.2 application build was not run.

A no-emit TypeScript check limited to the changed files still pulled in the broad `chat.ts` import
graph. Node spent about 3 minutes at 1.5–1.6 CPU cores and hit its default 4 GiB V8 heap limit;
there was no build artifact or typecheck result. This is separate from the earlier 5 GiB Next build
failures. A narrower follow-up that excluded `chat.ts` and included only the pressure/artifact modules
and their focused tests still reached a 3 GiB V8 heap limit and exited after about 74 seconds without
a result. Neither attempt reported a source diagnostic. A valid typecheck still needs a truly smaller
dependency boundary or a builder with a larger, explicitly budgeted heap.

## Remaining acceptance checks

- Obtain a management-scoped credential for the candidate or add a safe internal V8 snapshot
  endpoint, then sample the actual app PID's `heapUsed`, `external`, `arrayBuffers`, RSS, and cgroup
  data together. The current host sampler cannot identify the retained V8 objects.
- Fix the external candidate-image assembly so the artifact worker is present, then verify that
  pipeline artifacts are written and readable. The current image lost 118 detailed artifacts and
  no artifact file is newer than the image start; do not treat the `full-capture-v1` label as proof
  that capture works.
- Reproduce heap growth from a clean start with capture on/off and optional subsystems isolated;
  test that the local pressure guard recovers without restarting after pressure clears. No heap
  snapshot or controlled recovery result exists yet.
- Repeat full Next builds on a dedicated builder with enough memory to complete; record wall time,
  peak cgroup memory, output size, and health/model-catalog smoke tests.
- Typecheck the changed source with a bounded project graph or a larger, explicitly budgeted builder;
  the broad no-emit check exhausted 4 GiB, and the follow-up excluding `chat.ts` exhausted 3 GiB before
  either could report source errors.
- Run the Bun application build with a locked dependency graph and on both 1.4.0 and 1.4.2; record
  native-module, database, streaming, and shutdown differences.
- Exercise the full OmniRoute app with mock provider credentials at 70 and 100 active sessions,
  including actual tool-call cycles, authentication, account-level limits, and verified artifact
  capture. The current long-stream test covers only the production admission middleware plus mock
  streaming.
- Compare the current TypeScript route, Rust proxy, and Bifrost only with identical provider mocks
  and request policy; no language-wide performance conclusion follows from the current harness.
- Before production routing, port and parity-test authentication, key revocation, connection/model
  selection, service strategies, quotas, caching, tool loops, errors, and usage accounting. Keep the
  frontend/control plane deployed independently from the inference process.
- Continue the OpenAPI handler audit beyond the 179 operations with success-response content; the
  path/method/security-tier inventory is complete, but the remaining response schemas and auth
  behavior have not all been source-verified.
