# Implementation roadmap

Detailed roadmap: `../workers/implementation-roadmap.md`
Detailed gate inventory: `../workers/gates-and-pending.md`

## Delivery sequence

```text
G0  freeze scope, constants, and concern ledger
 ↓
G1  freeze a fresh clean upstream anchor
 ↓
G2  shared aliases, credentials, timeouts, egress, readiness
 ↓
G3  UC Persona vertical slices; Direct-negative closure
 ├─ optional G3-D metadata-only Persona discovery
 ↓
G4  MaxAI vertical slices and final-v8 closure
 ↓
G5  full provider-network-denied validation and independent review
 ↓
G6  immutable combined OCI artifact
 ↓
G7  rollback and state-compatibility rehearsal
 ↓
G8  isolated private blue/green readiness, provider egress blocked
 ↓ explicit later approval only
G9  one bounded live canary at a time
 ↓
G10 same-digest staged promotion and evidence closure
```

MaxAI parallel coordination is a later default-off project and is not on this critical path.

## Execution rule

Every concern is a reversible vertical slice:

1. **Red:** add one failing contract test at the outermost useful boundary.
2. **Green:** port the minimum current-compatible behavior.
3. **Harden:** malformed input, exact bounds, aborts, races, resources, redaction, and negative routing.
4. **Integrate:** run provider and shared suites with a network trap.
5. **Record:** donor/target hashes, overlap decision, tests, security effect, reviewer, and revert boundary.

Historical green tests do not replace a new Red/Green cycle on the current candidate.

## Phase 0 — G0 defaults and constants

### Freeze the settled scope

- Canonical `uc-persona` with aliases `uc` and `ucn`
- `uc-persona-manual`, manual-only, never fallback
- MaxAI general default only after readiness
- UC Direct disabled and ineligible
- Automatic context spill and parallel lanes excluded
- One immutable combined artifact

### Select security/resource values

- UC attachment MIME/body alignment
- UC video parameter ranges
- UC reset horizon and cooldown-cache bound
- MaxAI STT effective body/file/chunked limits
- MaxAI PDF/tokenizer global byte/concurrency/resource admission
- Endpoint response-body caps
- Effective raw/base64/JSON/aggregate document policy

Output: versioned constant registry, frozen concern ledger, threat/test plan.

## Phase 1 — G1 clean anchor

1. Re-read current public `release/v3.8.51`.
2. Freeze exact SHA and review all changes after the audited anchor.
3. Use a new isolated clone, clean status, reviewed remote, push disabled.
4. Prove every SHA in the corrected `required_ancestors` list is an ancestor.
5. Separately verify provenance-only behavior equivalences: `12983c899...` is not an ancestor, but the current 300,000 ms MaxAI/`mx` admission floor and its test must be present and distinct from execution expiration.
6. Reverify both archived PR diff hashes.
7. Hash source, lockfile, and generated state before edits.

A preparatory clone exists, but it has not been accepted as G1 evidence and contains no provider changes.

## Phase 2 — G2 shared safety foundation

### S1: identity, aliases, and enablement

Observable result: `uc-persona`, `uc`, and `ucn` resolve to one canonical provider across every registry, route, catalog, media, executor, login, credential, database, quota, and health path. UC Direct remains unreachable. Persona gates remain off.

### S2: credential boundaries

Observable result: UC and MaxAI credential tuples cannot cross providers, token rotation is atomic, and no secret appears in logs.

### S3: admission, timeout, and cancellation

Observable result: queue-full rejects before transport; slow fake execution outlives queue wait but respects execution timeout; cancellation reaches the in-flight operation.

### S4: selected egress and URL safety

Observable result: every proxy/TLS branch uses the selected connector or fails before network. Unsafe URL or redirect paths never dispatch.

### S5: readiness and audit hygiene

Observable result: generic health cannot promote a provider; readiness has capability-specific reason codes and evidence hashes.

## Phase 3 — G3 UC Persona

### UC-1: import auth and legacy migration

- Strict session/cookie tuple
- Correct JWT/session UID
- Protected import/seed only
- Alias-aware dual read
- Transactional, idempotent `uc` → `uc-persona` migration and rollback

### UC-2: text, stream, quota, tools, cancellation

- Captured frame parsing
- Incomplete/error fail-close
- Declared-call-only tools
- No heuristic second generation
- Bounded reset/cooldown state
- Sanitized known/unknown errors
- Abort/499 propagation

### UC-3: one attachment and vision

- Start with proven PDF and PNG
- Count before decode
- Strict canonical base64 and chosen caps
- Pinned public HTTPS fetch
- Redirect/SSRF denial
- No chat after upload/readiness failure

### UC-4: image and image-to-video

- Persona-ID-only dispatch
- Image generation
- Capture-proven image-to-video only
- Captured parameter ranges
- No Direct media or guessed text-to-video

### UC-5: speech exclusion

- Keep UC TTS and STT disabled and out of core.
- Reject speech routes before transport with a stable policy-disabled error.
- Preserve historical TTS artifacts for provenance only; do not port or live-test them.
- Reopening speech requires a new explicit owner decision and credit budget.

### UC-6: provider closure

Run full UC, Direct-negative, and speech-negative suites with provider network denied. Persona becomes artifact/route/offline ready, but its master/media/video gates remain off and speech remains policy-disabled.

### Optional G3-D: dynamic Persona metadata

