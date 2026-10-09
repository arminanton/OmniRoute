---
title: "Runtime and Inference Data Plane Investigation"
version: 3.8.51
lastUpdated: 2026-10-09
---

# Runtime and inference data-plane investigation

**Status:** Active evaluation on `feat/inference-runtime-reliability`. These are isolated benchmark
results, not production capacity claims. No deployment is part of this work.

## OpenAPI surface and plane boundary

The canonical `docs/openapi.yaml` currently contains 705 route templates, 1,029 operations, and 668
component schemas. The API route inventory checker verifies that source files and the spec agree on
every path, exported method, and path parameter; it reports 705/705 routes and the documented public
copy at `public/openapi.yaml` is byte-identical to the canonical spec.

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
contract is still stronger on route coverage than schema completeness: 445 operations have success
response content schemas and 370 declare operation-level security. Of 1,001 operations with a
non-`204` success status, 556 still lack an explicit success-body schema; 13 operations have no
declared `2xx` status, and 15 return only an intentional `204`. This pass added concrete schemas for provider-model lookup, pricing
model catalogs, free-model budgets, conversation summaries, paginated conversation turns, the
management log-detail route's in-flight/in-memory/persisted variants, and the health route's public
liveness versus authenticated system/pressure snapshot responses. The health snapshot includes the
latest cached V8/process/cgroup/PSI sample with age and pressure state. The conversation response
documents that turn text/tool display fields are recovered from call-log artifacts and can be empty
after details are unavailable. Some operations use redirects, WebSocket `101`, or intentional
`404`/`405` HEAD/catch-all behavior; these are reviewed separately from JSON success schemas. The
OpenAI chat, Anthropic
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
provider credential-validation inputs/results, connection-test results, connection model discovery,
and the provider health matrix, expiration summary, health-autopilot reports/actions, and VS Code
combo compatibility responses; API key list/create, combo list, usage
analytics/history/budget, and call-log summary/detail endpoints. It also types the v1 root catalog,
provider suggestions/plugin manifest, and quota preflight. The OpenAI single-model response now
describes provider context/input/output limits and capabilities. The Gemini v1beta model-list and
generation routes also describe native request/response formats. The provider-client response now
masks primary and rotating API keys and omits OAuth tokens. Subsequent usage-contract passes added
typed schemas and query parameters for provider quota/utilization, combo health/forecast/autopilot/
scoring/dashboard, and per-key token-limit CRUD, including its Zod-backed mutation body and
validation errors. This pass also types cached provider-limit sync results, provider quota-window
costs, and per-provider daily usage rows. The latest settings pass adds accurate proxy, IP-filter,
system-prompt, and thinking-budget request/response contracts, including configuration-dependent
management authentication.
This provider/CLI pass adds typed contracts for parameter filters, interception rules, Claude Code
alias overrides, and Antigravity MITM start/stop plus alias read/write variants.
The auth and database-backup pass types session/CSRF responses, backup restore and retention bodies,
binary database exports, the actual gzip tar export format, and both multipart and raw-binary imports.
The usage pass adds request/proxy log shapes, bulk budgets, reset-credit responses, combo decision
traces, route-explainability, and text/JSON `om-usage` modes. The latest passes add log-console,
legacy-detail and export shapes; category-specific private-overflow errors; API-key masked metadata,
secret reveal/regeneration and device/usage-limit responses; key-group membership/permission CRUD;
provider batch mutation results; model-capability overrides; model-combo mappings; single/batch
model-test results; Codex auth import, ZIP extraction, export, and local-apply; Antigravity CLI auth
import/paste/local detection; provider model-sync; provider-ID login/refresh and Claude auth-file
operations; the VS Code-compatible route family; proxy registry/pool settings; free-proxy list,
stats, sync, deletion, and pool-promotion contracts; and the generic OAuth dispatcher’s method- and
action-dependent auth, input, response, retirement, and error variants. The free-proxy work repaired
previously unresolved schema references and types the relay-auth repair result. OAuth device-code
fields remain open-ended where provider adapters return different wire names. The latest contract
pass adds source-backed file upload/list/download, asynchronous batch job/file, cloud-agent
credential/health/task, V1 proxy-registry/assignment/health, provider/account registered-key
issuance limits and registered-key create/list/revoke, and quota pool/group/plan/usage/preview
contracts. File bytes, batch errors/usage, quota usage extensions, and provider task results remain
open-ended where the implementation stores arbitrary JSON. Dynamic provider quota data also remains
open-ended because adapters return different fields. The combo-management pass adds typed combo
create/update/list/detail, strategy and model-step configuration, metrics, testing, auto-generation,
builder options, duplicate-to-static, and reorder contracts. The RTK pass types normalized settings,
partial updates, filter-catalog diagnostics, TOML validation/install results, text tests, retained
raw-output text, recurring-noise candidates, and reviewable learned-filter drafts; it also documents
the configuration-gated management auth on discover/learn. The latest resilience/rate-limit pass
types dashboard concurrency settings, strict resilience patches, rate-limit status/toggle results,
legacy 308 redirects, connection/breaker state and reset outcomes. It also fixes a source mismatch:
the Resilience dashboard sends `requestQueue.globalConcurrentRequests`, which the strict PATCH
validator previously rejected despite the normalizer/runtime supporting it. The cache/observability
pass types semantic and provider-cache statistics, trends, idempotency and LRU counters, cache
invalidation scopes, and the compression-memo hit/miss windows. The compression-settings pass
types the strict global settings update and normalized read response, including all current mode
values; partial MCP output-trimming config and clamped result; compression preview inputs, diffs,
validation and stats; and language-pack/rule catalogs. These slices bring the spec to 668 component
schemas, with 445 operations declaring success-body schemas and 370 operation-level security
declarations.
All 98 operations previously missing
`x-loopback-only` under routeGuard's local-only prefixes are now annotated; the route-guard checker
and unit test enforce those markers.

## Request path through the current monolith

The public URL surface is still a single Next.js/Node process. `open-sse` is a library inside
that process, not an independently scheduled service. An inference request crosses these layers:

| Responsibility                        | Current implementation                                                                                                                 | Data-plane consequence                                                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP entry and caller identity        | `src/app/api/v1/*/route.ts`, `src/proxy.ts`, `src/server/authz/policies/clientApi.ts`                                                  | Next route dispatch and authz run for every request; API keys, dashboard sessions, and keyless-local policy meet here.                                                                                           |
| Chat protocol and request preparation | `src/sse/handlers/chat.ts`, `open-sse/handlers/chatCore.ts`, `open-sse/translator/*`                                                   | Body normalization, guardrails, compression, reasoning, protocol conversion, account selection, retries, and usage hooks share the Node event loop.                                                              |
| Provider routing and transport        | `open-sse/services/combo.ts`, `open-sse/config/providerRegistry.ts`, `open-sse/executors/*`, `open-sse/utils/proxyFetch.ts`            | Provider and account selection, fallback, quotas, upstream HTTP/WebSocket behavior, streaming, and cancellation are coupled to the same process state.                                                           |
| Admission and response lifetime       | `src/shared/middleware/chatBodyAdmission.ts`, `src/shared/middleware/ingestByteAdmission.ts`, `open-sse/utils/earlyStreamKeepalive.ts` | Process-local count/byte queues bound request bodies and stream leases; a Rust service would need equivalent per-key fairness, pressure, and cancellation semantics.                                             |
| Persistent usage and continuation     | `src/lib/usage/callLogs.ts`, `src/lib/usage/callLogArtifacts.ts`, `src/lib/db/responsesContinuationStore.ts`, `src/lib/db/*`           | SQLite rows, artifact files, quota bookkeeping, and Responses continuation history are updated across the request lifecycle; this persistence boundary must be designed before moving traffic between processes. |
| Control plane and tools               | `src/app/dashboard/*`, `src/app/api/settings/*`, `src/app/api/a2a/*`, `open-sse/mcp-server/*`                                          | Dashboard configuration, model/provider credentials, API-key scopes, quotas, MCP/A2A, and conversation inspection must remain available if inference moves.                                                      |

The initial split should keep the dashboard and admin API in Next.js, then let a Rust inference
service own direct HTTP ingress for a deliberately small endpoint set. It must not synchronously
call Next.js on each token. The service needs a versioned configuration/policy cache and explicit
key-revocation behavior; it cannot treat the current process-local caches or SQLite writes as
automatically shared state. PostgreSQL/Valkey are possible later tools, not requirements for the
transport prototype. The first migration gate is one OpenAI-compatible chat route with auth,
streaming, tool calls, cancellation, quota/account policy, and call-log parity, followed by a
controlled comparison under identical mock upstreams.

