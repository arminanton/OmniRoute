# UC + MaxAI implementation roadmap

> **Status:** planning only. No combined candidate exists. G0–G8 are not started, G9–G10 are blocked, and no live provider call is authorized.
>
> **Reader:** the engineer who will build the first clean combined candidate in a new disposable clone.
>
> **After reading:** the engineer should be able to open the G0 ledger, implement one test-first vertical slice at a time, and know exactly when to stop rather than infer readiness from old images, tests, or live results.

This roadmap turns the audit into an execution sequence. It does not repeat the forensic history. Historical branches, images, and live runs are evidence inputs only. They are not a landing base and do not satisfy any exit criterion below.

### Evidence and boundary notation

- **`[POLICY/HIGH]`** means a reviewed target requirement in `audit-source/RECONCILIATION-PLAN.md` §§1 and 4–12 plus `audit-source/RECONCILIATION-CHECKLIST.json` (`state`, `gates`, and `implementation_defaults`). Unless marked otherwise, every “must,” phase output, and exit criterion below has this label.
- **`[CURRENT-SOURCE/HIGH]`** means behavior verified at audited public anchor `949235736042b13cf64215632e6d44db7985af76`, as bounded by `audit-source/UC-SOURCE-REVIEW.md`, `audit-source/MAXAI-SOURCE-REVIEW.md`, and the plan §3. It does not mean the behavior is in the present image.
- **`[RECOVERED/HIGH]`** means exact donor code, patch, fixture, or image content reviewed in the source reviews and capability matrix. It is an input to a concern port, never a target tree.
- **`[HISTORICAL/HIGH, BOUNDARY-LIMITED]`** means a retained live/test result only for its named old source/image. Prompt/file/media bounds use `workers/input-upload-media.md` §§2–9; parallel facts use `workers/maxai-parallel-lanes.md` §§“Scope and verdict” and “Recommended implementation and validation slice.” These results do not clear a target gate.
- **`[CURRENT-RUNTIME/HIGH]`** means the directly inspected deployment summarized in `audit-source/FINAL-AUDIT-SUMMARY.md` §§“Confirmed facts and strongly supported chronology” and “Landing and deployment plan”: it has no audited UC provider files and is not a clean combined candidate.
- **`[PROPOSED]`** marks a value or design that still needs the stated G0 review or measurement. Persona discovery design is grounded in `workers/uc-model-discovery.md` §§5–6; operations defaults are the normative safe policy in `workers/residential-operations.md` §§1 and 3–7. The gate inventory and blockers are consolidated in `workers/gates-and-pending.md`.

These labels keep five boundaries separate: current public source, recovered local implementation, historical test/live evidence, present deployment, and intended future behavior. Section-level citations are used here so the roadmap stays actionable; the cited audit and worker reports retain the exact commit, file, test, session, and message locators.

## 1. Release contract

The following rules apply to every phase.

1. **Build a new combined candidate.** Start from the approved current public anchor after re-verifying it. Port concerns into current APIs. Do not merge an old UC or MaxAI branch, copy an image filesystem, or transplant a parentless snapshot.
2. **UC Persona goes first in implementation and validation order.** This does not change routing priority.
3. **Preserve routing policy.** MaxAI keeps canonical ID `maxai` and alias `mx` and may be the normal general route only after its own readiness and promotion gates pass. UC Persona is `uc-persona`, accepts lookup aliases `uc` and `ucn`, displays as `UC Persona / Emotional`, is exposed only through `uc-persona-manual`, and is never a default or fallback. Its master/canary gate starts OFF. UC Direct (`uc-direct`) has no onboarding, credential creation, normal enable flag, default, fallback, or eligible route.
4. **Keep credentials and identity separate.** UC web-session material must never satisfy MaxAI, and MaxAI's structured token tuple must never satisfy Persona or Direct. Provider selection comes from the resolved canonical provider ID, never a token prefix.
5. **Keep queue and execution time separate.** Queue admission `maxWaitMs`, post-dispatch `executionMaxWaitMs`, provider protocol timeouts, pacing, and quota cooldowns are different controls.
6. **Fail closed.** A missing required route, invalid redirect, malformed terminal frame, failed attachment, body overflow, unknown credential state, or disabled feature must stop before any later provider action.
7. **No deceptive automation.** Use only an owned or expressly authorized connection and provider-permitted client behavior. Do not rotate identities, bypass challenges, disguise prompts, or use fingerprint controls to evade detection. Provider code remains network-topology-neutral; deployment policy selects and attests the route.
8. **No provider traffic through G8.** All implementation and validation use frozen or synthetic fixtures, fake HTTP/WebSocket services, and a network-deny harness. G9 requires a new, exact approval envelope.
9. **Release by digest.** Never use `:base`, `:latest`, or another mutable tag as a deployment or rollback identity.

## 2. Delivery sequence

```text
G0  decisions, constants, and concern ledger freeze
  ↓
G1  fresh clean anchor and baseline manifest
  ↓
G2  shared identity, credential, timeout, transport, and readiness safety
  ↓
G3  UC Persona vertical slices + Direct-negative boundary
  ├·· G3-D  optional metadata-only Persona discovery and quarantine (non-gating)
  ↓
G4  MaxAI core vertical slices
  ↓
G5  complete network-denied validation and independent review
  ↓
G6  immutable combined artifact
  ↓
G7  rollback and runtime-contract rehearsal
  ↓
G8  private blue/green start with provider egress blocked
  ↓  new written approval; not implied by G0–G8
G9  one-call live canary, then separately approved capability canaries
  ↓
G10 staged promotion of the same digest and evidence closure
```

The prompt/file/media policy is a cross-cutting track. It is frozen in G0, implemented inside G3/G4, and rechecked in G5. The optional MaxAI coordinator is a separate, default-OFF release track and is not on this critical path.

## 3. Test-first execution rule

Each concern is a small, reversible vertical slice. A slice crosses the public route, registry/credential boundary, executor or worker, parser, error mapping, and readiness signal needed for one observable behavior. Do not build horizontal layers that cannot be accepted independently.

For every slice:

1. **Red:** add a failing contract test at the outermost useful boundary. Install transport spies or a network trap so rejection cases prove zero HTTP, WebSocket, DNS, worker, or upload activity as applicable.
2. **Green:** hand-port the minimum behavior into current APIs. Preserve newer upstream security and shared behavior.
3. **Harden:** add exact-boundary, malformed-input, abort, timeout, race, resource, redaction, and negative-routing cases.
4. **Integrate:** run the relevant provider suite plus shared registry, credential, timeout, generated-file, type, lint, and secret checks.
5. **Record:** update the concern record with the target SHA and pre-port file hashes; exact donor commit/patch/image/snapshot identity and paths; proof the concern is not already upstream; overlap decision and winning repair; security/privacy effect; tests; generated outputs; reviewer; disposition; and single-concern revert boundary.

A green historical test is never the Red or Green result for the new candidate. Each run record must include the command, tool versions, safe environment, source and fixture hashes, start/end time, exit code, and output hash.

## 4. G0 — freeze decisions, constants, and scope

*Control: `[POLICY/HIGH]` — reconciliation plan §§11–12; checklist G0; `workers/gates-and-pending.md` §G0.*

G0 records the settled product policy and turns unresolved resource values into explicit implementation-security decisions. It is not a live measurement phase.

### Settled defaults

- Persona identity and routing are exactly as stated in the release contract. Implementation priority does not make Persona the general default.
- Persona onboarding is protected import/seed only. Email-code onboarding stays unreachable.
- UC Direct remains compiled only where needed for architecture or offline provenance and remains policy-disabled.
- Persona master/canary, media, video, and discovery-refresh gates start OFF. UC TTS/STT are policy-disabled and out of scope.
- MaxAI context spill, parallel agents, TTS, video, a quota API, and a claimed thirteenth tool dialect are outside core.
- Core text remains inline. Neither provider automatically turns an oversized conversation into a file.
- One combined immutable artifact is built only after the full offline gate passes.
- A deviation, Direct reopening, or spill/parallel work opens a new product/privacy decision, threat model, and test plan.
- Resolve the MaxAI Firefox-150/wreq wording at this gate. Preserve the audited build default: every MaxAI transport branch uses the reviewed Firefox-150/wreq path or fails closed with 503; no ordinary-fetch, relay, identity, or route fallback is allowed. The later operations review adds a compliance condition: do not activate that profile or live MaxAI unless the provider permits this client behavior, and never use it to evade enforcement. Record that precedence as an explicit policy decision with its threat review and tests. Without authorization, MaxAI stays disabled. This is private deployment policy, not a public provider-capability claim.

### Constant registry

Treat every number below as a **local safety or implementation control**, not a provider capacity claim. Keep its evidence class visible.

**Recovered controls adopted by the target policy — re-verify at G1/G5 (`[RECOVERED/HIGH]`, never provider maxima):**

- UC: Persona WebSocket timeout 120 s; image polling 2 s / 60 s; video polling 3 s / 300 s; blob readiness 20 s; one attachment; decoded per-item media acceptance cap 64 MiB; execution backstop 600 s. The recovered TTS timeout is provenance only, not target scope.
- MaxAI final-v8: five new attachments; image 10 MiB, PDF 48 MiB, other document 20 MiB; 64 MiB inline decode/preallocation guard; 800,000 text tokens; 3,200,000 extracted PDF characters; PDF worker 60 s; tokenizer worker 30 s; 16 MiB total chat response; 1 Mi-character SSE frame; 1 MiB upload response; 120 s upload timeout. Accepted STT source used a 30 s operation timeout.

**Current/shared controls — preserve unless a separate tested decision changes them (`[CURRENT-SOURCE/HIGH]`):**

- Re-verify at the G1 anchor. The audited values were a 52,428,800-byte JSON chat-body cap and heavyweight classification at 262,144 body bytes, 32,000 estimated tokens, 200 messages, or 64 tools; the default hard message-count cap was disabled. These are admission controls, not provider prompt limits. Check their interaction with base64 expansion before advertising any decoded attachment maximum.
- Preserve MaxAI/`mx`'s 300 s queue-admission floor and the distinct 600 s execution backstop. Neither is a pacing or quota allowance.

**New target safety policy (`[POLICY/HIGH]`):** enforce a separate 64 MiB aggregate decoded-document ceiling. This is distinct from the same-sized inline decoder guard. **Proposed G0 choice (`[PROPOSED]`):** reject losslessly over-limit input rather than silently truncate it; record the final reject-vs-truncate decision and tests.

**Choose and record before the affected surface can pass its gate:**

| Open value | Required G0 evidence |
|---|---|
| UC speech exclusion | Owner decision removes UC TTS/STT from core. No speech cap selection is required; negative tests must reject both routes before transport. Reopening requires a new explicit owner decision and credit budget. |
| UC attachment MIME allowlist and request-body/base64-expansion alignment | The proposed safe starting allowlist is capture-backed PDF and PNG only; freeze it or document evidence for any addition. Prove the effective route/body limit can enforce the stated decoded cap without unbounded buffering. |
| UC image-to-video frame count, FPS, steps, duration, scale, resolution, and poll ranges | A capture-derived accepted-value table and boundary/rejection tests. Until then, video stays OFF. |
| UC `next_reset` future horizon, cooldown-cache entry cap, and eviction interval | Fake-clock tests for seconds, milliseconds, dates, past/far-future/non-finite values, eviction, and restart. |
| MaxAI STT upload/file cap, reverse-proxy body cap, and missing/false-length/chunked policy | Peak-memory measurements with synthetic audio, auth-before-parse tests, declared and actual byte checks, and one advertised value equal to the effective limit. The old 2 GB wording is forbidden. |
| Selected-transport precedence and explicit direct sentinel | Freeze behavior for direct, environment proxy, `NO_PROXY`, edge relay, and nested provider/account contexts. Distinguish intentional no-proxy selection from lookup/assignment failure; conflicts and failures must stop before dispatch. |
| PDF/tokenizer global and per-tenant concurrency, byte-weighted queue bytes/count, fairness, worker heap/stack/CPU controls, raw/page/object limits, supported platforms, and overload threshold | Malformed, encrypted, empty-page, decompression-bomb, parallel, saturation, worst-case-memory, abort, foreign-CWD, and cleanup benchmarks. Reject with a typed error before worker spawn when full. Per-request timeouts alone are insufficient. |
| MaxAI document overflow and returned `doc_type` policy | Record reject-vs-truncate explicitly (proposed default: lossless reject). From captured semantics, decide whether returned `doc_type` must exactly equal the prepared type, then enforce and test that rule. |
| Model, image, and STT response-body byte caps | Endpoint-specific bounded-reader measurements and over-limit/abort tests. Do not read an unbounded body and then truncate it. |
| Persona discovery body cap, cache TTL, maximum rows, drift/churn threshold, and failure backoff | Review the proposed 256 KiB, 24 h, and 1–256-row values as starting points, not established limits. Freeze final values with retained-fixture and large-drift tests. |