Implement one bounded metadata refresh, last-known-good cache, drift records, and quarantine. Do not auto-promote or probe models.

## Phase 4 — G4 MaxAI

### MX-1: structured credentials, atomic refresh, signer

- Reject one-string import
- Atomic credential generation
- Bounded singleflight and abort isolation
- Bounded signer scan, strong proof, TTL, rollback
- At most one classified signer retry

### MX-2: selected transport and curated catalog

- Same selected connector for login, discovery, chat, images, upload, STT
- Bounded/cancellable calls
- Curated 13-model metadata only
- Preserve requested, resolved, and returned model identity without using model name as a lane correlation key
- Treat saved `mistral-7b-instruct-free` / `MAXAI_FREE` data and its old-ID drift as catalog archaeology only
- Do not infer automatic free-chat-to-Mistral mapping, extension exclusivity, a current backend identity, or a new `/free` or `/mistral` endpoint
- No silent model addition or route fallback; any future Free/Mistral validation uses the normal chat path under a separate approval

### MX-3: chat, reasoning, tools, terminal errors

- Provider-exposed reasoning only
- Bounded incremental SSE
- Cryptographic mandatory nonce
- Requested-name/schema allowlist
- Typed HTTP-200 error/paywall/null handling
- One observable media-preserving narration retry
- Cancellation

### MX-4: documents, PDF, images

- Align ingress/base64/raw/aggregate limits
- Prevalidate every local document
- Global byte-weighted worker admission
- Serialized upload and incremental SSE
- Exact `doc_list` references
- Bounded PDF pages/objects/text/tokens/resources
- Explicit non-atomic remote-retention behavior

### MX-5: STT

- Auth and admission before multipart parsing
- Effective file/body cap and chunked strategy
- Bounded memory and response
- Captured WebM contract
- Typed timeout/abort/auth/missing-text errors

### MX-6: final-v8 packaging closure

- PDF.js, canvas, tokenizer runtime assets
- Foreign-working-directory and bundle-safety tests
- Narrow ordinary-text tokenizer correction only
- No spill, parallel, video, or TTS code

## Phase 5 — G5 offline release gate

With provider egress denied:

- all touched and full unit/integration suites
- typecheck, lint, format, dependency and lock checks
- generated catalogs/docs/translations/snapshots/quality baselines
- malformed/boundary/abort/concurrency/resource tests
- production and standalone builds
- packaged route and runtime-asset tests
- network-attempt counters
- source, build-context, layer, SBOM, log, and artifact secret scans
- independent diff/security review

Build one unpromoted OCI here. G6 may promote only these exact scanned bytes.

## Phase 6 — G6 immutable artifact

- One image with both providers
- `source.dirty=false`
- Exact commit, lock, concern, test, and SBOM attestations
- Immutable unique tag and recorded digest
- UC and MaxAI packaged-file checks
- No mutable `base`/`latest` deployment reference

## Phase 7 — G7 rollback

- Preserve actual pre-change digest
- Start old image privately with provider egress blocked
- Protected state backup and restore test
- Isolated credential writer
- Migration repeat/failure/rollback tests
- Atomic digest-switch runbook

Rollback to the current old image intentionally restores MaxAI-era behavior with UC absent.

## Phase 8 — G8 private readiness

Start the candidate on separate private ports and isolated writable state with provider egress blocked. Produce readiness for each provider/capability:

- artifact
- route
- enablement
- credential
- offline
- live-canary
- operational

At G8 exit, Persona and MaxAI can be artifact/route/offline ready while enablement/live/operational remain false. UC Direct reports `POLICY_DISABLED`.

## Later G9/G10

G9 requires a fresh written live envelope. It starts with one useful human-reviewed text request, one account, one model, one generation, one residential connector, and a complete transaction ledger. Each later capability is separately approved.

G10 promotes the same digest only after the approved observation window and provider-specific thresholds pass.

## Separate optional project: MaxAI coordinator

- Default off; it must not delay or weaken the core provider release
- Configurable logical lane count behind explicit queue, byte, transaction, and per-account limits
- Do not derive a provider maximum or scheduler default from native layouts 1/2/3/4/6, recovered host-shim seats 7/12, the shim's local ceiling 30, or the owner-attested missing 30/32 episode
- Reuse the native panel topology only as an architecture pattern: one conversation/model/action and one ordinary scalar single-chat request per lane
- Give every lane unique opaque run/lane/turn/attempt IDs, plus mode-correct unique conversation/message/parent identity
- Give every active request its own response object, stream accumulator, hardened normal single-chat parser, provider-exposed reasoning splitter, tool state, timeout, and abort tree
- Preserve per-lane requested/resolved/returned model, result, error, tool, reasoning, and continuation state
- Keep reasoning only when the provider exposes it; host council narration is not provider reasoning
- Current live policy prohibits parallel provider calls. A serial-only pre-live stage, if separately approved, uses one active provider operation per account
- Any future active value above one requires a policy revision, terms/provider basis, immutable candidate, transaction budget, stop rules, and staged live approval; there is no preselected 2→6→12→30 staircase
- Keep automatic context spill separate and default-OFF
- Keep UC TTS and UC STT deferred/OFF; this project does not reopen them

The recovered host shim is a donor for bounded scheduling and error capture, not the implementation to port unchanged. Its seven-seat outer trace, committed 12-seat aggregate/driver, and configurable local ceiling 30 are distinct from native extension panels. The exact 30/32 episode remains owner-attested and missing, not disproven.