Rust is the preferred first data-plane implementation for this project; Go/Bifrost remains an
optional comparison. Rust does not use a tracing garbage collector: its ownership and borrowing
rules let the compiler check memory lifetimes ([Rust ownership guide](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html)).
This can avoid GC work and pauses, but it does not make the service immune to retained state,
unbounded queues, or allocator growth, so those remain explicit benchmark measurements. Bun is a
separate JavaScript runtime experiment: it uses JavaScriptCore's garbage collector, and its
[`--smol` mode](https://bun.sh/docs/runtime#bun-run---smol) trades throughput for more frequent
collection. Neither language nor runtime gets a performance win by assumption; the measured request
path and RSS decide.

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
the rejection path. It also suppresses the heap helper's generic warning on this path, leaving one
correlated resource-pressure diagnostic per rejected request. A regression test now verifies that
the immediate absolute-heap guard accepts the next request once live heap usage returns to its
threshold. Validation also caught a correlation-propagation regression: a new call passed
`reqId` outside its scope in `handleSingleModelChatImplementation`. It now uses that function's
`runtimeOptions.correlationId`; the chat-admission binding suite passed 10/10 after the fix.

## Read-only observation of the running candidate

The root-managed `omni-local-next-app` is a candidate-slot container, not a change to `green`. Its
image label points to commit `6c6e6b16539e7cf43398fba5dc9b2e5bf4a7eed3`; it started at 2026-10-07
19:46 UTC with a 4 GiB memory cap, two CPU quota, and `NODE_OPTIONS=--max-old-space-size=2048`.
The call-log profile is `full-capture-v1`: stream-chunk capture is enabled, the pipeline artifact
limit is 10 MiB, per-stream retention is 256 KiB, and client text retention is 4 MiB. At 2026-10-08
12:17:30 UTC its log recorded V8 `heapUsed=1,869 MiB` above the `1,822 MiB` threshold and returned 503. An earlier cluster at 04:56–05:00 recorded 1,826–1,911 MiB against the same threshold.

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

The blue branch now checks that the resolved artifact-worker file exists before it compares,
estimates, protects, or clones request/response bodies. If the worker is absent, it skips the
unwritable payload and retains the scalar call-log row and bounded error summary. When a valid
persisted private-overflow reference exists, it now writes only a tiny sanitized pointer artifact
synchronously, with reason `call_log_artifact_worker_missing`; the request/response payload remains
untraversed. Without such a reference, detail stays missing. Node and Bun tests confirm both paths.
This lets an existing overflow capture remain reachable in the log UI even in a broken image, but
it cannot repair old rows or capture providers without an overflow trace. The external candidate
image recipe still needs to include and verify the worker.

The private overflow path now also records HTTP attempts made by the Codex executor when all of the
existing gates allow detailed capture: overflow capture enabled, detailed logging enabled, a client
snapshot above the configured threshold, and provider `codex`/`openai-codex`. It stores exact
serialized provider request and response bytes in private gzip files and only allowlisted status,
URL path, and headers in the manifest. `noLog` and disabled detailed logging do not create a trace.
Codex response chunks are forwarded without waiting for disk writes; a bounded 256 KiB per-file
write queue marks the capture incomplete if storage cannot keep up. The synthetic HTTP 429, pre-header
timeout, secret-redaction, and delayed-write tests pass. This does not capture Codex native WebSocket
event bodies or prove full-app/provider reliability; those remain separate acceptance checks.

## App stop caused by egress dependency failure (read-only)

The current host has no OmniRoute app process/container to sample. Systemd reports
`omni-local-next@app.service` inactive since 2026-10-08 18:16:26 UTC. The unit's `ExecMainStatus=15`
is SIGTERM, its result is `success`, and the service log says it drained zero requests and checkpointed
SQLite before exit. There is no current in-process V8 heap sample. The host currently has about 21 GiB
available RAM and zero PSI pressure.

PID 1's journal identifies the preceding failure: `omni-egress-controller.service` exited status 1
at 18:16:21. Its Python traceback shows `TimeoutExpired` while opening the egress gate with a 3-second
deadline; a second traceback hit the `ip netns exec omni-app readlink /proc/self/ns/net` identity
probe after about 0.47 seconds. The displayed `FileNotFoundError: /opt/omni-egress/-m` came from the
Apport exception hook while handling those timeouts; it is secondary. The systemd app has
`BindsTo=omni-egress-controller.service`, so that fail-closed dependency exit sent SIGTERM to the app.
The controller restarted three times and is active now; the same namespace readlink takes about
0.01 seconds in three read-only probes.

Host sysstat has no sample at the exact failure second; its 18:20 sample, four minutes later, showed
77.3% CPU idle, a 1.23 load average on four CPUs, about 20.4 GiB available memory, 11.7% disk
utilization, and 2,460 swap pages written per second. That later host-wide sample does not prove what
caused either namespace command to time out, and it cannot substitute for the absent app-cgroup
measurements at 18:16.

The app did not restart after the dependency recovered. Its unit has `Restart=on-failure`, while the
dependency stop was recorded as a successful SIGTERM drain. The browser/Codex sidecars initially
failed their stopped-role cleanup, then restarted at 18:17 on image revision
`67503e560a1a26eb60f85be5108975679306b6eb`; the app container was removed. The unit description
says “green app” and `6dd568ad10b4`, but the stopped app image labels identify slot `candidate` and
revision `6c6e6b16539e7cf43398fba5dc9b2e5bf4a7eed3`. This is a deployment-state mismatch to resolve
before claiming that the green app is serving traffic. No unit, egress process, container, or
configuration was restarted or changed during this observation.

## Isolated streaming proxy results

The harness in `benchmarks/runtime-proxy/` sends a small JSON request through each gateway to the
same local mock SSE server. Each response contains 200 events, spaced 10 ms apart, with a 64-byte
delta field (about 26 KiB total response). The 100-client case measures 100 simultaneously active
streams. Three trials per runtime used the same Python load generator and mock upstream, pinned to
CPUs 2–3. Node used the production base image's Node 26.10.0 digest; Bun used the official 1.4.0 and
1.4.2 images; Rust was built in release mode with rustc 1.94.0. Node and Bun containers had a 512
MiB limit. These proxy-only runs exclude Next.js, OmniRoute policy/auth/account routing, provider
SDKs, tool-call loops, and real provider quotas.

| Runtime           | Trials |    Completed | First body p50 / p95 | Completion p50 / p95 | Gateway peak RSS | CPU seconds |
| ----------------- | -----: | -----------: | -------------------: | -------------------: | ---------------: | ----------: |
| Node 26.10.0      |      3 | 100/100 each |         144 / 218 ms |     2,228 / 2,297 ms |         87.5 MiB |        0.82 |
| Bun 1.4.0         |      3 | 100/100 each |         133 / 138 ms |     2,203 / 2,210 ms |         41.1 MiB |        0.44 |
| Bun 1.4.2         |      3 | 100/100 each |           60 / 65 ms |     2,130 / 2,135 ms |         38.8 MiB |        0.34 |
| Rust/Axum/Reqwest |      3 | 100/100 each |         108 / 110 ms |     2,164 / 2,167 ms |          8.1 MiB |        0.21 |

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

| Runtime           | Successful sessions / requests | First body p50 / p95 | Completion p50 / p95 |  Peak RSS | CPU seconds |
| ----------------- | -----------------------------: | -------------------: | -------------------: | --------: | ----------: |
| Node 26.10.0      |          100 / 500, each trial |      34.1 / 202.2 ms |     584.8 / 754.4 ms | 112.4 MiB |        1.82 |
| Bun 1.4.2         |          100 / 500, each trial |       23.3 / 51.3 ms |     541.2 / 579.7 ms |  63.1 MiB |        0.65 |
| Rust/Axum/Reqwest |          100 / 500, each trial |      21.5 / 102.0 ms |     535.6 / 624.9 ms |  43.3 MiB |        0.39 |

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

## Chat-completions transport and Bifrost comparison

The runtime harness now also sends OpenAI Chat Completions streams with previous synthetic
assistant tool_calls and tool-result messages. It uses 100 persistent HTTP/1.1 client sessions,
five sequential requests per session, 100 SSE chunks at 10 ms, and a local mock provider. The largest
request in the 256 KiB-per-user-turn scenario is 1,312,164 bytes. The transcript has tool-call
history but no tool execution or model generation.

The repeated three-trial matrix ran on the 8-logical-CPU ARM64 devvm. The Rust mock used CPUs 2–3,
the gateway CPUs 0–1, and the Python load client CPUs 4–7. Node 25.8.1 and Rust 1.94.0 ran as host
processes; Bun 1.4.0 ran in a 512 MiB container. Bifrost v1.3.9 ran from its pinned ARM64 image with
a 2 GiB container memory limit, 128 client workers, 128 per-provider workers/queue slots, request
logging disabled, and an OpenAI-compatible provider pointing at the same local mock. The Bifrost
pool limits are explicit because its docs describe 300 client workers by default and 1,000 provider
workers with a 5,000-item provider queue; larger pools increase baseline memory ([client settings](https://github.com/maximhq/bifrost/blob/dev/docs/deployment-guides/config-json/client.mdx), [provider concurrency settings](https://github.com/maximhq/bifrost/blob/dev/docs/quickstart/gateway/provider-configuration.mdx)).
Bifrost startup also reported a catalog of 4,962 models across 126 providers; the Rust adapter builds
no model catalog or provider-routing layer.

Each cell below reports the median across three trials. Every run completed 500/500 requests with no
HTTP failures. First-body and completion figures are the median of each trial's p95; RSS and CPU
are gateway-process samples.

| Runtime                | User text per turn | Max request | First-body p95 | Completion p95 |  Peak RSS |    CPU | Throughput |
| ---------------------- | -----------------: | ----------: | -------------: | -------------: | --------: | -----: | ---------: |
| Node 25.8.1            |             16 KiB |    83,364 B |       183.8 ms |       1,306 ms | 163.5 MiB | 2.56 s | 85.2 req/s |
| Bun 1.4.0              |             16 KiB |    83,364 B |        82.2 ms |       1,201 ms |  48.7 MiB | 1.17 s | 87.3 req/s |
| Rust/Axum/Reqwest 1.94 |             16 KiB |    83,364 B |        75.4 ms |       1,188 ms |  16.3 MiB | 0.56 s | 87.5 req/s |
| Bifrost 1.3.9          |             16 KiB |    83,364 B |        42.0 ms |       1,153 ms | 177.5 MiB | 1.70 s | 87.1 req/s |
| Node 25.8.1            |            256 KiB | 1,312,164 B |       203.9 ms |       1,328 ms | 317.0 MiB | 3.23 s | 82.7 req/s |
| Bun 1.4.0              |            256 KiB | 1,312,164 B |        59.3 ms |       1,166 ms |  66.1 MiB | 1.41 s | 83.8 req/s |
| Rust/Axum/Reqwest 1.94 |            256 KiB | 1,312,164 B |        73.3 ms |       1,185 ms |  60.3 MiB | 0.64 s | 83.0 req/s |
| Bifrost 1.3.9          |            256 KiB | 1,312,164 B |       119.8 ms |       1,235 ms | 1,335 MiB | 3.85 s | 81.2 req/s |

At the 1,312,164-byte request size, a separate one-trial Bifrost run capped at 1 GiB still completed
500/500, but throughput fell to 16.1 req/s, first-body p95 rose to 20.17 s, and process RSS reached
1,012.8 MiB. Podman reported 1.004 GB of the 1.074 GB container limit after the run; host swap use
increased by roughly 0.5 GiB and returned after the container stopped. With a 2 GiB limit,
Bifrost's first-body p95 was about 120 ms and its median process high-water RSS was 1.31 GiB.
This strongly suggests request-size/memory pressure caused the low-cap latency collapse; it does not
establish a general Bifrost limit or an upstream provider limit.

For this mock workload, all four gateways had similar throughput at both request sizes. Rust used
the least process CPU and memory in the transparent-proxy comparison; Bun's results were close and
its p95 first-body latency was lowest among the Node/Bun/Rust trio at the large request size.
Bifrost includes provider routing and request processing, while this Rust implementation only
forwards bounded streams. This is therefore a measured capability-versus-transport comparison, not
proof that the Rust prototype replaces Bifrost or OmniRoute. It does independently reject any
universal speed or memory claim from these measurements alone.

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

| Runtime           | First body p95 | Completion p95 | Gateway peak RSS | Gateway CPU | Throughput median (range) |
| ----------------- | -------------: | -------------: | ---------------: | ----------: | ------------------------: |
| Rust/Axum/Reqwest |         541 ms |       1,112 ms |         35.7 MiB |      0.40 s |       526 req/s (523–532) |
| Node 25.8.1       |         913 ms |       1,429 ms |        207.6 MiB |      1.95 s |       440 req/s (431–461) |
| Bun 1.4.0         |       2,060 ms |       2,583 ms |         65.3 MiB |      0.79 s |       360 req/s (355–360) |

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

| Sessions / requests | First body p95 | Completion p95 | Gateway peak RSS | Gateway CPU |  Throughput |
| ------------------- | -------------: | -------------: | ---------------: | ----------: | ----------: |
| 5,000 / 5,000       |       1,529 ms |       1,968 ms |        173.5 MiB |      1.96 s | 1,846 req/s |
| 10,000 / 10,000     |       1,820 ms |       2,108 ms |        335.4 MiB |      3.80 s | 2,486 req/s |

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
failed trials.

A separate 70–100-session workload on the same shared four-CPU set is more representative of the
requested agent count. Each session made five sequential requests with 262,144 bytes of synthetic
user text per turn, bodies up to 1,311,987 bytes, and 100 SSE chunks spaced 10 ms apart. At 70
sessions, Node, Bun, and Rust each completed 350/350 requests in one trial. At 100 sessions, each
runtime completed 500/500 requests in all three trials.

| Runtime                | Trials at 100 sessions | First-body p95 | Completion p95 | Gateway peak RSS | Gateway CPU | Throughput |
| ---------------------- | ---------------------: | -------------: | -------------: | ---------------: | ----------: | ---------: |
| Node 25.8.1            |             3/3 passed |         167 ms |       1,299 ms |        291.2 MiB |      3.41 s | 82.3 req/s |
| Bun 1.4.0              |             3/3 passed |          59 ms |       1,162 ms |         70.8 MiB |      1.89 s | 84.0 req/s |
| Rust/Axum/Reqwest 1.94 |             3/3 passed |          68 ms |       1,174 ms |         65.0 MiB |      0.86 s | 83.1 req/s |

The gateway, local Rust mock, and Python client were pinned to CPUs 0–3; Bun ran in its official
512 MiB container with its host PID pinned after startup. For this synthetic transport workload,
Bun had the lowest first-body p95, Rust the lowest measured RSS and CPU, and Node the highest RSS
and CPU. All three had similar throughput and no failed requests. These runs omit OmniRoute auth,
database policy, account scheduling, provider SDKs, persistent call-log capture, tool execution,
and real upstream quotas; they do not establish production capacity.

### Maria host rerun

On 2026-10-08 the same workload ran on the current Maria host: Ubuntu 24.04.4, four vCPUs, and
24 GiB RAM. Node 26.10.0 and Bun 1.4.0 ran in official rootless-Podman containers limited to
512 MiB; Rust 1.94.1/Axum 0.8.9/Reqwest 0.12.28 was compiled in the official Rust container and
ran as a host process, so its RSS is not under the same cgroup cap. The gateway, local Node mock
upstream, and Python load client shared CPUs 0–3. Every session made five sequential requests with
262,144 bytes of synthetic user text per turn; the largest JSON body was 1,311,987 bytes and each
response carried 100 SSE chunks at 10 ms intervals. This includes synthetic function-call/result
history in later turns, but does not execute tools.

All three gateways passed 350/350 requests at 70 sessions in one trial and 500/500 in each of three
trials at 100 sessions. The table gives the single 70-session result and the median of the three
100-session runs; latency values are p95. Peak RSS and CPU are for the gateway process only.

| Runtime           | Sessions | Trials | First-body p95 | Completion p95 |  Peak RSS |    CPU | Throughput |
| ----------------- | -------: | -----: | -------------: | -------------: | --------: | -----: | ---------: |
| Node 26.10.0      |       70 |      1 |         224 ms |       1,247 ms | 124.2 MiB | 5.41 s | 58.2 req/s |
| Bun 1.4.0         |       70 |      1 |          72 ms |       1,106 ms |  75.9 MiB | 2.62 s | 60.5 req/s |
| Rust/Axum/Reqwest |       70 |      1 |          73 ms |       1,131 ms |  52.0 MiB | 1.41 s | 60.1 req/s |
| Node 26.10.0      |      100 |      3 |         299 ms |       1,326 ms | 138.9 MiB | 6.69 s | 80.0 req/s |
| Bun 1.4.0         |      100 |      3 |         101 ms |       1,135 ms |  74.6 MiB | 3.51 s | 83.4 req/s |
| Rust/Axum/Reqwest |      100 |      3 |          99 ms |       1,141 ms |  70.2 MiB | 1.93 s | 83.5 req/s |

This host reproduced the earlier pattern: similar throughput, substantially less gateway CPU for Rust,
and lower RSS for Bun and Rust than Node. In this run Bun had the lowest 100-session completion p95;
Rust and Bun were close. This is still a local mock-transport result. It excludes the Next.js auth
and route stack, provider/account selection, actual model quotas, tool execution, and persistent call
log artifacts. The reported 70–100 sessions are not a full-agent acceptance result.

## Production admission middleware with long-lived streams

The `omni-admission-node` adapter also exercises OmniRoute's actual TypeScript
`withChatAdmission` / `admitChatRequest` code, including the byte-budget queue and release at the end
of an SSE stream. On 2026-10-08, the prior implementation failed a 100-session test with 1.31 MB (1.25 MiB)
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
73.21 MB (69.82 MiB) against the 70 MiB (73,400,320-byte) limit; peak queued reservations were
19.92 MB (18.99 MiB) against the separate 64 MiB limit. Queue counters returned to zero after each
run.

The same production-admission adapter was rerun on Maria on 2026-10-08 using host Node 24.21.0,
four shared CPUs, five turns per session, 1.31 MB (1.25 MiB) maximum request bodies, and 100 synthetic SSE
chunks per response. It passed 350/350 at 70 sessions and 500/500 in each of three 100-session
trials. The 100-session table shows medians across those trials; the byte figures are peak values.

| Sessions | Trials | First-body p95 | Completion p95 | Throughput | Peak process RSS | Peak in-flight bytes | Peak queued bytes |
| -------: | -----: | -------------: | -------------: | ---------: | ---------------: | -------------------: | ----------------: |
|       70 |      1 |         131 ms |       1,296 ms | 49.1 req/s |        263.5 MiB |             69.8 MiB |           7.0 MiB |
|      100 |      3 |         987 ms |       2,129 ms | 57.1 req/s |        299.7 MiB |             69.8 MiB |          20.0 MiB |

All four runs ended with zero active admission leases, queued bytes, waiting requests, and in-flight
byte charges. This confirms that the current admission wrapper drains on the Maria host at this
synthetic request size and stream duration. The adapter does not run Next auth, call-log artifact
writes, provider routing, real tools, or external quotas, and so is not full Prime-agent E2E.

A separate chat-shaped admission check used 100 sessions, five rounds, 16 KiB of synthetic user text
per turn, 100 SSE chunks at 10 ms, and the same CPU split on Maria. It completed 500/500 requests;
first-body p95 was 971.5 ms, completion p95 was 2,066.8 ms, gateway RSS reached 329.7 MiB, and CPU
time was 6.17 seconds. Peak in-flight and queued byte reservations were 73.2 MB and 20.4 MB; all
leases and queues returned to zero. The adapter exercises the production admission middleware with
Chat Completions-shaped request bodies, but its deterministic SSE response is not an upstream
provider's Chat Completions stream.

## Rust policy-aware chat prototype

The separate `rust-chat-gateway` benchmark binary adds one static client key, constant-time bearer
comparison, a fixed per-key requests-per-minute window, and a global in-flight semaphore. It charges
request bodies against a shared 64 KiB-unit budget at four times encoded body bytes plus 128 bytes
per observed JSON structural token, capped at 100,000 tokens. It validates the chat shape, rewrites
model aliases, replaces the caller credential with an upstream credential, streams responses, and
releases leases on disconnect. Body size, aggregate body budget, in-flight concurrency, and alias
table size have hard limits. It does not read employee keys or policy from OmniRoute storage, select
provider accounts, execute tools, apply distributed quotas, retry providers, write call logs, or
translate provider protocols.

On the 8-logical-CPU devvm with 14 GiB RAM reported by the guest, I compared this prototype with the
transparent Rust transport adapter using the same local Rust mock, synthetic chat tool history,
262,144 bytes of user text per turn, five sequential turns per session, and 100 SSE chunks at 10 ms.
The benchmark processes were pinned to gateway CPUs 6–7, mock CPU 5, and load CPU 4. Each row is one
trial; the request bodies reached 1,312,156 bytes. Linux `VmHWM` is included as a kernel-maintained
process high-water measurement alongside the harness's 25 ms RSS samples.

| Sessions | Rust path                   | Completed | First-body p95 | Completion p95 |  Throughput |    VmHWM | Gateway CPU |
| -------: | --------------------------- | --------: | -------------: | -------------: | ----------: | -------: | ----------: |
|       70 | Transparent stream proxy    |   350/350 |        68.3 ms |       1,199 ms | 59.34 req/s | 47.3 MiB |      0.41 s |
|       70 | Policy-aware chat prototype |   350/350 |        68.3 ms |       1,185 ms | 59.39 req/s | 61.6 MiB |      0.92 s |
|      100 | Transparent stream proxy    |   500/500 |        55.2 ms |       1,192 ms | 82.78 req/s | 64.5 MiB |      0.58 s |
|      100 | Policy-aware chat prototype |   500/500 |        84.4 ms |       1,227 ms | 82.18 req/s | 82.9 MiB |      1.31 s |

Both completed every synthetic request. At 100 sessions, the policy-aware prototype used about 18
MiB more process high-water RSS and 0.73 seconds more gateway CPU than the streaming-only adapter;
throughput was within 1 request/second. At 70 sessions, the differences were about 14 MiB and 0.51
CPU seconds. First-body p95 differed by 29 ms and completion p95 by 35 ms at 100 sessions; one run
per path cannot separate that spread from host/test noise. A 70-client
cancellation probe also returned all 70 HTTP 200 headers, cancelled all 70 response reads after
100 ms, and finished with zero active gateway streams and the full 512 MiB body budget available;
five focused Rust gateway tests passed, including rejection of high-structure JSON before parsing
and client-disconnect lease release.

This shows that these bounded gateway steps have a small footprint in this synthetic workload. It
does not establish performance parity with OmniRoute's TypeScript route or real provider capacity.
The next useful comparison is the same auth, account-policy, model-selection, and stream workload
through the actual TypeScript path, Bun/Turbopack candidate, and Rust prototype with matched behavior.

## Antigravity CLI/IDE tool-roundtrip and capture check

The existing `tests/integration/antigravity-parallel-tool-roundtrip-http.test.ts` exercises the
production chat route handler behind local HTTP client and mock-upstream servers. It seeds separate
synthetic Antigravity CLI and IDE connections, authenticates requests with a test API key, fragments
upstream SSE frames, and verifies stable provider sessions and thought signatures across a client
tool call/result round-trip. It runs phases at 1, 30, 70, and 100 simultaneous conversations; each
conversation makes two completion requests. Half of the conversations use streaming responses.

On Maria on 2026-10-08, the test passed all 402 completion requests across the four phases in 22.2s;
`/usr/bin/time -v` measured 747,028 KiB maximum RSS for the test process hosting the gateway route.
The mock upstream and load client run as separate child processes and are not included in that
process's RSS. With `RUN_ANTIGRAVITY_CAPTURE_BENCH=1`, it enables detailed call logs,
stream chunks, 10 MiB per-artifact allowance, and 4 MiB client text retention. That variant passed
all 402 requests in 24.2s, persisted 402/402 call-log artifacts, and read back provider/client stream
chunks from a completed artifact. Peak RSS was 763,068 KiB. The test intentionally covers synthetic
responses and does not execute Prime's actual tools; it calls the production route handler directly
and does not pass through `src/proxy.ts`/Next middleware or the standalone server. It also disables
compression and turns off `noLog` only in capture mode. This closes the provider tool-roundtrip and
capture gap for the route handler, but the complete Prime/Next/container E2E remains open.

A memory-sampled retest after the artifact-queue change completed in 20.97s and persisted all
402/402 artifacts with provider and client stream channels. The gateway test process reached
787,755,008 bytes (751.1 MiB) high-water RSS; sampled peak V8 heap-used was 382,052,728 bytes
(364.4 MiB). The fixture client and mock provider were separate processes and measured about
107.5 MiB and 66.8 MiB high-water RSS. The test's user-session cgroup sample is shared with other
processes and is not attributable to OmniRoute. A 128-job count ceiling had dropped small artifacts
during this burst even though the weighted memory reservations had room; it is now 1,024 jobs while
the independent 128 MiB weighted reservation limit remains in force. The call-log shutdown drain
default is 30 seconds to cover a cold worker start plus a write burst.

On 2026-10-09, seven focused Antigravity error-path suites passed 40/40 tests: quota-versus-rate-limit
classification and cooldowns, switch-auth retry behavior, sanitized attempt diagnostics, streaming
error-body handling, and the system-instruction regression. These verify local classification and
fallback branches against fixtures; they do not establish Google quota availability or eliminate
network/header timeouts. The reported production logs still show upstream 429 responses on several
accounts and 30-second no-header timeouts, so a matched real-provider trace remains necessary to
separate quota exhaustion from transport failure.

Three additional `ProxyFetch` timeout/retry suites passed 7/7 tests on 2026-10-09. They verify that
time spent waiting for transport admission does not consume the response-header deadline, a pooled
dispatcher response-start timeout retries once with a fresh no-keep-alive dispatcher, a second stall
surfaces instead of falling through to native fetch, and a transient socket failure uses the fresh
dispatcher. The timers/upstreams are controlled local fixtures; these tests do not establish that a
real Google or OpenAI upstream will answer before the configured timeout.

Run the capture variant with:

```bash
RUN_ANTIGRAVITY_CAPTURE_BENCH=1 DISABLE_SQLITE_AUTO_BACKUP=true \
  node --max-old-space-size=2048 --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-concurrency=1 \
  tests/integration/antigravity-parallel-tool-roundtrip-http.test.ts
```

A slower single trial used 300 chunks per response (3 seconds of streamed body time) at 100
sessions, with the same 1.31 MB (1.25 MiB) maximum request and five turns per session. It completed 500/500
requests without errors in 22.4 seconds. First-body p95 was 3.07 seconds and completion p95 was
6.22 seconds because waiters joined as stream leases became available. Peak in-flight charge was
73.21 MB (69.82 MiB), queued reservations peaked at 19.92 MB (18.99 MiB), and all counters returned
to zero. This is one trial; it shows queue drainage for this stream duration, not a sustained
throughput guarantee.

This confirms the admission queue waits and drains under this local workload; it is not 100 full
agent sessions and does not include actual provider routing, tool execution, account scheduling,
database activity, or persistent call-log artifact writes. It also does not claim that 63.7 requests/s
is a production ceiling or that an upstream provider will accept the same burst. Those full-server
and real-provider checks remain necessary before treating 70–100 agents as validated capacity.

### High-context request capture at 100 sessions

The route-level harness now runs the synthetic client and mock provider in separate Node processes.
The test gateway streams the incoming HTTP body directly into `route.POST()` and counts bytes as
they pass, so it does not parse and reserialize a second request copy. With
`ANTIGRAVITY_CAPTURE_CONTEXT_BYTES=262144`, each request carries five user-context strings and
is about 1.31 MB (1.25 MiB). The four phases send 402 chat requests across 1, 30, 70, and 100 sessions;
each session performs a tool-call and tool-result round trip.

With ordinary detailed call-log artifacts only, all 402 summary rows were saved and every response
succeeded, but only 115/402 detailed artifacts were retained. The writer logged
`aggregate_reservation_budget` refusals after reserving 125.9 MiB of its 128 MiB cap; each preparation
was conservatively estimated at 31.5 MiB. The test process did not receive a pressure 503 in that
run. This is a measured diagnostic-detail loss under large concurrent calls, despite successful
inference.

Capturing those full artifacts alongside private overflow traces crossed the test process's local
V8 heap guard at about 1,908 MiB used against a 1,904 MiB threshold. Host memory remained available
and PSI was zero. That run duplicated large client/provider bodies in the ordinary artifact pipeline
while also writing private traces.

The `diagnosticOverflowOnly` Antigravity path now keeps bounded stream chunks, transport telemetry,
and safe request metadata in the call-log artifact while leaving full bodies in the private trace.
It passes the admitted client bytes directly into the private writer and avoids reparsing the
serialized Antigravity provider request into another retained JSON object. If the private trace
cannot be persisted, the logger falls back to ordinary detailed capture. Codex and other providers
continue using their existing call-log pipeline.

With private overflow enabled, the 100-session, 1.31 MB (1.25 MiB) run passed all 402 requests, retained
402/402 call-log artifacts, and finalized 402/402 private traces with complete client request,
provider request, and provider response files. A sample trace contained 1,311,457 client bytes and
a 326-byte provider response. The run produced no `resource_pressure` rejection; reported maximum RSS
was 2,674,104 KiB with a 2 GiB V8 heap limit. The isolated run generated 1,910,136 KiB of filesystem
writes, then removed its temporary data directory; free root disk remained about 20 GiB. Full
private capture can create substantial write traffic, so scope it to the diagnostic window and keep
the configured aggregate-size budget and retention policy in view.

Five verification reruns after the schema-9 text-dedup change passed all 402 requests and finalized
402/402 traces each. All ordinary artifacts were metadata-only (`full=0`, `privateOnly=402`); the
private traces held the request and response bytes. Each run measured a 1,311,796-byte maximum
request and completed in 82.42–83.24 seconds wall time, with peak RSS ranging from 2,624,508 to
2,811,080 KiB and filesystem output ranging from 1,909,536 to 1,911,176 KiB before cleanup. The
text-table scan optimizations did not materially change end-to-end wall time or RSS in this route
test; that points to request parsing, private gzip capture, and disk writes dominating its cost. This
corpus uses high-entropy random context, five 256 KiB user messages per session, and 1.31 MB (1.25 MiB)
requests; its timing should not be compared directly with the earlier 22–24 second low-context
runs. It validates the 100-session route/capture path, not sustained production throughput or a real
provider.

A fresh 2026-10-09 verification with the same capture flags also passed 402/402 requests, persisted
402/402 metadata-only call-log artifacts, and finalized 402/402 private traces. The maximum request
was 1,311,796 bytes and wall time was 82.998 seconds. `/usr/bin/time` measured 1,590,332 KiB
maximum process RSS; the final gateway snapshot reported 1,476,325,376 bytes RSS, 783,805,368 bytes
V8 heap used, 245,577,440 external bytes, 216,594,746 array-buffer bytes, and zero process swap.
The snapshot's shared user-session cgroup had `memory.max=max`, 11,078,463,488 bytes current and
zero max/OOM events; its aggregate memory and prior peak are not attributable to the gateway. PSI
averages were zero. This one run is lower than the earlier process-RSS range, but without matched
before/after runs it does not establish which source change caused the difference.

### Bun direct-route comparison at 100 sessions

The official [Bun v1.4.2 ARM64 release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2)
binary was checksum-verified and run from a temporary directory. The benchmark executes the same
production Antigravity chat route and synthetic 1/30/70/100-conversation tool-call workload as the
Node test; it keeps the load client and mock upstream on Node 24.21.0 so only the gateway runtime
changes. All runs use five high-entropy 256 KiB user-context strings per conversation and 1,311,796
byte maximum requests. This is a route-handler test, not Next middleware, a standalone image, or a
real provider/Prime session.

| Gateway runtime | Capture mode                             | Requests | Test wall time | Gateway process high-water RSS | Capture result                |
| --------------- | ---------------------------------------- | -------: | -------------: | -----------------------------: | ----------------------------- |
| Node 24.21.0    | logs off                                 |  402/402 |         61.5 s |     1,692,942,336 B (1.58 GiB) | No request artifacts expected |
| Bun 1.4.2       | logs off                                 |  402/402 |         48.3 s |     2,943,635,456 B (2.74 GiB) | No request artifacts expected |
| Node 24.21.0    | private overflow, 2 GiB total budget     |  402/402 |         75.9 s |     1,604,333,568 B (1.49 GiB) | 402/402 traces complete       |
| Bun 1.4.2       | private overflow, 2 GiB total budget     |  402/402 |         59.9 s |     3,052,023,808 B (2.84 GiB) | 390/402 traces persisted      |
| Bun 1.4.2       | private overflow, 4 GiB test-only budget |  402/402 |         60.7 s |     3,052,023,808 B (2.84 GiB) | 402/402 traces complete       |

The timed Bun process peaked at 2,980,492 KiB during private capture. Its final sample showed
1,742,401,536 bytes RSS and 831,579,368 bytes external memory. Node's matching private-capture
sample showed 1,580,822,528 bytes RSS and 303,771,499 bytes external memory. Bun completed the
mock workload sooner but its Linux process high-water was about 1.9 times Node's in the private
capture run; its no-log high-water was about 1.7 times Node's. These measurements do not prove a
general runtime ranking, but this workload does not support adopting Bun for lower peak memory.

The first Bun run returned a false local 503 after the module-cached heap threshold remained at
990 MiB while Bun's `node:v8` compatibility layer reported a live limit of about 19.6 GiB, process
RSS near 1.7 GiB, and no cgroup memory cap or PSI pressure. The heap guard now uses Bun's
`process.constrainedMemory()` ceiling (cgroup when available, host RAM otherwise), while Node
continues using its V8 heap limit. Node and Bun unit checks pass, and the matched 100-session Bun
reruns after this change produced no local pressure 503s. This does not yet verify the policy with
Bun inside the production 4 GiB app-container limit. A separate isolated
`systemd-run --user --scope --property=MemoryMax=4G` probe on the verified Bun binary returned
`process.constrainedMemory() = 4,294,967,296` while `os.totalmem()` remained 25,137,336,320 bytes;
that confirms Bun exposes the temporary cgroup limit to the new threshold calculation.

At the existing 2 GiB private-overflow aggregate budget, the Bun run persisted 390 of 402 trace
references; the unpersisted traces coincided with the aggregate storage budget. A temporary 4 GiB
budget for the isolated test persisted all 402 client/provider traces and was removed with its temp
data directory. The successful run totaled 1,054,961,321 raw payload bytes and 1,053,107,174
compressed bytes across those trace files. Those totals exclude the coordination database and the
larger in-flight reservations, so they do not describe the exact peak-budget requirement. The
application default remains 2 GiB. The normal artifact writer also keeps its
separate 128 MiB in-memory reservation cap; high-context ordinary details can be refused while
inference succeeds. The metadata-pointer queue is now bounded at 1,024 jobs and 16 MiB, with a
402-stub unit test. When a private trace cannot be persisted, its safe reason is now written into
the call-log summary so the missing detail is diagnosable. A 2 GiB miss is therefore visible as an
incomplete capture, not a provider failure. Do not treat this synthetic burst as a recommendation
to raise the production disk budget automatically.

The Bun benchmark keeps the route gateway on Bun while running the client and mock upstream with
Node, using `ANTIGRAVITY_FIXTURE_RUNTIME` so the load generator does not confound the gateway
comparison. The Bun test binary's SHA256 was checked against the official ARM64 v1.4.2 release:
`54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7`. Reproduce the full private
capture variant on an isolated temp data directory with:

```bash
ANTIGRAVITY_FIXTURE_RUNTIME="$(command -v node)" \
RUN_ANTIGRAVITY_CAPTURE_BENCH=1 \
ANTIGRAVITY_CAPTURE_OVERFLOW_BENCH=1 \
ANTIGRAVITY_CAPTURE_CONTEXT_BYTES=262144 \
ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS=120000 \
ANTIGRAVITY_CAPTURE_MEMORY_BENCH=1 \
OMNI_DIAGNOSTIC_OVERFLOW_TOTAL_BYTES=4294967296 \
DISABLE_SQLITE_AUTO_BACKUP=true \
bun test --timeout=600000 tests/integration/antigravity-parallel-tool-roundtrip-http.test.ts
```

The 4 GiB environment override is only for this temporary benchmark. The default 2 GiB run's
missing traces and the no-cgroup Bun threshold fallback still need a decision before a production
Bun configuration can be considered.

`ANTIGRAVITY_CAPTURE_MEMORY_BENCH=1` emits a sanitized memory-diagnostics record with separate
snapshots for the route/test process, parent test runner, client process, mock upstream, and their
current cgroup-v2 scope. Process snapshots include Node heap/RSS/external/array-buffer values, V8
heap statistics, `/proc` high-water RSS, and `smaps_rollup` PSS/private/shared pages. The cgroup
snapshot includes current/peak/max, memory.stat, events, and pressure. A user-session cgroup may also
include sibling processes and charged page cache; use its membership and stat breakdown before
attributing the aggregate to the gateway.

In the memory-enabled rerun, the route/test process's post-load snapshot showed 2,617,737,216 bytes
RSS, 1,819,397,456 bytes of V8 heap used against a 2,348,810,240-byte heap limit, 235,918,720 bytes
external memory, and 206,936,034 array-buffer bytes. Its process high-water RSS was 2,707,226,624
bytes (2,643,776 KiB), `smaps_rollup` PSS was 2,586,703,872 bytes, and private dirty pages were
2,549,506,048 bytes; process swap was zero. It accumulated 105.36 seconds of user CPU and 10.13
seconds of system CPU. Across the two memory-enabled runs, the synthetic client peaked at 570–584
MiB RSS and mock upstream at 191–198 MiB. At that request-completion sample, before artifact/trace drain, V8 heap use was
about 91% of the 1,904 MiB immediate-shed threshold, below it; no `resource_pressure` rejection
occurred. The one-second sampler collected 61 points over 74.57 seconds and observed peak V8
`heapUsed` of 1,853,346,912 bytes (1,767.5 MiB, 92.8% of the threshold) at 71.6 seconds, about
136.5 MiB below the 503 threshold. At the same sample it recorded
peak RSS 2,699,513,856 bytes (2,574.5 MiB), external memory 397,431,525 bytes (379 MiB), and
array-buffer memory 357,986,324 bytes (341.4 MiB). External and array-buffer use then fell before
the end snapshot, so that transient buffering is visible in RSS but not as retained V8 heap. The
10.29 GiB cgroup current sample had
2.77 GiB anon, 5.81 GiB file, and 1.71 GiB kernel charge; events showed no high/max/OOM, and PSI
averages were zero. That cgroup was the shared user-session scope (`memory.max=max`), and its
14.41 GiB `memory.peak` predates this test's peak; neither aggregate value can be attributed to the
OmniRoute route process. The interval sampler is best-effort and can miss brief event-loop stalls;
process `VmHWM`/`resourceUsage.maxRSS` supplies the process-wide high-water, while heapUsed peaks are
sampled rather than exact allocation maxima. This profile narrows the memory mix but does not identify
retained object types; a heap allocation profile remains necessary.

An allocation-profile A/B with the same 402-request, private-capture workload found two redundant
body copies. Before the fix, V8's sampled allocation profile attributed 507,618,872 bytes to
`payloadRules.cloneValue()`/`structuredClone()` and 274,261,024 bytes to
`providerRequestLogging.parseBody()` on bodies already prepared by the executor. The rules config in
this harness is empty; the fast path also skips cloning when configured rules do not match the
current model/protocol. The provider body had already been logged by the Antigravity executor. After
the fix, both stacks were absent from the profile: empty or nonmatching payload rules return the
input to the immutable target-sanitization boundary, and the fetch observer recognizes a prepared
private-overflow body by its SHA-256 fingerprint before parsing it again. The profile's total sampled
self-allocation fell from 1,747,920,736 bytes to 681,827,696 bytes (61.0%); the undici client-body
`parseJSONFromBytes` stack remained about 525 MB, as the gateway still must parse each incoming JSON
request once. Sampled V8 heap peak fell from 1,852.5 MiB to 868.3 MiB; process max RSS fell from
2,678,464 KiB to 1,717,500 KiB. Both A/B runs passed all 402 requests and finalized 402 private
traces. Their wall times were 84.59s and 83.11s, so the measured gain is lower allocation and memory,
not a material latency change. Heap-prof sampling totals are allocation volume, not retained heap;
the matched flags and request corpus make the before/after comparison more useful than a language
benchmark, but this is still a local mock-provider route test.

The Logs detail modal reads the trace manifest and exposes downloads for the compressed client
request and each provider request/response, including partial-state labels. This makes the private
payloads reachable from the call-log row while keeping them out of the ordinary artifact.

The private-capture test sets `OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES` to 1 MiB for this
1.31 MB (1.25 MiB) request corpus. Its normal production default is 4 MiB, so an operator investigating
requests of this size must lower the threshold and enable private overflow. The diagnostic store
defaults to a 2 GiB aggregate budget and seven-day retention; do not interpret the 10 MiB call-artifact
limit as that private-store budget.

Reproduce this specific capture check with:

```bash
RUN_ANTIGRAVITY_CAPTURE_BENCH=1 \
ANTIGRAVITY_CAPTURE_OVERFLOW_BENCH=1 \
ANTIGRAVITY_CAPTURE_CONTEXT_BYTES=262144 \
ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS=120000 \
ANTIGRAVITY_CAPTURE_MEMORY_BENCH=1 \
DISABLE_SQLITE_AUTO_BACKUP=true \
node --max-old-space-size=2048 --import tsx/esm \
  --import ./open-sse/utils/setupPolyfill.ts \
  --import ./tests/_setup/isolateDataDir.ts \
  --test --test-concurrency=1 \
  tests/integration/antigravity-parallel-tool-roundtrip-http.test.ts
```

The test enables private overflow in its isolated `DATA_DIR` and removes that directory during
teardown. It uses a fake Antigravity upstream, separate CLI/IDE connection profiles, and one
synthetic tool round trip. It does not run Next middleware/standalone image code, execute a real
tool, or verify real provider quota behavior; it is not a production 100-agent capacity claim.

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
JSON. The save path now drops its own top-level request/response reference when the bounded client
snapshot is exactly equal, before queue reservation and protection; the original parsed request and
the logger's bounded snapshot can still be live elsewhere in the request handler.

Schema 7 extends that exact-value compaction to repeated `pipeline.openaiRequest.body`,
`pipeline.providerRequest.body`, and `pipeline.providerResponse.body` values. The on-disk file keeps
one body and stores references for identical stages; `readCallArtifact()` expands them back to the
original object layout. No substring, approximate, or lossy text deduplication occurs. A synthetic
100 KiB request and 30 KiB response duplicated across client/OpenAI/provider stages saved more than
300 KiB, and a separate cap test confirms that fallback artifacts do not retain references after
their body-bearing pipeline is omitted. The focused artifact-cap/worker/drain suites passed 28/28.

The request logger reuses identical bounded body snapshots across client/OpenAI/provider request
stages and provider/client response stages. Schema 8 stores repeated exact stream-chunk text once in a
per-artifact dictionary with integer references; `readCallArtifact()` expands it before returning
data, so the UI, API, exports, and continuation logic still receive the original string arrays. The
reservation estimator uses this compact representation too. This is lossless text deduplication; it
does not remove distinct prompt or response text.

Schema 9 interns repeated exact string values from 256 to 65,536 UTF-16 code units across request,
response, and pipeline payloads in a nonce-protected per-artifact dictionary. Longer strings are
left alone so unique high-context prompt values do not need to be hashed. It compacts the ordinary
call-log JSON artifact only; private overflow files continue storing their exact bytes under the
separate gzip and aggregate-budget controls. The writer keeps the original representation unless the
complete serialized JSON becomes smaller, and the reader expands the table before any call-log API
or UI consumer sees it. Stream chunks continue to use their own encoding, and no table is shared
across API keys or requests. On 100 synthetic artifacts already compacted for duplicate stage
bodies, the extra text table reduced serialized size from 13,063,780 bytes to 1,782,080 bytes
(86.36%). A fresh 2026-10-09 rerun measured a transform median of 0.165 ms and p95 of 0.234 ms
per artifact on this host. A separate 100-artifact check with five unique 256 KiB context strings
per artifact made no representation changes; its median scan was 0.019 ms and p95 was 0.052 ms.
Re-run with `npm run bench:call-log-text-dedup`. These are sequential synthetic microbenchmarks.
They measure disk representation and the dedup scan, not request heap reduction or real-prompt
compression. A separate complete `writeCallArtifact()` sweep of 100 synthetic artifacts stored
1,847,880 bytes instead of 50,537,450 bytes (96.34%); the fresh run measured median write time of
0.491 ms and p95 of 1.274 ms. That comparison includes the existing request/response stage
references as well as the new text table, so it must not be attributed to the new table alone. The
dictionaries are local to each artifact: cross-request blob sharing remains unimplemented,
avoiding shared ownership, retention-reference, and cross-key deduplication concerns.

The optional exact-text pass fails open when it sees accessors, unsupported object graphs, more than
100,000 visited values, arrays longer than 100,000 entries, more than 4,096 unique candidate strings,
over 8 Mi UTF-16 code units of 256–65,536-unit candidate text, or a JSON-escaped dictionary over
4 MiB. The reader rejects table expansions over 100,000 values or 16 Mi UTF-16 code units. That is
an in-memory character-count limit, not a serialized JSON-byte ceiling: escaped control characters
can take up to six bytes per code unit. The normal artifact writer separately enforces its configured
serialized-size cap. This bounds hash/transform work and protects against compact files expanding
into very large in-memory objects; tests cover custom-prototype objects, 100-million-slot sparse and
100,001-element dense arrays, non-enumerable array-index round-tripping, a wide plain object, the
candidate/dictionary/expansion budgets, and a pipeline accessor. Artifacts outside these limits use
the existing size-limit path, so this optimization can reduce detail retention under extreme/high-
cardinality payloads. Private overflow captures are separate and retain exact bytes subject to their
own limits.

Structured `error`/`fatal` repeat suppression is a different mechanism. It scopes the 5-second
deduplication key to severity and component, does not retain messages over 4,096 characters, expires
stale keys on each error call, caps the key map at 500, and carries duplicate/rate-limit counts as
`logSuppression` metadata on the next emitted error. If no later error is emitted, those in-memory
counts do not reach disk. `CHAT_DEBUG_FILE=true` and `APP_LOG_LEVEL=debug` intentionally bypass the
artifact text table and artifact-size cap to write pretty, untruncated JSON; keep that forensic mode
short-lived because its disk and serialization costs are not bounded by the normal artifact budget.

The writer-capacity harness exercises production `saveCallLog()` and the artifact worker against a
temporary SQLite database: 100 simultaneous saves, 100 synthetic chunks on each of three stream
tracks, and a 10 MiB per-artifact cap. Imports and temporary-database initialization are reported as
`setupMs` outside the timed save phase; first artifact-worker startup remains inside the timed phase.
Reproduce with
`node --import tsx/esm scripts/perf/bench-call-log-artifact-capacity.mjs 100 262144` or
`bun scripts/perf/bench-call-log-artifact-capacity.mjs 100 262144`; replace `262144` with `1311987`
for the larger-request case. Each configuration ran three times. Values below are medians; RSS is
sampled every 10 ms during the concurrent save phase. The benchmark reports temporary-database and
module setup separately as `setupMs`; process high-water RSS is also included in each JSON result.

| Runtime      | Target request bytes | Detailed artifacts ready | Summary rows retained | Median save time | Median load peak RSS | Artifact bytes written |
| ------------ | -------------------: | -----------------------: | --------------------: | ---------------: | -------------------: | ---------------------: |
| Node 24.21.0 |              262,144 |                   23/100 |               100/100 |           711 ms |            246.4 MiB |                6.52 MB |
| Bun 1.4.0    |              262,144 |                   23/100 |               100/100 |           392 ms |            148.9 MiB |                6.52 MB |
| Node 24.21.0 |            1,311,987 |                    5/100 |               100/100 |           587 ms |            464.6 MiB |                6.67 MB |
| Bun 1.4.0    |            1,311,987 |                    5/100 |               100/100 |           412 ms |            168.9 MiB |                6.67 MB |

The chunk-text dictionary increased successful detail capture from 20 to 23 per 100 at 262 KiB,
and from 4 to 5 per 100 at 1.31 MB (1.25 MiB), compared with the same harness before text compaction. All
summary rows remained. The other details were refused by the existing 128 MiB aggregate reservation
guard, so this still does **not** validate full capture for 70–100 large concurrent requests. Node
uses `better-sqlite3`; Bun uses `bun:sqlite`, so the writer timings compare both runtime and SQLite
driver. This excludes Next routes, authentication, account routing, provider execution, and tool
cycles. The Bun result is not evidence that the full Next app is ready to run on Bun; the production
image runs Node 26.10.0 and this harness uses Node 24.21.0.

## Request-logger lifecycle stress

The writer-only benchmark above starts from an already-built log payload. A second harness now
creates the production `RequestLogger`, records client/OpenAI/provider request and response stages,
appends 100 chunks to each stream track, and calls production `saveCallLog()` concurrently. This
includes the logger's default 64 KiB text-preview limit, protected snapshots, request-summary rows,
reservation estimator, SQLite writes, and artifact worker. Reproduce with
`node --import tsx/esm scripts/perf/bench-call-log-lifecycle.mjs 100 262144 65536` or
`bun scripts/perf/bench-call-log-lifecycle.mjs 100 262144 65536`; replace `262144` with `1311987`
for the larger request shape. The byte argument is an approximate JSON body target; the JSON
envelope and per-session label add a small amount. `setupMs` separates imports and temporary SQLite
migrations from the timed save phase, while peak RSS is sampled every 10 ms during concurrent saves.
The script accepts separate stage and client text limits; omitting the fourth argument makes the
client limit equal the stage limit. Reproduce the candidate's mixed 64 KiB/4 MiB profile with
`node --import tsx/esm scripts/perf/bench-call-log-lifecycle.mjs 100 1311987 65536 4194304` or
the same command under Bun; use `100 1311987 1311987 1311987` to align both limits with the body.
Each runtime/size ran three times.

| Runtime      | Target request bytes | Detailed artifacts ready | Summary rows retained | Median save time | Median load peak RSS | Artifact bytes written |
| ------------ | -------------------: | -----------------------: | --------------------: | ---------------: | -------------------: | ---------------------: |
| Node 24.21.0 |              262,144 |                   18/100 |               100/100 |           798 ms |            304.4 MiB |                6.32 MB |
| Bun 1.4.0    |              262,144 |                   18/100 |               100/100 |           469 ms |            242.5 MiB |                6.32 MB |
| Node 24.21.0 |            1,311,987 |                    4/100 |               100/100 |           682 ms |            548.2 MiB |                5.60 MB |
| Bun 1.4.0    |            1,311,987 |                    4/100 |               100/100 |           477 ms |            477.2 MiB |                5.60 MB |

At both request sizes, the existing 128 MiB aggregate reservation budget kept every summary row
but omitted most detailed artifacts. The full logger path retained fewer artifacts and used more
RSS than the writer-only path, which means that writer-only throughput is not a reliable estimate
for OmniRoute's in-flight logging cost. Bun's lower time/RSS here is confounded by its `bun:sqlite`
driver versus Node's `better-sqlite3`. The harness still omits Next routing/authentication, provider
execution, account scheduling, actual tool cycles, and real upstream streams; it does **not** prove
70–100-agent end-to-end capacity.

The running candidate uses a mixed preview profile: `CHAT_LOG_CLIENT_TEXT_LIMIT=4194304` with
`CHAT_LOG_TEXT_LIMIT` unset, which leaves stage previews at 64 KiB. The lifecycle harness compared a
1.31 MB (1.25 MiB) synthetic request under that profile, the 64/64 KiB defaults, and aligned stage/client
limits matching the body. The per-artifact cap and concurrency stayed the same:

| Runtime      | Stage text limit | Client text limit | Detailed artifacts ready | Median save time | Median load peak RSS | Artifact bytes written |
| ------------ | ---------------: | ----------------: | -----------------------: | ---------------: | -------------------: | ---------------------: |
| Node 24.21.0 |           65,536 |            65,536 |                    4/100 |           682 ms |            548.2 MiB |                5.60 MB |
| Bun 1.4.0    |           65,536 |            65,536 |                    4/100 |           477 ms |            477.2 MiB |                5.60 MB |
| Node 24.21.0 |           65,536 |         4,194,304 |                    4/100 |           715 ms |            514.8 MiB |                5.87 MB |
| Bun 1.4.0    |           65,536 |         4,194,304 |                    4/100 |           499 ms |            441.8 MiB |                5.87 MB |
| Node 24.21.0 |        1,311,987 |         1,311,987 |                    5/100 |           641 ms |            389.2 MiB |                6.68 MB |
| Bun 1.4.0    |        1,311,987 |         1,311,987 |                    5/100 |           403 ms |            305.5 MiB |                6.68 MB |

At this synthetic body size, the mixed candidate profile used less sampled RSS than 64/64 KiB,
while matching both stage and client limits to the full body reduced it further and retained one
more artifact per 100 saves. This matches the source path: when the client snapshot equals the raw
request, `saveCallLog` can reuse one body rather than protecting both copies. It is an inference from
the copy checks and synthetic benchmark, not a production-route result. The aligned profile also
stores more prompt text in stage previews; the 1.31 MB (1.25 MiB) body is much smaller than an 872K-token
request. No default change is justified before testing provider transformations, privacy, and heap
behavior with real-sized traffic.

## Private diagnostic-overflow concurrency probe

`scripts/perf/bench-diagnostic-overflow-concurrency.mjs` exercises the production private-overflow
trace, request logger, provider fetch observer, stream reader, gzip writers, and WAL budget accounting
with a mocked Codex HTTP provider. It runs 100 independent requests with 4 MiB JSON bodies and
64 KiB response streams, holds all 100 streams active together, and compares overflow disabled with
overflow enabled. The payload uses base64-encoded random bytes to avoid the unrealistically high gzip
ratio of repeated filler text. The 4 MiB size matches the default capture threshold; the benchmark
uses a fresh, private temporary data directory and removes it at exit. Reproduce with:

```bash
OMNI_DIAGNOSTIC_OVERFLOW_ENABLED=false node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts scripts/perf/bench-diagnostic-overflow-concurrency.mjs 100 4194304 65536
OMNI_DIAGNOSTIC_OVERFLOW_ENABLED=true node --import tsx/esm --import ./open-sse/utils/setupPolyfill.ts scripts/perf/bench-diagnostic-overflow-concurrency.mjs 100 4194304 65536
```

One paired trial measured:

| Capture | 100 response headers, p50 / p95 | Client completion, p50 / p95 |  Peak RSS | Capture tail after responses | Private files |
| ------- | ------------------------------: | ---------------------------: | --------: | ---------------------------: | ------------: |
| Off     |                   1.66 / 2.41 s |                1.76 / 2.52 s | 1,353 MiB |                         0 ms |             0 |
| On      |                   1.99 / 2.78 s |                2.16 / 2.96 s | 1,462 MiB |                      12.35 s |      642.8 MB |

Across three capture-enabled repeats, p95 response-header latency stayed between 2.75 and 2.80 s,
median completion between 2.14 and 2.18 s, and all 100 traces completed. In the representative run,
enabled capture added about 0.4 s to median completion and 109 MiB to peak RSS. Responses finished
about 12.35 s before the background writers had sealed all traces. That run wrote about 806 MiB of
raw client/provider/response data and 642.8 MB of compressed files. The diagnostic metadata database
uses SQLite WAL with `synchronous=NORMAL` because it is disposable diagnostic state. SQLite documents
that this mode preserves WAL consistency but may roll back a recent transaction after a power loss;
payload files are individually fsynced before being marked complete, and startup cleanup removes only
aged, UUID-shaped orphan directories containing owned capture filenames. A held-fsync regression
test verifies that the client reaches EOF before background trace finalization completes.
[SQLite synchronous-mode details](https://www.sqlite.org/pragma.html#pragma_synchronous).

This is an isolated capture-path capacity test, not a 100-agent application E2E result: it has no
Next route/auth stack, account scheduling, provider quota, tool loop, real network, or Maria's 4 GiB
container cap. Full app/agent-cycle verification remains required.

## Build/runtime evaluation

Next.js 16 lists Node.js 20.9+ as its runtime requirement and makes Turbopack the default
production bundler. Turbopack's implementation is Rust, but that does not make the Next.js server a
Rust runtime or establish that Bun is a supported production runtime. Bun's current compatibility
guide says common frameworks including Next.js work, while also documenting gaps in Node-compatible
APIs: `AsyncLocalStorage` does not propagate into `MessagePort`/worker events, `node:worker_threads`
ignores `resourceLimits`, and `node:v8` reports JavaScriptCore heap statistics rather than V8
statistics. OmniRoute uses `AsyncLocalStorage` for transport/retry/request context, `worker_threads`
for call-log and compression workers, and `node:v8` in its pressure guard. Those behaviors require
direct parity tests before a Bun runtime can be considered for the full application. Sources:
[Next.js 16 runtime and Turbopack changes](https://nextjs.org/docs/app/guides/upgrading/version-16),
[Bun Node.js compatibility](https://bun.sh/docs/runtime/nodejs-compat), and
[Bun Workers](https://bun.sh/docs/runtime/workers).

A focused compatibility smoke on the installed Bun 1.4.0 ran four existing suites individually:
transport telemetry (13), request-logger endpoints (41), call-log payload deduplication (7), and
artifact-worker/queue behavior (11), for 72/72 passing tests. This exercises SSE cancellation,
redacted transport observations, shared body snapshots, SQLite-backed summary rows, a real worker
write, and 100 concurrent artifact preparations. A direct `AsyncLocalStorage.snapshot()` context
probe also passed under Bun. These results do not cover the full Next server, Bun heap-guard
semantics under deployed container limits, account routing, provider tools, or production traffic.
Bun's `node:test` implementation is documented as partial, so these focused runs are a compatibility
probe rather than an alternate CI test runner.

The production Node image's exact base digest (`node:26.10.0-trixie-slim`) passed native dependency
validation after `npm ci --include=optional --ignore-scripts` installed 2,529 packages in about 40
seconds (4.1 GiB of `node_modules`). Its Next.js 16.3.8/Turbopack build was run with two pinned CPUs,
one page-data worker, a 3 GiB V8 heap setting, and a 5 GiB container limit. After about 27 minutes,
the build process exited 137 while still in optimized compilation. The container had repeatedly
hit its memory cap; because the diagnostic container used `--rm`, its final cgroup counters were not
preserved. No usable standalone bundle was produced. The devvm recovered after the container exited.

A second Node build attempt used the current Dockerfile target, four CPUs, a 9 GiB container RAM cap,
12 GiB RAM-plus-swap, the configured 6 GiB V8 heap, and its one page-data worker. It reached Next's
optimized Turbopack compilation, but system memory available fell from 6.2 GiB to 1.8 GiB while swap
rose from 1.7 to 4.0 GiB over a 30-second sample. I interrupted it at that safety threshold; no
standalone output or image was produced. After the interruption, the devvm recovered to 8.7 GiB
available RAM. The host-only memory ceiling prevents a valid completed build comparison here.

For the next controlled Node build, use Next.js's `--experimental-debug-memory-usage` path on a
dedicated builder and preserve its periodic heap/GC output; the official guide says it can take heap
snapshots near the configured limit and respond to `SIGUSR2` with a snapshot. It is not compatible
with Next's Webpack build worker, so first reconcile that setting with this checkout's build config.
The stopped Bun trial above did not emit equivalent V8 data; Bun documents its `node:v8` statistics
as JavaScriptCore heap statistics. No heap snapshot was produced in these constrained build tests.
Sources: [Next.js memory guide](https://nextjs.org/docs/app/guides/memory-usage) and
[Bun Node.js compatibility](https://bun.sh/docs/runtime/nodejs-compat).

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

`Dockerfile.bun` did not previously set `CIRCLE_NODE_TOTAL`, so Next could derive its page-data
worker pool from all visible host CPUs. It now has a configurable `OMNIROUTE_BUILD_WORKERS` argument
defaulting to two (one Next page-data worker), matching the Node Dockerfile's bounded pool. A focused
static test protects that wiring; the full Bun build with this change still needs a larger builder.

The Bun base image has a `node` compatibility fallback but no `npm` executable. The package
`prebuild` hook originally invoked `npm run check:native-deps`, so the hook was changed to call the
Node script directly; the Bun builder then passed that hook and the docs sync check. The earlier
image test had no checked-in `bun.lock` and installed before copying `package-lock.json`, so that
test resolved ranges independently of npm's lock. The current blue branch now checks in a Bun lock,
copies it before dependency installation, uses frozen installs, and supports Bun 1.4.0 and 1.4.2.
Frozen-lock checks passed on both versions; an actual Bun 1.4.2 install completed 2,204 packages in
59.46 seconds. Bun still warns that it applies only one level of nested npm overrides, so the lock
file makes resolution repeatable but does not erase that compatibility limitation.

A later `Dockerfile.bun` debug-builder run used Bun 1.4.2, `workerThreads`, full Turbopack memory
eviction, a one-CPU `taskset` affinity, and an 8 GiB no-swap container limit. After 3m06s it was
still in optimized compilation. The highest sampled `podman stats` usage was 7.612 GB of the 8.59 GB
reported container limit; host available RAM had fallen from about 11 GiB to 3.9 GiB. The run was
deliberately stopped to protect active Prime workloads; the container exited 143 with
`OOMKilled=false` and produced no build output. Host available RAM recovered to about 11 GiB. This
is not a Bun runtime failure or a completed-build comparison: it shows that these settings did not
keep the compile peak low enough to safely finish on the shared devvm. `workerThreads` avoids the
separate `pool_entry` process tree seen with the default child-process strategy, but this trial does
not show a lower peak-memory result.

### Maria host build comparison

The current 4-vCPU/24-GiB Maria host was tested on 2026-10-08 with Node 26.10.0, Bun 1.4.0, and
Next.js 16.3.8. Each build container was limited to two CPUs and 14 GiB RAM, with swap disabled;
the host retained at least 7.8 GiB available RAM. The checked-out Node dependency tree was reused
(4.1 GiB); these were build-path measurements, not clean Docker image builds or `npm ci` timings.

The full Node/Turbopack build reached the optimized compile but the kernel killed its Next build
child after 7m29s at the 14-GiB cgroup limit. Kernel logs identify a memory-cgroup OOM kill; host
PSI remained low and host memory recovered after the container exited. The Next worker-count setting
was not applied on that direct invocation, but the process was killed during optimized compilation,
before page-data collection. The Bun 1.4.0/Turbopack run used the same npm-locked dependencies and
was stopped after 7m19s at 14.4 GB container usage when host-available memory crossed the 8-GiB
safety floor. It had not completed optimized compilation and had not emitted a Bun runtime error.
This isolates Bun execution from dependency resolution; it does not validate the separate
`Dockerfile.bun` install graph, which still lacks a checked-in Bun lockfile.

Webpack completed under the same 14-GiB/two-CPU ceiling. An initial direct build completed with three
page-data workers in 12m12s; a follow-up used `npm run build`, `CIRCLE_NODE_TOTAL=2` (one page-data
worker), Python/make/g++ for TPROXY, and the normal prebuild/postbuild hooks. On that warm-cache run,
Next reported a 4.3-minute successful compile, generated all 598 static pages with one worker, traced
the server, colocated the artifact and compression workers, and built the TPROXY addon. The complete
command took 7m45s including the container's apt install. The standalone output was 996 MiB, while
the complete `.build/next` tree was 7.0 GiB because it also retained a 5.8-GiB compiler cache; the
Node Dockerfile copies only `standalone`, not that cache. A temporary Node 26.10.0 runtime started
the bundle and returned HTTP 200 from `/api/health/ping`. Arena/OpenRouter/pricing/model syncs were
disabled for this smoke; it did not contact model providers.

This points to Turbopack's compile-time memory as a concrete limit on this host, rather than a
general inability to build the app. It does not yet establish that Webpack should replace Turbopack:
the Webpack success reused a warm cache, while the two Turbopack runs did not share the same cache
state, and a production image was not assembled or deployed. The Dockerfile's
`OMNIROUTE_BUILD_WORKERS=2` is translated to `CIRCLE_NODE_TOTAL=2`; direct local invocations must
set `CIRCLE_NODE_TOTAL` explicitly to match that worker budget.

A no-emit TypeScript check limited to the changed files still pulled in the broad `chat.ts` import
graph. Node spent about 3 minutes at 1.5–1.6 CPU cores and hit its default 4 GiB V8 heap limit;
there was no build artifact or typecheck result. This is separate from the earlier 5 GiB Next build
failures. A narrower follow-up that excluded `chat.ts` and included only the pressure/artifact modules
and their focused tests still reached a 3 GiB V8 heap limit and exited after about 74 seconds without
a result. Neither attempt reported a source diagnostic. The repository target
`npm run typecheck:core` has since passed after the call-log changes. The broad no-emit failures
still show that a full-project check needs a smaller dependency boundary or a builder with a larger,
explicitly budgeted heap; this target does not prove that the full Next application build fits the
current builder. The dashboard-scoped typecheck now passes within its frozen baseline of 206
pre-existing diagnostics; its two unbaselined provider-model ID errors were fixed by aligning the
no-auth catalog filter with the optional model ID shape.

## Remaining acceptance checks

- Query the new management-only pressure sample on `GET /api/monitoring/health` using a credential
  accepted by the candidate. Blue now exposes the configured immediate-heap threshold, V8 heap,
  process external/array-buffer/RSS, cgroup, host-PSI source, guard state, and sample age together.
  The current `~/.omni-mg` credential receives 403
  `Invalid management token` from `/api/usage/call-logs`, so the running candidate only returns
  public health. A heap snapshot or isolated allocation profile is still required to identify
  retained V8 objects.
- Fix the external candidate-image assembly so the artifact worker is present, then verify that
  pipeline artifacts are written and readable. The current image lost 118 detailed artifacts and
  no artifact file is newer than the image start; do not treat the `full-capture-v1` label as proof
  that capture works. The new tiny-stub fallback only links a private-overflow trace that was
  already captured; it cannot restore those missing historical artifacts.
- Reproduce heap growth from a clean start with capture on/off and optional subsystems isolated;
  test that the local pressure guard recovers without restarting after pressure clears. No heap
  snapshot or controlled recovery result exists yet.
- Build and smoke the production OCI image on a dedicated builder with enough memory and native
  overlay; Maria completed and smoke-tested the Node/Webpack standalone path, but no OCI image was
  assembled. Preserve `memory.peak`, `memory.events`, wall time, and output size for each next build;
  the full Turbopack runs on Maria did not complete under 14 GiB.
- TPROXY is a small first-party C Node-API addon in `src/mitm/tproxy/native/transparent.c`, not an
  installed package dependency. The upstream TPROXY notes say its `build/` and `prebuilds/`
  directories are ignored and the binary is built from source; the loader can probe a prebuild, but
  `buildTproxyNative()` currently always resolves the locked `node-gyp` and rebuilds on Linux. The C
  source uses `node_api.h`, and Node-API is ABI-stable across Node versions, but each OS/architecture
  still needs a matching binary ([upstream TPROXY notes](https://github.com/diegosouzapw/OmniRoute/wiki/MITM-Tproxy-Decrypt),
  [Node-API ABI guarantee](https://nodejs.org/download/release/v22.23.0/docs/api/n-api.html)). A
  future CI matrix can produce checksum-stamped `linux-x64` and `linux-arm64` prebuild artifacts,
  pin their N-API level, validate the ELF architecture and exports, then let the image builder copy
  the artifact and skip the C toolchain when present. This can remove a small native compile step;
  it is not expected to resolve the multi-minute Next/Turbopack build peak, and no isolated TPROXY
  build-time measurement has established its total contribution.
- Keep the passing `typecheck:core` target in the validation set. If a broader whole-app typecheck is
  required, first build a smaller project graph or use a builder with an explicit memory budget; the
  earlier broad no-emit attempts exhausted 4 GiB and 3 GiB without reporting source diagnostics.
- Complete production builds and runtime smokes for the locked `Dockerfile.bun` path on Bun 1.4.0
  and 1.4.2 using a dedicated builder; the current 1.4.2 Turbopack trial stopped at 3m06s for host
  memory safety before compilation completed. Record native-module, database, streaming, and
  shutdown differences. The Bun 1.4.2 direct route/tool/capture test now passes, but does not test
  the full Next server, production image, or 4 GiB cgroup behavior.
- Resolve the diagnostic-storage policy before relying on Bun high-context captures: the default
  2 GiB private-overflow budget left 12/402 Bun traces unpersisted, while the isolated 4 GiB run
  captured 402/402. The default is unchanged; decide whether a temporary 4 GiB diagnostic budget is
  acceptable only after checking image/container free space and retention cleanup.
- Exercise the full OmniRoute app with mock provider credentials at 70 and 100 active sessions,
  including actual tool-call cycles, authentication, account-level limits, and verified artifact
  capture through standalone Next and middleware. The direct route test now runs 1/30/70/100
  synthetic Antigravity conversations in both Node and Bun, but uses an in-process route handler,
  Node test fixtures, and mock upstream. The Rust policy prototype still has one static key and
  alias map but no database-backed policies.
- Compare the current TypeScript route, Bun/Turbopack candidate, Rust policy-aware prototype, and
  Bifrost only with equivalent authentication, model/account policy, request bodies, and provider
  mocks. The new Node/Bun rows compare one direct route handler; current Rust-vs-Rust rows isolate
  extra gateway stages. They do not rank production-ready applications or real providers.
- Before production routing, port and parity-test authentication, key revocation, connection/model
  selection, service strategies, quotas, caching, tool loops, errors, and usage accounting. Keep the
  frontend/control plane deployed independently from the inference process.
- Continue the OpenAPI handler audit beyond the 445 operations with success-response content; 556
  of 1,001 non-`204` success operations still lack explicit success-body schemas. Thirteen operations
  have no declared `2xx` status and 15 have only an intentional `204`. The path/method inventory
  covers 705/705 routes and 370 operations now declare security alternatives; remaining response
  schemas and conditional auth behavior have not all been source-verified.
