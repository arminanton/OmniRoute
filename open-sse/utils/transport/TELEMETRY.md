# Request transport observations

`transportTelemetry.ts` owns one bounded ledger per ingress logical retry budget.
The ledger uses a shared-global AsyncLocalStorage so bundled module copies share
one request context. Each generation fetch invocation gets an attempt record;
control-plane calls are excluded. An invocation can fail while queued before any
send, and dispatch observations never establish upstream acceptance or replay safety.
Existing replay policy remains authoritative.

| Path                     | Observations                                                                                                                                                                         | Limits                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| HTTP via Undici          | Actual handler queue/request-start, optional body-sent bytes/request-sent callback, resolved response headers, owned response bytes, first complete SSE data event, EOF/error/cancel | DNS/TCP/TLS/reuse remain unknown; handler callbacks can be absent                                         |
| Verified TLS HTTP/2      | Separate bounded pool admission wait, same Undici callbacks and response tap                                                                                                         | ALPN/SETTINGS remain owned by the transport; no fabricated per-stream TCP timing                          |
| Native HTTP/TLS fallback | Fetch invocation, resolved headers, owned response bytes/event/closure                                                                                                               | Native fetch invocation is not labeled physical socket dispatch; upload and network phases remain unknown |
| Codex WebSocket          | Pool invocation/queue, actual connected vs reused callback, send invocation, raw frame byte counts, first encoded semantic event, completed/failed/cancelled                         | Connected includes native WebSocket handshake; not TCP-only duration. Upload completion is unknown        |

The existing coarse request phase is now `provider_wait`: it includes admission,
provider dispatch and waiting for headers. It is not a TCP/TLS connect duration.

All ledger numeric times are monotonic milliseconds relative to logical request entry.
`maxObservedIdleMs` measures gaps between observed body chunks/frames, not network
idle-timeout configuration or token latency. `firstEventMs` is an SSE data event
boundary or the native WebSocket semantic event callback, not first generated token.
`bytes` counts observed upstream body bytes (decoded by fetch) or raw WS frame UTF-8
bytes; `forwardedBytes` counts final downstream response bytes, so these need not
match. `requestSentMs` exists only when Undici actually calls its documented
request-body-fully-sent callback; `uploadMs` remains null because upload-start time
is unavailable. Error response bodies from foreign native Response implementations
are left untouched.

The ledger retains at most 24 attempt records plus fixed aggregate counters. SSE
inspection retains only a five-character field prefix; it never retains body text.
No URLs, account identifiers, headers, credentials, prompt contents, or arbitrary
error/cancellation strings enter the record. Terminal state is emitted once by the
pull-owned final response tap on EOF/cancel/read error, or before returning a bodyless
result / throwing before headers. The tap does not clone or speculatively pull.
The safe terminal sink is a structured `TRANSPORT_TELEMETRY` console line; operators
must retain the existing bounded container/journal log retention policy. It creates
no additional file. The random ledger ID correlates that line with the bounded
`transportTelemetry` snapshot captured through the existing requestLogger pipeline
artifact. Artifact snapshots can precede EOF; the terminal line is the final record.

Focused tests cover slow admission/dispatch, fragmented SSE with comments/CRLF,
unknown phases, EOF/cancel/error/no-prepull, native foreign error-body contracts,
bounds/redaction, awaited retry backoff and WS reuse. A disposable local TLS HTTP/2
server exercises the actual dispatcher and stream tap. These fixtures do not prove
native provider egress, real account rate limits, or production deployment readiness.
