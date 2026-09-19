# Validation matrix

Detailed controls: `../workers/gates-and-pending.md` and `../audit-source/RECONCILIATION-CHECKLIST.json`
Owner scope override: `../plans/OWNER-SCOPE-OVERRIDES.json`

## Evidence classes

- **Offline contract:** deterministic fixture/fake transport; no provider network.
- **Packaged offline:** built image or standalone route, provider egress blocked.
- **Private readiness:** candidate running separately with isolated state and no provider egress.
- **Live canary:** explicitly approved provider transaction.
- **Operational:** observed same-digest deployment meeting provider-specific thresholds.

Historical results are regression references, not acceptance results for the new candidate.

## Shared acceptance

| Area | Required proof |
|---|---|
| Identity | `uc-persona`, `uc`, and `ucn` resolve consistently; MaxAI `maxai`/`mx` unchanged; Direct disabled |
| Credentials | Cross-provider tuples rejected; atomic rotation; no mixed generation; no secret logs |
| Timeouts | Queue wait and execution timeout separate; slow fake execution succeeds beyond queue wait |
| Cancellation | Client abort reaches HTTP/WS/upload/poll/worker and leaves no background work |
| Egress | Exact selected connector or typed fail-close across proxy/env/relay/nested paths |
| Readiness | Generic health cannot mark provider/capability ready |
| Audit | Only safe metadata/hashes; no prompts, bodies, credentials, raw IPs |

## UC Persona acceptance

| Capability | Offline proof | Later live proof |
|---|---|---|
| Identity/migration | All aliases; dry-run/commit/repeat/failure rollback; no duplicate row | None needed initially |
| Text/stream | Captured deltas, terminal, incomplete, error, quota fixtures | One approved useful text request |
| Tools | Whole-response declared call only; no mixed prose or second generation | One approved synthetic-safe local tool if needed |
| Vision/document | PDF and PNG first; strict base64, bounds, SSRF/redirect/readiness failures | One approved proven-type attachment at a time |
| Image | Captured request/response fixture and safe URL validation | One approved image generation |
| Image-to-video | Captured model/parameter boundaries and polling | One approved image-to-video |
| Speech exclusion | TTS and STT routes reject before transport with policy-disabled status; zero upstream calls | No UC speech live call in this release |
| Quota/cooldown | Seconds/ms/date parsing, horizon, eviction, restart/non-durable behavior | Stop on first real quota/paywall response |
| Direct-negative | No onboarding, credential, route, fallback, media, or enable flag | No live Direct call |

## MaxAI acceptance

| Capability | Offline proof | Later live proof |
|---|---|---|
| Import/refresh | Structured tuple, atomic persistence, abort/failure rollback, signer scan/TTL/rollback/retry | One approved credential/refresh graph only if needed |
| Chat/stream | Bounded SSE, typed 200-level errors, no null empty success | One useful text request |
| Reasoning | Provider-exposed `<think>` text separated; absent reasoning handled cleanly | Record presence/absence, never demand hidden reasoning |
| Tools | Cryptographic nonce, exact requested name/schema, collision/replay rejection | One approved local-tool turn |
| Files | TXT/PDF/DOCX/PNG/JPG proven types first; exact count/type/aggregate bounds and references | One file per approved transaction initially |
| PDF | Bomb/malformed/encrypted/empty-page/boundary/parallel/admission/cleanup and packaged assets | One small PDF only after packaged closure |
| Image | Refresh/cancel/selected transport and safe returned URL | One approved image generation |
| STT | Auth-before-parse, effective cap, chunked policy, peak memory, response bound, nonempty text | One short WebM clip |
| Model catalog / Free/Mistral | Curated allowlist does not silently add saved `mistral-7b-instruct-free`; fixtures preserve its `MAXAI_FREE` record, old-ID drift, hidden FREE picker state, and normal-chat routing without inventing `/free`, `/mistral`, extension-only, or automatic mapping behavior | Only under a separate approval on the normal chat path after current catalog and backend identity are established |
| Unsupported | Video/TTS/quota API/13th tool/spill/parallel absent from claims | No call |

## Prompt and file boundary tests

### MaxAI