The discovery row applies only if selective G3-D network refresh enters scope. It does not block the static G3 core. Its fetch gate remains OFF otherwise.

Live pacing, daily account caps, cost ceilings, and SLO thresholds are not guessed in G0. They are selected in the later G9 approval. The conservative live defaults in §13 apply until then.

### Outputs

- Versioned defaults and constants registry, with owner and rationale for each value.
- Frozen concern ledger covering every mandatory, selective, regenerated, deferred, and rejected concern.
- Explicit negative-capability list and feature-gate inventory.
- Test and threat plan for every concern; separate decision records for any deviation.

### Exit criteria

G0 passes only when the reviewed defaults match the ledger, every mandatory resource value above is selected and security-approved, and Direct/spill/parallel dispositions are unambiguous. If a safe value cannot be selected, the surface stays OFF and removing it from mandatory core requires a new explicit scope decision; an OFF flag alone does not close the G0 item. No provider call is used to exit G0.

## 5. G1 — establish the clean anchor

*Control: `[POLICY/HIGH]` — reconciliation plan §3.3 and §11; checklist G1.*

Use a new disposable clone outside every existing OmniRoute path and linked worktree. The audited landing anchor is `949235736042b13cf64215632e6d44db7985af76`, but public HEAD must be checked again immediately before implementation. If it moved, freeze and review the delta before changing the anchor.

### Work

1. Verify the reviewed public remote, exact HEAD, empty index/worktree, and no untracked files.
2. Prove every SHA in `audit-source/RECONCILIATION-CHECKLIST.json#/landing_lineage/required_ancestors` is an ancestor. Do not require pre-rewrite provenance commit `12983c899...` as an ancestor.
3. Verify every `required_behavior_equivalences` entry in target source/tests. For the MaxAI floor, assert the 300,000 ms `maxai`/`mx` admission behavior and its separation from post-dispatch execution expiration.
4. Verify the two archived PR-diff hashes in `audit-source/RECONCILIATION-CHECKLIST.json#/landing_lineage/pr_diff_sha256` and review every upstream change since the audit anchor for overlap.
5. Hash source, lockfiles, and generated artifacts before edits.
6. Create the concern-port workspace and forbid whole-branch merges, tree replacement, and image extraction as implementation sources.

### Outputs

- Signed anchor/ancestry report.
- Baseline source, lockfile, and generated-state manifest.
- Clean-workspace transcript and reviewed upstream-delta record.

### Exit criteria

HEAD equals the approved anchor, all ancestry and hash checks pass, the workspace is clean and isolated, and every overlap has a disposition. Any mismatch stops the work; do not repair the anchor in place.

## 6. G2 — shared safety foundation

*Control: `[POLICY/HIGH]` — reconciliation plan §§4.1, 6.1–6.2, and 11; checklist G2.*

Land these slices before either provider feature. They make later provider work safe to compose.

| Slice | First observable contract | Implementation output | Exit condition |
|---|---|---|---|
| **S1 — identity, aliases, and enablement** | Registry and route tests resolve canonical `uc-persona`, aliases `uc`/`ucn`, and display `UC Persona / Emotional` to one Persona identity; preserve `maxai`/`mx`; reject Direct; keep Persona out of default/fallback pools even when its code gate is ON. UC image entries remain after existing providers, and bare `nano-banana`/`z-image-turbo` ownership does not change. | Generic narrow alias support, canonical storage/lookup rules, collision detection, master and sub-surface gates, and negative Direct policy. | UI/schema, reserved-prefix derivation, registry/model/image/video/audio, MCP/plugin catalogs, executor, login, credential, DB, account lookup, quota/cost/health aggregation, media-prefix, and read-normalized append-only history all agree without granting fallback eligibility; transport spies remain zero while gates are OFF. |
| **S2 — credential boundaries** | Synthetic cross-provider tuples are rejected and never logged; concurrent rotation cannot expose a mixed generation. | Provider-specific schemas, protected import surface, atomic persistence primitive, secret-safe diagnostics. | Authorization, concurrency, abort, persist-failure, and secret-scan tests pass. |
| **S3 — admission and timeouts** | Queue-full fails before transport; a slow fake provider may outlive queue wait but not execution timeout; cancel reaches the real in-flight fake request. | Preserved queue/execution split, shared account lease/budget hooks, linked abort propagation, typed overload/499 behavior. | Existing timeout tests plus UC and MaxAI delayed-stream, saturation, cancellation, and no-background-work tests pass. |
| **S4 — selected egress and URL policy** | Missing/failed required route, conflicting proxy precedence, unsafe URL, redirect, or fast-fail causes no later upstream action. | Connection-scoped transport interface, exact host/path/origin controls, redirect denial, proxy precedence, kill-switch hooks. | Direct/env-proxy/`NO_PROXY`/relay/nested-context fixtures select only the approved route or return a typed failure; an already-open fake request observes abort. |
| **S5 — readiness and audit hygiene** | Generic health cannot promote a provider; logs and artifacts contain no raw credentials, bodies, prompts, or egress IP. | Provider/capability readiness schema, safe reason codes/evidence hashes, bounded/redacted error helpers. | Readiness tests and source/fixture/log scans pass with synthetic secrets. |

