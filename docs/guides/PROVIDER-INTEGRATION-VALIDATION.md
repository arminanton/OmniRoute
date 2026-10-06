# Provider integration validation

This candidate is based on live revision `1327bd91554adde097f8b4d515a3af6ed1a308f0` in the independent green repository. Changes here do not change the active blue deployment. Prime's local-next repository remains independent and its uncommitted work is not imported.

## Failure investigation

The reported request `c35d7d4a-00e8-447e-bf92-a40f6c3df791` failed with upstream HTTP 429 at 2026-10-06 05:21:25 UTC after 6.649 seconds. Its stored pipeline was already replaced by a size-limit marker, so the exact upstream reason cannot be recovered from that artifact. Nearby requests also returned 429. A later 503 explicitly reported an upstream access-verification failure. Neither observation proves weekly quota exhaustion.

The Codex executor inspected the native response body before checking whether filtering was appropriate. Reading the body getter can disturb a native transport response before error parsing calls `text()`. Regression tests reproduce the loss of a JSON 429 explanation and pass after filtering is restricted to successful SSE responses. The shared streaming semaphore wrapper had the same body-getter ordering problem and is corrected too. The generic executor also retried Codex 429 responses twice at a fixed two-second interval without honoring Retry-After. Codex now leaves throttling retries to account orchestration, preventing a threefold burst amplification. Error parsing now understands ChatGPT `detail`; ordinary JSON client errors retain Retry-After. If early keepalive has already committed HTTP 200, errors must travel inside SSE and HTTP status/headers cannot be changed. Artifact fallback preserves bounded error diagnostics and selected non-secret headers, while omitting oversized request snapshots. Unknown token usage no longer produces a 100% compression savings badge.

## Native capture and capability evidence

Offline captures use synthetic prompts and credentials, isolated local servers, and network-disabled containers. They establish request shapes, not account entitlement or production throughput.

| Client                           | Verified evidence                                                             | Candidate behavior                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Codex 0.160.0                    | Local binary and model cache; custom Responses provider capture               | Bundled version and discovery version aligned; separate child thread IDs/cache keys; account-specific effort metadata |
| Claude Code 2.1.289              | Native request: SDK 0.128.0, Node 26.3.0, sdk-cli profile, billing suffix ec8 | Shared constants synchronized; no speculative beta flags added                                                        |
| Copilot 1.0.92-3                 | Native generation UA, editor version and API version 2026-08-01               | Generation profile aligned; existing caller correlation IDs preserved                                                 |
| Antigravity CLI 1.2.16           | Installed CLI and official release binary                                     | Independent CLI version resolver floor                                                                                |
| Antigravity standalone IDE 2.5.5 | Official standalone language-server binary                                    | Independent IDE version resolver floor                                                                                |
| Antigravity Hub 2.19.1           | Separate binary and SDK/runtime investigation                                 | Not substituted for the standalone IDE profile                                                                        |

The public GPT-6.1 API catalog and ChatGPT-backed Codex catalog have different context and effort metadata. Discovery remains account-specific; a fallback model declaration does not grant access. Native custom-provider capture maps the CLI's ultra setting to a different wire effort, so it is not evidence that raw ultra is accepted by the ChatGPT backend. Existing legacy priority handling and the disabled app-server path remain intact.

Fresh authenticated Antigravity discovery returned Gemini 3.8 Flash variants, Claude Sonnet 4.6, Opus 4.6 thinking and GPT OSS 120B medium. A small live Gemini 3.8 Flash request completed successfully. Availability of additional Claude or GPT models must come from actual account discovery. The live GPT-6.1 request was rejected by the old local catalog before upstream dispatch; signed model-sync authorization and the bundled discovery version are addressed in this candidate.

## Concurrency and caching

Antigravity streams now bound buffered bytes, cancel owned readers, drain discarded responses, and distinguish transport queue wait from upstream readiness. Tool thought signatures and session identity are scoped to account, API principal and conversation. Account affinity takes precedence over capacity scoring so a tool roundtrip does not silently switch accounts. Retry delays are cancellable and jittered; transient failures do not exhaust credits.

Provider integration and dashboard routing strategies remain separate. Configured routing, forced accounts and valid session affinity retain their precedence. These changes do not promise 100 simultaneous generations on one subscription: upstream concurrency, token and usage limits still apply. No verified bulk endpoint was found for interactive ChatGPT-backed Codex or Cloud Code Assist tool turns. Public batch APIs do not substitute for interactive multi-turn sessions. The Antigravity SDK wraps a local runtime/WebSocket path rather than establishing a consumer OAuth multiplexing API.

Antigravity now reports actual cached prompt and reasoning usage without counting cached tokens twice. No cache hit is fabricated and no unsupported explicit-cache parameter is added to Cloud Code Assist. Codex cache keys remain stable within a conversation and distinct across child threads. Public API cache controls are not automatically injected into the ChatGPT-backed endpoint.

## Imported changes and excluded work

Reviewed completed local-next changes include Claude tool-history bridging, Codex usage pacing, weekly quota normalization, numeric-string sequence deduplication, TLS proxy metadata handling, Flash-Lite zero-budget normalization, GHE GPT-6 Responses routing and filtered model catalog headers. Imports use immutable commits through `3bdffc3473aa35e16fe52ed35dfb8cf657b56581` rather than the active dirty checkout.

The process-level relay-timeout swallowing change is deferred: request-owned cleanup and error propagation should be verified before suppressing an uncaught exception. General API-key database policy changes and unrelated backlog items remain outside this provider candidate. HTTP/2 generation, SDK transport replacement, explicit Cloud Code caches and additional code-generation RPCs require authenticated protocol evidence and separate compatibility tests.

## Validation boundary

Regression suites cover native error-body ownership, throttling diagnostics, child-thread identity, catalog authorization, model effort aliases, cache accounting and imported fixes. The authenticated HTTP integration test exercises 1, 30, 70 and 100 independent Antigravity conversations with tool call/result turns, both streaming and JSON replies, fragmented frames, reused native tool IDs and distinct thought signatures. Its 402 requests use a synthetic upstream and eight transport lanes. This establishes isolation and lifecycle behavior, not real upstream quota capacity.

An authenticated Responses HTTP regression checks that a native-like 429 remains readable, returns its explanation (and Retry-After before headers are committed), and triggers no immediate retry storm. The expanded provider regression suite passed 835 tests; the focused ownership/diagnostics suite passed 57 tests. The native-error HTTP and unit regressions passed on the live image's Node 26 runtime (six tests), with one generation attempt for a throttled request. The Antigravity HTTP test also passed on that runtime with all 402 requests. Core and OpenSSE type checks passed. Repository hooks and source HTTP tests must pass before preparing a deployment. Production image assembly and an isolated compiled-image smoke test are still required before this candidate becomes live.

## Public protocol references

- [GPT-6.1 Sol API model](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Gemini context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching)