- 400,000-character regression fixture on all curated models is historical evidence; new candidate uses offline model/limit fixtures, not 13 live calls.
- Exact raw, base64, JSON, decoded aggregate, per-type, token, and provider limits agree.
- 48 MiB PDF cannot be advertised through a 50 MiB JSON path unless ingress changes.
- `cap-1`, `cap`, and `cap+1` for every byte/token/count bound.
- Unsupported ZIP/archive fails before extraction or network.
- Later remote upload failure is explicitly non-atomic; no chat is sent, but prior remote object may remain.

### UC Persona

- Per-model token accounting and typed over-limit failure.
- One attachment only.
- Start with PDF and PNG unless more formats get new evidence.
- No automatic spill.

## Optional G3-D model discovery acceptance

- Persona refresh makes one metadata-only request to exact host/path.
- Response and row bounds enforced before persistence.
- Error/empty/large/churn responses preserve last known good.
- Direct and Persona schemas cannot cross.
- New IDs enter quarantine and are not routable.
- No discovery event triggers inference.

## Parallel coordinator acceptance

Not part of core. Keep its evidence fixtures separate:

- **Native extension fixture:** layouts 1/2/3/4/6 only, with one conversation/model, ordinary scalar chat request, private stream accumulator, message state, and provider-exposed reasoning splitter per panel.
- **Host-shim fixture:** seven-seat `parallel=7` outer trace, committed 12-seat aggregate/real-`ChatService` driver, and configurable local ceiling 30. These are host scheduling evidence, not per-seat provider receipts or native layouts.
- **Owner-attestation fixture:** the exact 30/32 episode has no recovered request-level trace or completion set. Its absence does not disprove greater-than-six behavior.

Offline later project:

- every lane reuses the hardened normal single-chat request, stream, terminal/error, and provider-exposed reasoning code; no batch endpoint or reduced parallel parser
- unique opaque run/lane/turn/attempt IDs, mode-correct conversation/message/parent identity, and provider-returned IDs only when supplied
- native layout counts and 30-or-more logical records exercise the local coordinator behind independently selected mock active caps; those counts are not provider claims
- reverse/random completion, repeated models, and absent/present reasoning without cross-lane state
- per-lane model/result/error/tool/reasoning/history/continuation and abort isolation
- per-account fairness, transaction, storage, and byte limits
- restart, cancellation, timeout, malformed SSE, ambiguous effects, and duplicate delivery
- feature remains OFF; UC TTS/STT remain OFF and out of scope

Current live policy prohibits parallel provider calls. There is no predetermined staircase to 6, 7, 12, 30, or 32. Any active value above one requires a separate reviewed policy revision, provider/terms basis, immutable candidate, explicit transaction envelope, stop rules, and staged approval. Begin only with the smallest later-approved concurrency and expand only after review.

## Artifact and deployment acceptance

- Clean tree and exact current anchor
- Ten real required ancestor SHAs pass; rewritten `12983c899...` is verified separately through current source/test behavior equivalence; both archived PR diff hashes match
- Full offline suite and build green
- Provider network counter zero during G0–G8
- Secret scans over source, fixtures, build context, image config/history/layers, logs, SBOM, and reports
- One combined immutable digest
- Packaged UC and MaxAI file/runtime markers
- Private start on isolated ports/state
- Rollback rehearsal succeeds
- Readiness matrix matches routing policy

## Pre-live expected state

| Provider | Artifact | Route | Enablement | Credential | Offline | Live | Operational |
|---|---:|---:|---:|---:|---:|---:|---:|
| UC Persona | true | true | false | false | true | false | false |
| UC Direct | true or retained | false | false | false | policy-disabled | false | false |
| MaxAI | true | true | false | false | true | false | false |

## Definition of done

Both providers are “fully usable” only when:

1. Core implementation is on one current clean lineage.
2. All offline, build, package, readiness, and rollback gates pass.
3. Same-digest provider canaries pass within approved budgets.
4. MaxAI general routing and Persona manual routing match policy.
5. Direct and all deferred surfaces remain unavailable.
6. Support, rollback, limits, file types, and known limitations are documented truthfully.
