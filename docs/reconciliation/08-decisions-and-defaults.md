# Decisions and defaults

## Settled implementation decisions

| Topic | Decision |
|---|---|
| Upstream base | Re-freeze current public `release/v3.8.51`; audited anchor was `949235736...` |
| Port strategy | Concern-level ports only; never merge old UC or MaxAI branches wholesale |
| Persona identity | Canonical `uc-persona`; legacy aliases `uc` and `ucn` |
| Persona routing | `uc-persona-manual`, manual-only, never automatic fallback |
| General default | MaxAI after provider/capability readiness |
| UC Direct | Compiled only for provenance/minimal compatibility; no onboarding, credentials, routing, or enablement |
| UC speech | TTS and STT deferred/OFF; no implementation or credit-consuming live validation in this release |
| MaxAI overflow spill | Deferred, default off |
| MaxAI parallel lanes | Separate default-off project; offline design may cap active work at two, but current live policy prohibits parallel calls until a separate policy/product/terms revision |
| Deployment | One combined immutable digest-pinned image; never mutable `base` as identity |
| Readiness | Provider- and capability-specific; generic container health is insufficient |
| Live validation | No live call until G0–G8 and an explicit bounded G9 envelope |

## Settled file defaults from final-v8

These are local safety policies, not universal provider ceilings:

- Maximum explicit MaxAI attachments: 5
- Image: 10 MiB each
- PDF: 48 MiB each
- Other document: 20 MiB each
- Inline decode/preallocation guard: 64 MiB
- Proposed aggregate decoded request guard: 64 MiB
- PDF extracted text: 3.2 million characters
- Exact document text: 800,000 tokens
- Upload response: 1 MiB

The 48 MiB PDF allowance conflicts with the current 50 MiB JSON ingress after base64 expansion. G0 must align these values or introduce a bounded non-JSON/streaming ingress.

## Engineering constants and policies still to freeze at G0

Canonical full table: `../workers/implementation-roadmap.md` §4 “Constant registry.”

### UC Persona

- Attachment MIME allowlist
- Attachment decoded/raw/base64/JSON body alignment
- Image-to-video frame/FPS/step/duration/scale/resolution/poll ranges
- `next_reset` accepted formats and maximum future horizon
- Cooldown-cache entry cap and eviction interval

### MaxAI

- Effective STT file/body cap and matching advertised value
- Reverse-proxy STT body cap
- Missing/false `Content-Length` and chunked-body policy
- PDF/tokenizer global and per-tenant concurrency
- Byte-weighted queue count/bytes and fairness
- Worker heap/stack/CPU or stronger process isolation
- PDF raw/page/object/decompression bounds and overload threshold
- Supported package/platform matrix
- Document overflow policy: lossless reject versus explicitly marked truncation
- Returned `doc_type` equality/normalization rule
- Model, image, upload, and STT response-body byte caps
- Selected transport precedence for direct/env proxy/`NO_PROXY`/relay/nested account contexts and explicit direct sentinel

### Optional Persona discovery, only if G3-D is selected

- Metadata response cap
- Cache TTL and failure backoff
- Maximum model rows
- Drift/churn threshold

These are security/resource engineering choices. They do not need a new product decision if conservative and covered by boundary tests. Any scope or privacy change still requires a separate decision.

## Optional G3-D dynamic Persona catalog defaults

- Metadata-only refresh
- Manual trigger first
- One bounded authenticated request
- Separate Persona cache
- Last-known-good fallback
- New IDs quarantined
- No automatic generation probes
- Human review before routability

## Live-canary decisions still requiring owner approval

Only after G0–G8:

- exact image digest
- provider and account/connection
- sole credential writer
- capability and model
- allowed hosts/methods
- total upstream transaction cap, including refresh/upload/polls/retries
- quota/cost ceiling
- pacing and concurrency
- observation window and success thresholds
- stop conditions
- rollback authority

## Private GitHub repository

The local project is ready for a private repository, but no remote exists. Creating `arminanton/uc-maxai-recon` and pushing it requires explicit approval. Restricted verbatim evidence will remain outside Git.