For MaxAI client compatibility, implement the reviewed Firefox-150/wreq path across every transport branch and fail closed with 503 when it is unavailable. Do not activate it for live use unless that client behavior is provider-permitted, and never use it to impersonate a person or bypass enforcement. If written permission is absent, `enablement_ready` remains false. Never fall back to another client, identity, or route.

### G2 output and exit

Output one reviewed concern commit per shared invariant plus a green shared contract suite. G2 passes only when credentials, routing, timeouts, cancellation, selected egress, and readiness are proven with provider traffic denied.

## 7. G3 — UC Persona first, as vertical slices

*Control: `[POLICY/HIGH]` — reconciliation plan §§4.2–4.3, 6.3–6.4, and 11; UC source review; checklist G3.*

Implement the smallest text path first. Add media only behind independent gates. Each slice starts with fixtures and zero-transport rejection tests.

| Order | Vertical slice | Required behavior and tests | Output / slice exit |
|---:|---|---|---|
| **UC-1** | Identity, import/seed auth, and migration | Strict session/cookie contract; correct session/JWT identity; atomic persistence; no fake API key; protected import/seed only. Dry-run, transactional, idempotent `uc` → `uc-persona` migration with backup, failure rollback, old-binary compatibility, and all-alias lookups. | A synthetic credential can reach a fake Persona executor only through `uc-persona-manual`; email-code and Direct remain unreachable; no value appears in logs or evidence. |
| **UC-2** | Text chat, stream, quota, tools, and cancel | Parse captured answer/reasoning/terminal/error forms; incomplete stream fails; validate bounded reset metadata and non-durable cooldown; honor only allowlisted headers. Accept a code-style tool call only when the whole response is one declared, allowlisted call; mixed prose or heuristic refusal repair causes no second generation. | Text fixture suite is green; 401/429 mapping is capture-backed, unknown errors are sanitized, abort maps to 499, and every failure has zero unintended retry/quota leg. |
| **UC-3** | One attachment and vision | Count before decode; strict canonical base64; one item from the G0-approved allowlist (proposed initial set: historically exercised PDF and PNG); bounded public-HTTPS remote input with DNS pinning, exact result origins/paths, and redirect denial; signed blob upload/readiness must finish before chat. | Cap−1/cap/cap+1, malformed encoding, MIME mismatch, SSRF/DNS/redirect, readiness failure, and requested-upload-loss tests pass. Every local failure makes zero upload/chat calls. |
| **UC-4** | Image and capture-backed image-to-video | Dispatch by canonical provider ID, never key prefix. Preserve registry order. Expose only the captured `wan-2.2-spicy` image-to-video path with G0's value table; reject guessed text-to-video and all Direct media. | Image fixtures and every video accepted boundary/rejected out-of-range case pass; media/video gate OFF stops before transport. |
| **UC-5** | Speech exclusion | Keep UC TTS and STT disabled and out of core. Preserve historical speech artifacts for provenance only. | TTS/STT routes return policy-disabled before HTTP/WebSocket/provider transport; transaction counters stay zero. Reopening requires a new owner decision and credit budget. |
| **UC-6** | Provider-wide closure | Cross-modality aliases, timeout semantics, route gates, credential migration, quota wording, cancellation, Direct-negative policy, and speech-negative policy. | Full UC, shared, Direct-negative, and speech-negative suites pass under network denial. Persona is artifact/route/offline-ready but master, media, video, credential-live, and live-canary readiness remain false. |

UC TTS and STT are out of scope. Do not add speech, multi-file Persona input, local PDF extraction, guessed text-to-video, Direct fallback, an “unmetered” claim, or MaxAI-style prompt spill.

### G3 outputs

- Concern-sized UC commits and frozen redacted fixtures.
- Frozen reviewed 19-ID Persona seed, capability flags, migration tool/runbook, and feature-gate documentation.
- Machine-readable UC/Direct-negative test evidence.

### G3 exit criteria

All UC and Direct-negative offline contracts pass with provider egress denied. The canonical route and aliases agree across every surface. Persona can be policy-correct without being callable: the master and media/video gates remain OFF until their focused criteria pass; speech remains `POLICY_DISABLED`. Direct reports `POLICY_DISABLED`.

## 8. G3-D — optional, non-gating Persona discovery

*Evidence/design: `[CURRENT-SOURCE/HIGH]` and `[PROPOSED]` — `workers/uc-model-discovery.md` §§1 and 5–6. The web roster observations are historical metadata evidence; the target design is not implemented.*

The audited current public source uses a static Persona catalog, while the present runtime has no UC code and retained web captures show a changing server roster. If this selective slice is approved, add discovery as **metadata detection, not automatic enablement**. The mandatory G3 core remains the frozen reviewed 19-ID seed, which does not claim current provider availability or capability, and G4 does not depend on G3-D. Discovery must consume zero generation quota and must not make static Persona readiness depend on a live endpoint.

### TDD slices

1. **D1 — parser and store.** Parse the retained 22-, 27-, and 32-row responses. Preserve safe wire IDs without separator rewriting. Retain only reviewed model fields, the default, and free-tier ID hints. Ignore and never persist the raw body, headers, prompts, or unrelated metadata.
2. **D2 — quarantine and promotion.** Keep an immutable frozen reviewed 19-ID seed plus atomic `last_observed` and `last_approved_good` slots in a Persona-only namespace. New IDs start capability-unknown/false and non-routable. Duplicate, empty, over-size, missing-default, or high-churn observations preserve the last approved list. Removals require two separated valid observations and human approval; deprecate before removal.
3. **D3 — fixed fetch boundary.** If safe application material is available, use only the capture-backed fixed POST to the exact Persona metadata host/path and fixed body. The application bearer is server-side, memory-only, never a Clerk JWT or Direct key. Deny redirects, bound time/body, use selected fail-closed transport, singleflight, zero automatic retries, and an explicit refresh gate that defaults OFF. Never query either Direct catalog as a Persona fallback.
4. **D4 — canonical cache and routing.** `uc-persona`, `uc`, and `ucn` share one canonical cache after migration. Account-specific observations cannot grant another connection eligibility. Public catalog equals approved models only; routing further intersects selected-connection policy and rollout gates.

