---
title: Verified provider HTTP2 and lossless upload transport
---

## Candidate and activation boundary

The candidate adds a provider transport wrapper to the shared executor. It does
not enable capabilities for any installed account, change live configuration,
modify the separate next-release checkout, or deploy an image.

The operator can record verified endpoint capabilities under connection-owned
`providerSpecificData.upstreamTransport`:

```json
{
  "http2VerifiedOrigins": ["https://verified-provider.example"],
  "terminalEvents": ["response.completed", "response.failed", "response.incomplete"],
  "zstdVerifiedEndpoints": ["https://verified-provider.example/v1/responses"],
  "maxConcurrentRequests": 16,
  "maxQueuedRequests": 128,
  "queueTimeoutMs": 30000
}
```

These example URLs are placeholders, not entitled or supported vendor endpoints.
Empty/missing fields preserve the existing transport. HTTP2 generation requires
streaming plus both an exact verified origin and declared terminal protocol.
Zstd requires the exact verified endpoint. Application proxies, relays, existing
explicit dispatchers and active TLS fingerprint transport retain their original
contracts. The wrapper resolves the existing proxy/runtime policy and uses the
existing guarded fetcher; it does not bypass the outbound URL guard or add an
independent provider retry loop. This executor hook covers providers using the
shared BaseExecutor path; custom executor paths need their own reviewed wiring.

## HTTP2 ownership and compatibility

A reviewed direct-dispatcher factory negotiates HTTP2 with ALPN and retains
HTTP1 fallback. Undici applies remote SETTINGS; an additional bounded admission
queue caps application requests even if the peer increases its stream allowance.
Admission belongs to transport resource limits, separately from account quota,
available-capacity routing and logical retry/deadline ownership.

Transport permits survive headers and are released after body consumption,
error or cancellation. The number of cached pools is bounded. Queued work has
an abort signal and deadline. Connection GOAWAY retires the native session while
accepted streams drain; failed requests are surfaced to the existing retry owner.
One-shot uploads prevent dependency-level buffer replay from spending an unseen
generation attempt. No output-bearing failure authorizes a new POST.

The installed Undici8 connector defaults to offering HTTP2 when `allowH2` is
omitted. Ordinary direct and fresh retry factories now explicitly pin HTTP1,
restoring their documented intent. Existing relay factories retain their explicit
HTTP2 setting. This trades potential incidental multiplexing for predictable,
audited transport; verified origins can regain multiplexing through the new path.
Native fingerprint transport is unchanged.

Real loopback testing found that the pinned dependency can expose clean EOF after
an INTERNAL_ERROR reset following output. The candidate does not pretend that
Undici exposes the reset code. A bounded semantic SSE audit rejects EOF lacking
a declared terminal event, while preserving delivered chunks. Failure and
incomplete events remain terminal payloads, not successful generation results.
A non-SSE response requires a valid identity-encoding Content-Length and exact
received-byte count; otherwise the body fails honestly. Generic nonstreaming
requests do not opt into this generation transport.

## Lossless Zstandard uploads

Compression runs asynchronously with four bounded workers; queued compression is
abortable. It uses native Node support when available, skips small bodies and
insufficient savings, and preserves serialized JSON/tool bytes exactly. It sets
Content-Encoding and the compressed byte Content-Length. The default input bound
is 16 MiB and the hard ceiling is 128 MiB. Existing content coding is never overwritten.
Bodies exceeding the allowed expansion ratio retain their original representation,
without invented padding frames. Compression does not alter context windows,
token usage, cached-input accounting or the serialized body used by logs/signing.

[OpenAI production guidance](https://developers.openai.com/api/docs/guides/production-best-practices)
explicitly documents Zstd for public POST /v1/responses, maximum 128 MiB for both
representations and a 100x decompression limit. That scope is not a universal
claim about proxy, aggregator or other provider endpoints.
[Native Codex request construction](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs)
selects Zstd for enabled compression with Codex-backend authentication and the
OpenAI provider; its [HTTP body encoder](https://github.com/openai/codex/blob/main/codex-rs/http-client/src/request.rs)
compresses serialized JSON and sets the content coding. Client implementation is
support evidence, not an account-specific live-success test.

An optional low-level fallback helper allows exactly one uncompressed attempt
only after 415 plus an Accept-Encoding response excluding Zstd, with explicit
approval from a shared retry/deadline owner. The executor wrapper does not grant
that approval or perform an independent fallback: it sends one prepared attempt.
No 400/413/429 or output-bearing response is silently replayed.

Public Responses WebSocket permessage-deflate is separately documented in the
same OpenAI guide. It is not proof of the ChatGPT-backed WebSocket contract and
is not automatically enabled by this HTTP transport candidate.

## Verification

Real TLS loopback tests cover 100 parallel POST conversations on one negotiated
HTTP2 socket, peer SETTINGS 2, GOAWAY drain/reconnect without accepted-request
replay, reset after output, cancellation, H1-only ALPN compatibility, actual proxy
fallback, explicit H1-default versus verified H2 selection, terminal failure and
incomplete events, and REFUSED_STREAM attempt ownership. Ephemeral local TLS keys
are generated at test time and removed; certificate validation stays enabled.

Real HTTP upload tests decode large Unicode/tool JSON byte-for-byte, verify the
transmitted Content-Length, test encoding rejection with budget approval, preserve
ordinary errors and output, enforce expansion limits and exercise bounded admission.
Existing BaseExecutor URL/deadline and proxy-pool regressions are included. No
unauthenticated vendor probe, paid 100-request burst or live capability activation
is claimed by these loopback results.
