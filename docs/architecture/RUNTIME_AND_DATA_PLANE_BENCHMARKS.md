# Runtime and inference data-plane investigation

**Status:** Active evaluation on `feat/inference-runtime-reliability`. These are isolated benchmark
results, not production capacity claims. No deployment is part of this work.

## OpenAPI surface and plane boundary

The canonical `docs/openapi.yaml` currently contains 705 route templates, 1,029 operations, and 64
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

Route coverage is stronger than schema completeness. All 1,029 operations still lack explicit
`operationId` values, only 120 have response content schemas, and 121 declare operation-level
security. The next contract pass must compare authentication and request/response schemas with each
handler before calling the entire OpenAPI document semantically complete. For routes with confirmed
configuration-dependent access, the spec now includes anonymous alternatives where the handler
allows them, including model discovery, combo/routing metadata, and the API Explorer endpoints.
All 98 operations previously missing `x-loopback-only` under routeGuard's local-only prefixes are
now annotated; the route-guard checker and unit test enforce those markers.

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
does not prove logging caused the heap rise. The heap-shed warning now records PID/time, immediate
heap/threshold, and the most recent numeric V8/RSS/external/array-buffer/cgroup/PSI sample with its
age. Logs now include a validated UUID correlation ID, and the rejected response returns it in
`x-request-id`; malformed caller values are replaced with a generated UUID. No prompt, body, header,
or credential data is added. If no sample exists on a first-request trip, sample fields are
explicitly `null`; cached cgroup/PSI values can be up to one second old. The exact object growth
remains unknown. The current shell has no listener on port 20128 or OmniRoute app container to
sample live now; the host-level snapshots below are not substituted for process-level measurements.

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

## Remaining acceptance checks

- Repeat full Next builds on a dedicated builder with enough memory to complete; record wall time,
  peak cgroup memory, output size, and health/model-catalog smoke tests.
- Run the Bun application build with a locked dependency graph and on both 1.4.0 and 1.4.2; record
  native-module, database, streaming, and shutdown differences.
- Exercise the full OmniRoute app with mock provider credentials at 70 and 100 active sessions,
  including actual tool-call cycles, authentication, call-log capture, and account-level limits.
- Compare the current TypeScript route, Rust proxy, and Bifrost only with identical provider mocks
  and request policy; no language-wide performance conclusion follows from the current harness.
- Before production routing, port and parity-test authentication, key revocation, connection/model
  selection, service strategies, quotas, caching, tool loops, errors, and usage accounting. Keep the
  frontend/control plane deployed independently from the inference process.