A transport trap must fail if discovery opens a WebSocket or touches chat, upload, image, video, TTS, token mint, Direct, analytics, or an arbitrary URL. End-user model listing returns cached data and never waits on UC.

Keep the two unrelated “Direct” catalogs distinct in any retained provenance code: authenticated subscription Web Direct uses `/api/direct-models` with provider-prefixed IDs, while Developer REST `uc-direct` uses public `/api/v1/models` metadata with short IDs and separately metered generation credentials. Neither list is Persona discovery or routing evidence. They use separate schemas, caches, and header policies and never broaden Persona.

### Outputs

- Strict schema/parser, versioned sanitized cache, drift report, candidate review workflow, and fixture-import path.
- Optional fixed metadata fetcher behind a separate OFF gate.
- Admin state that distinguishes seed, observed, quarantined, approved, stale, and source age.

### Exit criteria

All retained-fixture, cache, alias, drift, abort, timeout, redirect, over-size, singleflight, secret-leak, and zero-generation tests pass offline. No observed ID becomes routable without review. If the application bearer cannot be managed safely or its use is not authorized, ship the seed plus reviewed-fixture import path and leave network refresh disabled; that does not block static Persona core readiness.

## 9. G4 — MaxAI core, as vertical slices

*Control: `[POLICY/HIGH]` — reconciliation plan §§4.4–4.5, 6.5, and 11; MaxAI source review; checklist G4.*

MaxAI follows UC in implementation order. Its eventual general-route role is unchanged, but it becomes default only after MaxAI's own readiness and promotion gates.

| Order | Vertical slice | Required behavior and tests | Output / slice exit |
|---:|---|---|---|
| **MX-1** | Structured import, atomic refresh, and signing | Reject one-string import. Persist `apiKey`, `accessToken`, refresh token, device/user IDs, and provider-specific fields as one generation. Use connection-scoped singleflight, caller-abort isolation, timeout/cooldown, bounded signing-material scan, strong proof, TTL/invalidation, last-known-good rollback, and unbiased nonce. A narrowly signature-shaped 401/418 may force re-extraction and at most one retry only when the signer generation changed. | Concurrency, abort, persist-failure, scan-bound, rollback, expiry, non-signature, unchanged-generation, and second-failure fixtures pass with no mixed generation or loop. |
| **MX-2** | Selected transport and curated catalog | Carry the selected connection through email request/verify, discovery, chat, image, upload, and STT. Bound and cancel every call. Discovery may update metadata only for the curated 13 and falls back statically; it never auto-adds an ID. Bound model names/groups before persistence or logs and accept only finite positive `max_tokens`. | Direct/proxy/`NO_PROXY`/relay/nested-context tests use one route or fail closed; catalog/body/redaction tests pass. Live enablement remains blocked if the client-profile compliance question is unresolved. |
| **MX-3** | Chat, reasoning, tools, terminal errors, and cancel | Preserve stateless full-history text and captured provider-exposed reasoning only. Bound incremental SSE. Use a random exact nonce, exact requested-name allowlist, argument schema, call count/size bounds, and no mixed prose. Treat captured HTTP-200 auth/paywall/quota/error/null-terminal frames as typed failures. Keep the separate narration-miss retry named, configurable, observable, limited to one, media-preserving, and accounted as a second transaction; propagate cancellation. | No empty-success, raw-body, cross-credential, unauthorized-tool, replay, normalized-name collision, retry-loop, or post-abort action remains. Tests distinguish narration retry from MX-1 signer recovery. Keep the claim at 12/13 tools and never claim hidden/full chain-of-thought. |
| **MX-4** | Explicit documents, PDF, and images | Decode, classify, tokenize, canonicalize names, validate raw and encoded bounds for every item and aggregate, and acquire global plus per-tenant byte-weighted worker admission before upload 1. Apply the G0 returned-`doc_type` rule. Upload serially, parse upload SSE incrementally, send `current:false` references, and send no chat after loss. Bound PDF raw/page/object work, workers, and response reads. Validate input/output URL schemes and origins. | Count/type/aggregate/±1, raw/encoded, malformed, encrypted/empty-page, decompression-bomb, saturation, worst-case-memory, typed-overload, tiny-chunk SSE, abort, cleanup, supported-platform/foreign-CWD, and packaging tests pass. A bad last local item causes zero uploads. A later remote failure may leave an earlier upload; docs and tests state that no delete/transaction API was recovered. |
| **MX-5** | STT | Authenticate and rate/admission-check before multipart parse. Enforce proxy/body, declared-length, actual file, and G0's effective cap; define missing/chunked behavior; avoid duplicate unbounded buffers; bound provider response. Advertise WebM only. Retain captured EBML WebM and Ogg/Opus bytes only when sent under the captured `audio.webm` / `audio/webm` contract; this is not an advertised Ogg format. Preserve 499/504/418 mappings and require nonempty `speech_text`. | Over-size and unauthenticated cases make zero provider calls; peak-memory, chunked/false-length, raw multipart, abort, timeout, error, and missing-text fixtures pass. Registry/API advertised cap and WebM format equal the enforced contract. |
| **MX-6** | Final-v8 runtime closure | Port the reviewed PDF/runtime safety concerns and packaged assets, plus only the ordinary-text `encoder.encode(text, [], [])` correction. Regenerate shared files rather than copying them. Do not bring spill, the final2 worker queue, or parallel code. | Standalone asset closure, foreign-working-directory PDF parse, bundle-safety, tokenizer literal-special-token, package, type, and build tests pass. Unsupported TTS/video/quota/13th-tool/spill/parallel assertions remain absent. |

The G4 ledger must also disposition, one file at a time, the dirty optional `maxai-refresh` cleanup in `config/quality/eslint-suppressions.json`, `scripts/check/check-provider-assets.mjs`, and `tests/unit/maxai.test.ts`. Port or defer each. In either case, scans must reject stale suppressions and false “captured signer-vector” prose.

### G4 outputs

