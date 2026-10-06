# Native Code Assist protocol evidence and staged adapters

Investigated official local artifacts on 2026-10-06. No credentialed provider calls,
SDK installations, native tool execution, live configuration changes or deployments
were performed. Cached account data and static descriptors establish different
things; the table keeps schema inclusion separate from selected live transport.

| Surface                    | Captured source/artifact                                                                                                                    | Generation/auth eligibility                                                                                                                                                                                                                                       | Tool/session ownership                                                                                                                                                                                                                           | Cache meaning                                                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Antigravity CLI            | 1.2.16; SHA `d0c06173f4ab2d6da7c17ba8d52a688234f30a79a7f65e25ace15863a295695f`                                                              | Native CCPA and explicit consumer/business AI Code implementation symbols. Extra account auth/endpoint selection remains wire-unverified. Existing CCPA integration is preserved.                                                                                 | Native CLI is an agent runner; Omni's direct CCPA translation leaves functions with the caller.                                                                                                                                                  | CCPA nested Vertex request contains `cachedContent`/`implicitCacheConfig`; consumer/business AI Code request descriptors do not contain `cachedContent`.                                |
| Standalone Antigravity IDE | 2.5.5; language server SHA `3a4003a02a107abedcefff4dd5167dbf40450d9be4d11ed07b12c21e69501d4b`                                               | High-level CCPA generation implementation found; the inspected binary lacks CLI/Hub's named high-level AI Code implementation. Consumer AI Code/Bidi protobuf schema is nevertheless linked. This does not prove it is selected or unavailable for every account. | IDE's own local agent/tool management is distinct from the upstream request schema.                                                                                                                                                              | Preserve standalone profile/version. Do not substitute Hub fingerprints or assume public cache CRUD access.                                                                             |
| Modern Antigravity Hub     | 2.19.1; language server SHA `6f738eba385f68d66c83dfd50546346a30688422d364fa398d2f9155586853da`                                              | Both consumer and business AI Code generation implementations and complete descriptors are present. No account entitlement or API-version substitution was demonstrated.                                                                                          | Native Hub manages trajectories and workspace/tool lifecycle.                                                                                                                                                                                    | Separate consumer/business request contracts; no cache resource reference in those generation messages.                                                                                 |
| Antigravity Python SDK     | [official source at `12f9a4c3`](https://github.com/google-antigravity/antigravity-sdk-python/tree/12f9a4c3becf487302dc799b0f59054f01f3ddb9) | SDK source needs a wheel-bundled runtime binary. Local configurations document Gemini API key or Vertex/ADC; this does not provide a transparent replacement for CCPA OAuth subscription traffic.                                                                 | Local runtime subprocess, length-prefixed initialization and localhost WS. Connection rejects simultaneous `receive_steps`; runtime owns trajectories and ToolRunner. Default built-in tools require an explicit policy, not a proxy assumption. | SDK usage includes cached-token counts. Its local protobufs do not expose a cache resource CRUD or reference contract. Local WS is not evidence of upstream multiplexing.               |
| Gemini JS SDK              | [official source at `ca5690c0`](https://github.com/googleapis/js-genai/tree/ca5690c0999f499f69bb69ea6187ef29d26ddfef)                       | Public Gemini/Vertex service, credentials, billing and endpoint contracts differ from Cloud Code OAuth. Generate streaming, Live Bidi and asynchronous Batch are separate surfaces.                                                                               | SDK callable tools can invoke automatic function calling. A caller-owned proxy must disable AFC/use plain declarations, retain its own tool loop and not start a second agent.                                                                   | Cache create/list/get/update/delete belongs to the public API/Vertex credential realm. Neither CCPA OAuth nor a CCPA-generated companion project proves IAM rights to these operations. |

## Complete descriptor evidence

`../extractGoDescriptors.py` extracts bounded serialized FileDescriptorProto records
without executing the binaries or installing protobuf tooling. It records binary
and descriptor SHA, message fields, typed references and HTTP annotations. Finding
only a textual `.proto` filename fails the extractor's schema validation.

The inspected CLI, standalone IDE and Hub embed these contracts:

- CCPA `google.internal.cloud.code.v1internal.PredictionService`: HTTP POST
  `/v1internal:streamGenerateContent`, `generateContent`, `countTokens`,
  `fetchAvailableModels`, `retrieveUserQuota`, `retrieveUserQuotaSummary`.
- CCPA generation root: `project`, `requestId`, `request`, `model`, `userPromptId`,
  `userAgent`, `requestType`, `enabledCreditTypes`. The nested `request` references
  Vertex's GenerateContentRequest descriptor, which includes `cachedContent`,
  `sessionId`, `implicitCacheConfig`, `serviceTier` and `continuationToken`.
  Inclusion alone does not authorize experimental controls or arbitrary endpoint,
  service-account or routing overrides.
- CCPA CountTokens root has **only `request`**, containing Vertex CountTokensRequest
  fields such as model, contents, system instruction, tools and generation config.
  Its request has no `cachedContent`; a cached prefix cannot be silently omitted
  from an supposedly exact count.
- Consumer AI Code PredictionService: stream/unary generation HTTP annotation
  `/{$api_version}:streamGenerateContent` / `generateContent`; quota GET annotation;
  gRPC bidirectional generation has no HTTP/WebSocket annotation. The binary's
  `v1main` protobuf namespace is not proof of the actual HTTP API version.
- Business AI Code PredictionService: stream/unary generation and quota routes
  include `parent=projects/*/locations/*`. Generation includes `parent`, model,
  aicode, contents, system instruction, tools, tool config, labels, safety,
  generation config and entitlement. It has no consumer `sessionId` field.
- Native ModelDetails exposes `maxTokens`, `maxOutputTokens`, disabled/internal
  flags, explicit image/thinking/video/PDF booleans, MIME capabilities and
  additional feature flags. Discovery also reports agent/tab/command/image/search/
  transcription roles. Compiled model enums are not account entitlement lists.

Full extracted JSON and native binary hashes are local audit artifacts under
`/home/ubuntu/_/omni/audit/ledger-native-protocols/`. The script accepts an explicit
binary/file list and emits no credentials, user prompts or authenticated headers.

## Implemented candidate changes

- `codeAssistDiscovery.ts` validates account model metadata with Zod; preserves
  account-advertised native token windows, explicit true/false capability flags,
  roles and MIME declarations. Unknown/malformed limits remain unknown.
- Discovery projection excludes native `disabled`/internal rows and emits standard
  vision/thinking metadata. A valid empty/disabled per-connection API catalog is
  distinguished from an unavailable API, so discovery does not substitute local
  models for an explicit empty result. Existing CLI/standalone identities are kept.
- Discovery coalescing hashes the entire token plus configured project, profile and
  connection. A shared 16-character token prefix cannot merge different refresh or
  project contexts. Bootstrap uses the configured guarded outbound/proxy transport;
  configured projects bypass bootstrap and redundant persistence; the BYOP sentinel
  is not persisted or sent as a project. Error payloads/exception text are not logged.
- `codeAssistRpc.ts` compiles exact CCPA read-only request shapes and rejects
  unverified AI Code/local SDK surfaces and arbitrary caller origins. It creates
  no account grant, cache, subprocess, request retry or agent tool loop.
- `codeAssistReadOnlyProbe.ts` supplies an explicit opt-in callable CountTokens
  operation through an injected reviewed outbound transport. It sends one request,
  blocks redirects, applies a five-second total abort signal, reads at most 16KiB,
  owns/cancels its reader and returns redacted error category/status. It is not
  enabled automatically or exposed as a public endpoint.
- `codeAssistCacheOwnership.ts` and the executor call site retain an explicit cache
  only with a private credential-side receipt binding verified CCPA capability,
  connection/account, cryptographic principal/conversation namespace, upstream model
  and expiry. Caller body fields cannot mint ownership. Missing/stale/mismatched
  references fail clearly; they are not silently discarded from a partial prompt.
  Native implicit caching/usage accounting is untouched. No cache CRUD or receipt
  issuance/broker is implemented or assumed.

## Validation and remaining eligibility gates

Focused tests cover native metadata/disabled rows/unknown limits, exact read-only
request schema, fail-closed surfaces, actual local signed HTTP request shape,
no-dispatch cancellation/disablement, one-attempt 429 handling, bounded/error-body
redaction, cache scope and executor preservation/rejection. Python tests distinguish
real descriptors from textual symbols and reject malformed/unbounded wire fields.

Before real CountTokens/discovery verification, root must supply an approved
isolated candidate using the reviewed residential egress boundary and a capped
one-active-account read-only test plan. No host-direct or newly guessed namespace
calls are authorized by these adapters. Verify the exact current account's service
eligibility, quota scope, auth mode, headers, API version, negotiated transport and
returned metadata; do not infer them from linked schema or copied fingerprints.

Before new AI Code generation, obtain sanitized native wire evidence for endpoint,
version/auth/entitlement and parameters, then test actual caller-owned tool turns,
thought signature/usage continuity, cancellation and model capability. Consumer,
business and public API identities/quotas cannot be merged from matching email.

Before explicit cache use, a server-side broker or reviewed import must prove
resource ownership and account/model service eligibility and issue a private scoped
receipt. Public Gemini cache ownership is not equivalent to CCPA ownership. Verify
cache effectiveness and expiry against real usage; a cached-token field is not proof
that every turn achieved a cache hit.

The SDK evidence rules out a transparent transport substitution today. A separately
scoped native-agent product may use its runtime, but requires tool/workspace policy,
per-session lifecycle and resource controls and different billing/auth review. It
must not silently execute Prime's tools or enable the disabled Codex app-server path.