- Concern-sized MaxAI commits, synthetic/redacted protocol fixtures, and strict import/refresh/signing contracts.
- Curated catalog, bounded transport and parsers, safe document/PDF/image/STT paths, and packaged runtime assets.
- Machine-readable MaxAI test evidence and negative-capability report.

### G4 exit criteria

Every MaxAI core contract passes with provider egress denied, all G0 resource controls are enforced, selected transport cannot silently change, optional features remain absent/OFF, and no credential or raw upstream body leaks. This is offline core readiness, not permission to route production traffic.

## 10. Cross-cutting prompt, file, and media policy

*Evidence/control: `[POLICY/HIGH]` plus `[HISTORICAL/HIGH, BOUNDARY-LIMITED]` — reconciliation plan §§4 and 6; `workers/input-upload-media.md` §§2–9.*

This table is the user-visible behavior to implement in G3/G4 and verify again in G5.

| Surface | Core policy | Explicit non-claim / failure rule |
|---|---|---|
| **Text prompts** | Keep both providers inline behind current generic body/context/admission checks. Return the normal typed context/body error when rejected. | There is no proven universal provider ceiling. Historical 400,000-character MaxAI and 480,586-character Persona successes are lower-bound evidence, not limits. Never say “unlimited.” |
| **Automatic prompt spill** | OFF and absent from core for both providers. | Do not convert an oversized conversation to a document. The optional MaxAI experiment uploaded full system/history/tool/current context and had no recovered delete contract. |
| **UC attachment** | One current-turn item from the G0-approved capture-backed allowlist (proposed initial set: PDF and PNG); strict canonical base64; 64 MiB decoded local guard/acceptance target subject to effective ingress alignment; fail before chat on any upload/readiness error. Remote image input is separate and must be HTTPS/public/DNS-pinned/bounded. | Do not advertise other file types from MIME guesses. Do not claim 64 MiB as provider capacity. No multi-file input or reusable file-ID API. |
| **UC media** | Vision, image generation, and captured image-to-video are separate gated surfaces. | UC TTS/STT are policy-disabled; no guessed text-to-video. Video stays OFF until G0 controls and focused tests pass. |
| **MaxAI explicit files** | At most five new files; image 10 MiB, PDF 48 MiB, other 20 MiB; separate 64 MiB aggregate decoded guard; all-item local prevalidation before serialized uploads; strict references and bounded parsing. | Per-type and aggregate values are local policy, not upstream maxima. Do not claim every statically classified extension was provider-tested. Remote side effects are not atomic. |
| **MaxAI evidenced types** | Provider-semantic evidence exists for `.txt`, `.pdf`, `.docx`, `.png`, and `.jpg`; advertise and test any broader allowlist according to its actual evidence tier. | `.jpeg`, `.doc`, `.zip`, and other locally classified types are not thereby provider-proven. Keep docs precise. |
| **MaxAI media** | Inline vision, image generation, and bounded STT are core once their gates pass. | No MaxAI video or TTS. No quota API. STT must not expose the unsafe 2 GB claim. |
| **Responses and retention** | Bound reads before buffering; return typed sanitized errors; store only safe metadata/hashes by default. | Never log raw provider bodies, prompts, attachments, credentials, cookies, tokens, email codes, or raw egress IPs. A failed later MaxAI step can leave an earlier remote upload. |

For every request, the effective allowance is the smallest applicable route-body, decoded, count, per-type, aggregate, tokenizer/context, worker-admission, and provider-policy limit. Registry and documentation values must match the effective enforced path.

**Outputs:** one versioned capability/admission policy, typed public failure contracts, evidence-tiered file/media documentation, and shared boundary-test fixtures used by both provider suites.

**Exit:** the policy and effective enforcement agree at every route; oversize or unsupported input is rejected without silent truncation or prompt spill; no unproven file/media capability is advertised; and every disabled surface fails before transport.

## 11. G5 — full offline validation

*Control: `[POLICY/HIGH]` — reconciliation plan §6 and §11; checklist G5.*

Run the full candidate from a clean tree with provider egress denied. Do not add historical counts from different branches or images.

### Required validation groups

- All touched and full project unit/integration suites; provider routes/executors/media; shared alias, registry, credential, queue, timeout, and readiness contracts.
- Typecheck, lint/format, dependency/lockfile, generated-file, translation, provider-count, quality, cycle, and file-size checks.
- Production and standalone builds; packaged UC, MaxAI, PDF/tokenizer, and timeout markers; offline packaged-route smoke tests.
- Malformed, exact-boundary, abort, timeout, concurrency, saturation, worker cleanup, restart, and deterministic fault injection.
- Network-deny counters proving zero unexpected DNS/socket attempts for every command.
- Build one unpromoted, digest-fixed candidate OCI from the final clean tree for packaged tests. Secret-scan its build context, layers, config/history, SBOM, logs, and reports as well as source, fixtures, and generated output. G6 may promote only these exact scanned bytes; it must not rebuild them.
- Clean regeneration of docs, counts, snapshots, and baselines on the candidate. Never copy donor-generated output.
- Independent diff and security review against the exact concern-ledger and tree hashes.

### Outputs

- Machine-readable command/evidence manifest and network-deny report.
- Regenerated artifacts, scan reports, build outputs, the unpromoted candidate OCI digest/SBOM, exact concern-manifest hash, and independent review signature.

### Exit criteria

Every required command is green, no external provider traffic occurred, no secret finding remains, generated output is explained, the source tree is clean, and an independent reviewer signs the exact diff and evidence manifest. A partial pass blocks G6 and every live call.

## 12. G6–G8 — immutable build, rollback, and private readiness

*Control: `[POLICY/HIGH]` — reconciliation plan §§7–8, 10–11; checklist G6–G8.*

### G6 — immutable combined artifact

**Work and output**

- Promote the exact unpromoted OCI bytes built, scanned, and smoke-tested in G5. Verify the digest is unchanged, assign a unique immutable tag, and record `repository@sha256:<digest>` as the identity. Do not rebuild during promotion.
- Attest the anchor, both provider squashes, candidate SHA, `source.dirty=false`, concern/test/lock/source hashes, SBOM, and packaged manifest without secrets.
- Prove the package contains Persona and MaxAI assets, final-v8 runtime closure, and `executionMaxWaitMs`; prove Direct cannot route.
- Run packaged offline smoke tests by digest. Scan rendered deployment configuration for mutable tags.
- Diff the non-secret linux/arm64 runtime contract: entrypoint/egress wrapper, secret mounts, `/app/data`, Redis/Tailscale dependencies, health command, ports, and digest-pinned service reference.

**Exit:** the registry enforces immutability/retention, provenance matches the clean candidate, package checks and offline smokes pass by digest, and no `:base`/`:latest` reference remains. Do not claim bit-reproducibility without a second isolated matching build.

### G7 — rollback and state compatibility

**Work and output**

- Revalidate and retain the audited pre-change digest `sha256:c47702d184a5f69da4b9e784d767e5844473110d10e2a9175d4f16e6a6f2a57b` in a protected OCI archive or immutable registry reference, protected from garbage collection, and verify it after transfer. If production changed, record and protect the actual new pre-change digest instead of assuming this one.
- Start that old digest on an alternate private port with provider egress blocked.
- Create and restore-test an encrypted, access-controlled state backup. Give the candidate a separate writable data store; never share production SQLite, `/app/data`, or one rotating refresh token between old and new writers.
- Rehearse migration dry-run/commit/repeat/failure rollback, prior-binary reads, and a selective restore that preserves valid credential rotations rather than restoring stale credential state.
- Produce an executable provider-lane disable and atomic digest-switch runbook. No rebuild or mutable retag is allowed during rollback. Record that switching to the pre-change digest intentionally restores the current MaxAI-era behavior in which UC is absent.
- On a rollback, retain the failed candidate digest and redacted diagnostics, then rerun the provider-aware readiness matrix after the switch.

**Exit:** old and new runtime contracts are compatible, rollback works offline, state and credential-writer isolation are proven, no irreversible migration exists, and operators can disable a lane and switch digests before a canary starts.

### G8 — private blue/green readiness

**Work and output**

- Start the candidate digest on separate loopback/private ports and isolated writable state while production is untouched and provider egress remains blocked.
- Emit a provider/capability readiness matrix with `artifact_ready`, `route_ready`, `enablement_ready`, `credential_ready`, `offline_ready`, `live_canary_ready`, and `operational_ready`. Each value has a safe reason code, evidence hash, and timestamp.
- Prove credential-schema compatibility and a sole-writer or isolated-canary strategy without printing values.

**Expected state at exit**

- Persona: artifact/route/offline ready; master/canary OFF; manual-only; credential/live/operational readiness false; media/video sub-gates independently false until cleared; speech is policy-disabled.
- Direct: route, enablement, credential, live, and operational readiness false with `POLICY_DISABLED`.
- MaxAI: artifact/route/offline ready; `enablement_ready=false` while egress and G9 are blocked; credential/live/operational readiness false; its general-default role is not promoted by generic health.

**Exit:** the isolated candidate is healthy offline, egress counters remain zero, the readiness matrix matches policy, and rollback remains immediately executable.

## 13. G9–G10 — later live canary and promotion

*Control: `[POLICY/HIGH]` — reconciliation plan §9 and §§11–12; `workers/residential-operations.md` §§3–7. No live evidence is created or authorized by this roadmap.*

G8 does not authorize G9. A named owner must approve an expiring envelope containing the exact commit/digest, provider, dedicated account/connection, sole credential writer, capability/model, prompt and attachment hashes, hosts/methods, total transaction count, cost/quota ceiling, timeout/pacing, persistence permission, observation window, stop rules, SLO thresholds, rollback consequence, and promotion authority. A named human starts the run, remains present, and closes it. UC Direct is ineligible.

### Conservative canary defaults

- Confirm provider terms, account use, endpoint, client, content, and automation are allowed. If unclear, keep the provider disabled.
- Installation-local canary policy uses one stable, owned or expressly authorized residential route per account. This is not a public claim that the provider requires residential egress. Attest it from the same namespace and selected connector. Record only a route-policy ID, ASN/class, and salted IP hash. Do not rotate routes or identities.
- One active operation per account, one upstream transaction in flight, and one active transaction across the shared validation exit. Manual validation queue depth is zero. If routine interactive service is later approved, allow at most one visible, expiring, cancellable pending request per account and reject the rest locally.
- Missing budget means zero calls. Start with one useful human-reviewed text task, one account, one model, one generation, no attachment, tool, continuation, refresh, discovery, or retry. Count every dispatched or uncertain subtransaction.
- Use a conservative 30-second completion-to-next-dispatch floor for the same account/shared exit. A required short-lived protocol leg may run promptly only when it was declared in the exact graph. Optional 0–5 s load-smoothing jitter must never imitate human behavior.
- Pause or drain health checks, discovery, refresh, recovery, scheduled probes, media pollers, retries, combo fallbacks, and every other background caller. Enforce the approved host/method/count envelope at egress.
- Use genuine prompts. Do not send synthetic exact-output probes, obfuscate content, or create “human-looking” prompt banks.

### Canary order

1. One minimal UC Persona text request.
2. Only separately approved Persona tool, attachment, image, or video requests, one capability envelope at a time. UC speech is ineligible.
3. One minimal MaxAI text request.
4. Only separately approved MaxAI discovery/refresh, document/PDF, image, or STT requests, one capability envelope at a time.
5. No Direct request and no parallel/spill request in this release.
6. After every canary or capability expansion, close admission and run a post-run drain: inspect the budget ledger, queues, workers, sockets, and provider-call records; require zero late retry, refresh, health, poll, upload, or other transaction.

The operations report defines **L8 smoke** and **L9 drain** as local controls inside reconciliation G9. They are distinct from reconciliation G8 private readiness and G10 promotion.

Stop admission, abort work, and require new approval on route drift, unknown background traffic, uncertain transaction count, human departure, credential mutation outside scope, 401/403/418/429/paywall/challenge, first unexpected 5xx/timeout/abnormal close/empty or malformed terminal result, failed cancellation, secret/private-data logging, or an upload followed by later failure. A stop never authorizes retry, account/route rotation, prompt alteration, or Direct fallback.

**G9 output and exit:** preserve the approved manifest, hard-counter ledger, safe response metadata, route attestation, stop decisions, and post-run drain report. The gate passes only when the recognized terminal result and ledger equal the exact approved graph and no late refresh, retry, poll, upload, or health call appears. One provider/capability pass does not clear another.

G10 promotes the **same digest** only after provider-specific success, error, latency, refresh, quota, and zero-security-violation thresholds pass for the approved observation window. Promotion order is operator-only/manual route, then a small allowlisted cohort, then intended routing. Persona remains manual-only. MaxAI becomes the normal general default only after MaxAI's own gate passes. **G10 output and exit:** archive the final support/readiness/rollback matrix and only close the release when the chosen thresholds pass with routing and credential invariants unchanged.

## 14. Optional track O1 — MaxAI parallel coordinator

*Evidence/design: `[HISTORICAL/HIGH, BOUNDARY-LIMITED]` and `[PROPOSED]` — `workers/maxai-parallel-lanes.md` §§“Scope and verdict,” “What is missing,” and “Recommended implementation and validation slice.”*

This is not part of the core candidate and must not delay or weaken G0–G10. Build it later in an isolated PR/release only after a product/privacy decision, provider/terms basis, threat model, and separate live approval.

### Narrow first slice

- Default OFF. Track at most 30 **logical** lane records only if the product needs that many; this is not 30 simultaneous provider calls.
- Start with an account-scoped active cap of 2. Do not encode six or 30 as the provider maximum: native UI evidence stops at six, while separate historical host execution is recovered at seven and twelve and has a configurable 30 ceiling. The current live-operations policy still prohibits parallel provider validation.
- Persist safe host `run_id`/`lane_id`, order, parent, attempt, selected account hash, requested/resolved/returned model, request-scoped provider conversation/response IDs, timestamps, and terminal state. Never call a request UUID a durable provider conversation.
- Keep separate history, parser, reasoning field, tool-call IDs, abort controller, working directory, and permission scope per lane. Preserve deterministic result order independent of completion order.
- Add account-scoped admission, byte-weighted memory and queue limits, fairness, queue/execution deadlines, transaction/time budgets, circuit breakers, restart recovery, and cancellation to in-flight work.
- Keep tools synthetic/local and side-effect free until the core nonce/name/schema contract is complete. Keep context spill independently gated and OFF.

### Offline acceptance

- Reproduce six mocked executor calls reaching a barrier and completing in reverse order with no cross-lane data.
- Stress 30 logical lanes behind active-cap 2. Prove no more than two mock upstream calls are active, memory stays below a declared G0 value, fairness holds, and every durable record reaches one terminal state.
- Inject auth/rate/5xx, malformed SSE, wrong model, timeout, cancellation at every phase, worker death, restart, and duplicate delivery.
- Test reasoning-tag splits and absence, reply-all, selected continuation, restart/resume, and isolation of answers, reasoning, IDs, tools, files, and histories.

**Exit:** offline coordinator tests pass and the feature remains OFF. The current operations policy prohibits parallel provider calls. Any live staircase first requires a reviewed policy revision plus a new envelope: two lanes first, then separately 3, 4, and 6 with cooldown and stop rules. Only after those pass may separately authorized 7- and 12-seat reproductions use the recovered aggregate history as test input. The exact 30/32 per-request trace remains missing, so no jump to 30 is allowed; any larger step requires explicit provider authorization and new load/privacy/security review.

Context spill is a different optional project. It requires per-request consent, a retention/deletion design, non-linkable naming, account-pinned admission, and explicit disclosure that a full conversation may be stored remotely. Do not bundle it with the coordinator.

## 15. Current blockers and stop points

### Blocks G0/G1 now

1. The concern ledger and defaults registry do not yet exist as frozen implementation artifacts.
2. UC video/reset/cache, MaxAI STT, worker-admission, endpoint-response, and request-body-alignment values listed in §4 still need implementation/security decisions and synthetic measurements. UC speech is deferred and needs no target constants.
3. No accepted G1 candidate, revalidated public anchor/ancestry-equivalence/PR-diff record, or accepted baseline manifest exists. A preparatory clean clone exists, but it contains no reconciled provider changes and is not G1 evidence.

### Blocks feature enablement

1. There is no reconciled candidate. The present runtime has no UC implementation, and its MaxAI tree is not a clean combined source boundary.
2. UC video remains OFF until capture-backed controls pass. UC speech remains policy-disabled. Persona discovery refresh remains OFF until safe application material and authorization exist.
3. MaxAI STT remains OFF until one effective body/file cap and bounded-memory path exist.
4. MaxAI live enablement remains false if the required client behavior would amount to unauthorized fingerprint impersonation. Written provider-permitted compatibility scope is required; no fallback is allowed.
5. UC file types beyond capture-backed PDF/PNG and MaxAI types beyond their evidence tier cannot be advertised as provider-proven.

### Blocks live use and promotion

1. G0–G8 have not run. No historical test, image label, generic health result, or old live success can waive them.
2. No G9 live envelope, terms/client authorization record, immutable candidate digest, isolated credential-writer plan, daily cap, cost limit, or provider-specific SLO threshold is approved.
3. Parallel and context spill have no core scope or live authorization. UC Direct is not eligible for one under this roadmap.

## 16. Definition of done

The reconciliation is complete only when G0–G8 pass on one exact clean candidate, the combined artifact is pinned by digest, rollback is rehearsed, provider-aware readiness is truthful, and separately approved G9/G10 canaries and observation gates pass without changing routing policy. Until then, the accurate release statement is:

> UC Persona implementation is the priority, but it remains manual and disabled; MaxAI is the intended general route only after its own readiness; UC Direct is disabled; no combined release is ready.

## 17. Evidence basis

This roadmap is derived from the audited reconciliation plan/checklist, capability matrix, UC and MaxAI source reviews, final audit summary, and the focused worker reports on gates, prompt/files/media, Persona discovery, MaxAI lanes, and residential operations. Use those artifacts for exact lineage and forensic citations. Use this document for execution order, outputs, and exit criteria.
