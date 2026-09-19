# G0–G8 implementation and release-readiness backlog

**Scope.** This is a read-only synthesis of the unimplemented or not-yet-concluded work in gates G0–G8. It does not claim that any port, build, test, image, migration, canary start, or live provider call occurred.

**Owner scope override:** `plans/OWNER-SCOPE-OVERRIDES.json` supersedes the initial audit where noted. UC TTS and STT are deferred/OFF; their old positive implementation checks become negative zero-transport policy checks.

## Executive result

**Current state: all 69 required G0–G8 pre-live checks are `not_started`; the full G0–G10 checklist has 77 required checks.** The machine checklist is explicitly `planning_only`, with `no_implementation_performed=true`, `no_build_or_test_performed=true`, and `no_live_provider_call_performed=true`. This is **high-strength evidence** from the exact checklist artifact, not an inference. The plan hash recorded by that checklist matches the audited plan: `8205901ef422d9eb17756fdd7483e642b395c371df8595ae172d53297f6a43c4`.

**G1 ancestry correction (current source-copy v5):** `12983c899...` is a pre-rewrite provenance commit and is intentionally **not** in target ancestry. The corrected checklist has ten real required ancestors plus one `required_behavior_equivalences` record. G1 must verify the MaxAI 300,000 ms admission-floor behavior in current `rateLimitManager.ts` and its admission-control test, and separately verify both archived PR diff hashes. Any earlier “every repair SHA” wording below is superseded by this correction.

The most important blockers are:

1. **G0 is not formally frozen.** The policy defaults are decided, but the concern ledger is not frozen. UC attachment/video/reset and MaxAI STT/PDF/resource controls still need recorded implementation-security values. UC speech is excluded and needs no caps.
2. **There is no accepted G1 candidate.** A preparatory isolated clone exists, but G1 ancestry, behavior-equivalence, PR-diff, baseline-manifest, and concern-ledger evidence has not been accepted; no provider port exists there.
3. **UC Persona is not implemented in the current live artifact.** Direct runtime evidence found zero of 20 audited UC files. All Persona auth, alias/migration, chat/tool, one-attachment, media/video, quota, cancellation, enablement, Direct-negative, and speech-negative work remains.
4. **MaxAI's recovered behavior is not release-safe as-is.** Atomic credential rotation, bounded signer recovery, strict tool authorization, terminal SSE errors, STT auth/body bounds, final-v8 PDF/resource admission, bounded response reads, incremental upload SSE, and fail-closed selected egress remain mandatory.
5. **No fresh release evidence exists.** Whole-tree offline validation, an immutable combined image, rollback rehearsal, and an egress-blocked private blue/green start are all absent.

**Approval result.** No new product decision and no live-call approval is required to complete G0–G8 under the reviewed defaults. Implementation, security, review, and operations sign-off are required where marked. Any deviation, reopening of UC Direct, or optional overflow/parallel work needs a new product/privacy decision. Live provider traffic is a separate G9 approval and is not authorized here.

**Primary evidence:**

- `audit-source/RECONCILIATION-PLAN.md` §§4–12, especially §11 “Phase gates” and §12 “Resolved defaults and remaining user approval.”
- `audit-source/RECONCILIATION-CHECKLIST.json` (`state`, `safety`, `gates[G0..G8]`, `implementation_defaults`, resource-policy objects).
- `audit-source/CAPABILITY-MATRIX.md` executive verdict, highest-severity findings, and actionable delta registry; exact delta IDs also exist in `CAPABILITY-MATRIX.json`.
- `audit-source/UC-SOURCE-REVIEW.md` concern-port map, TTS review, and unresolved-signoff sections; exact records are in `UC-SOURCE-REVIEW.json`.
- `audit-source/MAXAI-SOURCE-REVIEW.md` must-port, blocking, optional/reject, and unresolved sections; exact records are in `MAXAI-SOURCE-REVIEW.json`.

Evidence-strength labels used below follow `CAPABILITY-MATRIX.md` lines 39–49. “High” means an exact artifact/commit/blob/patch/hash/test or direct read-only runtime observation. It does **not** mean the pending work has been implemented.

## Approval legend

- **I** — implementation/release-engineering review or sign-off.
- **I/security** — implementation plus security/resource review.
- **I/ops** — implementation plus operations/release readiness.
- **P** — a new owner/product/privacy decision. The settled core needs none unless it deviates from the plan.
- **L** — explicit authorization for live provider calls. G0–G8 require none and must keep provider egress blocked.

## Gate-by-gate backlog

Every checklist ID below is reproduced exactly once. The “remaining work” column faithfully summarizes `RECONCILIATION-CHECKLIST.json::gates[].checks[]`; the proof column explains what a reviewer must be able to observe. G0-01, G0-03, and G1-03 include the later v4 parity/ancestry clarifications rather than verbatim older text.

### G0 — scope and default freeze

**Gate state:** `not_started` (**high**; exact checklist state). **Gate exit:** implementation defaults and concern ledger are frozen. **Gate dependency:** none. **Live calls:** forbidden. Source: `RECONCILIATION-PLAN.md` phase-gate row `G0` and `RECONCILIATION-CHECKLIST.json::gates[id=G0]`.

| Item | Current status / strength | Exact remaining work | Dependencies | Observable completion proof | Approval |
|---|---|---|---|---|---|
| `G0-01` | **NOT STARTED** / high | Reviewed defaults, including Persona master/media/video/discovery gates starting OFF and UC speech policy-disabled, are recorded exactly; deviations require a new scope decision, threat review, and tests. | None | Versioned defaults, gate inventory, and speech exclusion match the project override; every deviation has a linked decision and tests. | I: yes; P only for deviation; L: no |
| `G0-02` | **NOT STARTED** / high | Concern ledger is frozen; Direct exclusion and optional overflow/parallel defer are recorded. | G0-01 | Frozen concern ledger hash lists every concern and disposition, including Direct=`rejected/historical` and overflow/parallel=`deferred/off`. | I: yes; P only to reverse settled exclusions; L: no |
| `G0-03` | **NOT STARTED** / high | Assign mandatory pre-enable controls: UC attachment MIME/body, video ranges, reset/cache; MaxAI STT/proxy body/chunking, PDF/tokenizer admission/resources/raw/page/object limits, response caps, and document ingress/overflow. UC speech needs no caps because it is excluded. | G0-01; implementation security review | Security record names every in-scope value and the same values appear in code, registry/docs, and exact-boundary tests; speech exclusion is recorded. | I/security: yes; P: no; L: no |

### G1 — clean current anchor

**Gate state:** `not_started` (**high**; exact checklist state). **Gate exit:** exact clean lineage is proven. **Gate dependency:** G0. **Live calls:** forbidden. Source: `RECONCILIATION-PLAN.md` phase-gate row `G1` and `RECONCILIATION-CHECKLIST.json::gates[id=G1]`.

| Item | Current status / strength | Exact remaining work | Dependencies | Observable completion proof | Approval |
|---|---|---|---|---|---|
| `G1-01` | **NOT STARTED** / high | Fresh public head is frozen and any delta after 949235736042b13cf64215632e6d44db7985af76 is reviewed for overlap. | G0 | Recorded fresh public HEAD and reviewed diff from `949235736042b13cf64215632e6d44db7985af76`; every overlapping file is dispositioned. | I/ops: yes; P: no; L: no |
| `G1-02` | **NOT STARTED** / high | Disposable clone HEAD equals approved SHA; remote identity is reviewed; status/index/untracked set is clean. | G1-01 | Command transcript records remote URL, exact HEAD, empty porcelain status, empty staged/index diff, and no untracked files. | I/ops: yes; P: no; L: no |
| `G1-03` | **NOT STARTED** / high | Every SHA in `landing_lineage.required_ancestors` is an ancestor; provenance-only behavior equivalences pass target source/tests; both archived PR diff hashes match. | G1-02 | Ten ancestry checks pass; `12983c899...` is correctly absent but its 300,000 ms MaxAI/`mx` admission behavior and distinct execution backstop are asserted in current source/tests; both PR diff hashes verify. | I/ops: yes; P: no; L: no |
| `G1-04` | **NOT STARTED** / high | Baseline source/lockfile/generated manifest is hashed. | G1-02 | Signed/hashed baseline manifest covers source, lockfile, and generated files before any port. | I/ops: yes; P: no; L: no |
| `G1-05` | **NOT STARTED** / high | Workspace is not any forbidden existing path and shares no active worktree. | G0; before clone | Recorded realpath/worktree list proves a new disposable clone, outside both forbidden paths and all active linked worktrees. | I/ops: yes; P: no; L: no |

### G2 — shared invariants

**Gate state:** `not_started` (**high**; exact checklist state). **Gate exit:** shared safety invariants pass before provider ports. **Gate dependency:** G1. **Live calls:** forbidden. Source: `RECONCILIATION-PLAN.md` phase-gate row `G2` and `RECONCILIATION-CHECKLIST.json::gates[id=G2]`.

| Item | Current status / strength | Exact remaining work | Dependencies | Observable completion proof | Approval |
|---|---|---|---|---|---|
| `G2-01` | **NOT STARTED** / high | 838fc00 queue wait/execution separation is unchanged and named correctly in code/tests/docs. | G1 | Existing two timeout tests plus code/docs review show queue `maxWaitMs` and post-dispatch `executionMaxWaitMs` remain distinct. | I/ops: yes; P: no; L: no |
| `G2-02` | **NOT STARTED** / high | 239d8fc credential separation and current management authorization remain. | G1 | Credential contract/authorization tests pass; secret scan shows no cross-provider field read, write, log, or forwarding. | I/ops: yes; P: no; L: no |
| `G2-03` | **NOT STARTED** / high | Routing/identity is frozen by owner evidence: MaxAI general default after readiness; Persona canonical id=uc-persona, legacy aliases uc+ucn, display UC Persona / Emotional, route uc-persona-manual, manual-only/non-fallback and enablement OFF; Direct id=uc-direct is hard-disabled/ineligible. | G0, G1 | Registry/route/enablement contract tests prove exact IDs, aliases, display, manual route, defaults, and Direct ineligibility. | I: yes; P only for policy deviation; L: no |
| `G2-04` | **NOT STARTED** / high | Every donor change has a concern record and upstream-overlap review. | G0 ledger, G1 hashes | One complete record per donor concern with target/donor hashes, overlap analysis, security/tests, revert boundary, reviewer, and disposition. | I/ops: yes; P: no; L: no |
| `G2-05` | **NOT STARTED** / high | 12983c899 MaxAI/mx 300000 ms floor remains queue-admission policy only; execution uses distinct 838fc00 backstop. | G2-01 | MaxAI slow-execution and queue-saturation tests prove 300000 ms is admission only and execution uses the separate backstop. | I/ops: yes; P: no; L: no |
| `G2-06` | **NOT STARTED** / high | 752aac65 image-registry order is preserved: UC remains after existing providers and bare nano-banana/z-image-turbo ownership is unchanged. | G1; upstream `752aac65...` | Registry tests prove UC ordering remains after existing providers and duplicate bare IDs retain their prior owners. | I/ops: yes; P: no; L: no |

### G3 — UC Persona priority slice

**Gate state:** `not_started` (**high**; exact checklist state). **Gate exit:** UC Persona offline core is green and Direct is off. **Gate dependency:** G2. **Live calls:** forbidden. Source: `RECONCILIATION-PLAN.md` phase-gate row `G3` and `RECONCILIATION-CHECKLIST.json::gates[id=G3]`.

| Item | Current status / strength | Exact remaining work | Dependencies | Observable completion proof | Approval |
|---|---|---|---|---|---|
| `G3-01` | **NOT STARTED** / high | Persona auth/session, chat/stream/tools, guarded media, image-to-video, quota/error, retry/cancel concerns are ported by hunk; speech remains excluded. | G2 | Reviewed concern commits plus green Persona fixtures cover in-scope behavior; speech routes remain policy-disabled before transport. | I/ops: yes; P: no; L: no |
| `G3-02` | **NOT STARTED** / high | Owner override replaces TTS porting with negative speech closure. | G3-01; owner D3 | TTS and STT routes reject with policy-disabled before HTTP/WebSocket/provider transport; transaction counter stays zero. | I/ops: yes; P: no; L: no |
| `G3-03` | **NOT STARTED** / high | UC Direct is disabled/ineligible and no new Direct feature concern was imported. | G2-03 | Negative registry/login/connection/routing tests prove no Direct onboarding, credential creation, normal flag, or eligible route. | I: yes; P only to reopen Direct; L: no |
| `G3-04` | **NOT STARTED** / high | All UC, Direct-negative, SSRF/header, cancellation, alias, and provider-level timeout tests pass with provider egress denied. | G3-01..03 | All named UC/Direct-negative/SSRF/header/cancel/alias/timeout suites pass under a network-deny harness with zero DNS/socket attempts. | I/ops: yes; P: no; L: no |
| `G3-05` | **NOT STARTED** / high | UC named timeout/poll/blob defaults and 64 MiB per-item inline-media cap pass exact boundary tests; none is queue maxWaitMs. | G0 defaults; G3-01 | Exact-value and ±1 boundary tests pass for all named UC timeout/poll/blob constants and the 67,108,864-byte per-item cap. | I/ops: yes; P: no; L: no |
| `G3-06` | **NOT STARTED** / high | Persona master/canary OFF rejects before transport; ON does not add Persona to automatic/default/fallback pools; media/video gates reject independently; speech is permanently policy-disabled for this release. | G2-03; G3-01 | Transport spies remain zero for disabled gates; speech routes remain zero-transport under every gate state. | I/ops: yes; P: no; L: no |
| `G3-07` | **NOT STARTED** / high | Owner override removes positive TTS decoder work from core. | G3-02 | Negative route tests prove no TTS decode/allocation/socket/provider action occurs; historical TTS artifacts remain provenance only. | I/security: yes; P: no; L: no |
| `G3-08` | **NOT STARTED** / high | Import/seed-only onboarding is enforced; email-code onboarding and automatic stale-row migration are unreachable. | G2-03; G3-01 | API/route tests show only protected import/seed; email-code and implicit stale-row migration routes are unreachable. | I/ops: yes; P: no; L: no |
| `G3-09` | **NOT STARTED** / high | Canonical uc-persona and legacy uc/ucn resolve consistently through provider/model/image/video/audio/catalog/executor/login/credential/media-prefix and DB lookup; explicit uc-row migration is dry-run, transactional, idempotent, rollback-tested, and secret-safe. | G2-03; protected backup design | All cross-surface lookups pass for `uc-persona`,`uc`,`ucn`; migration dry-run, commit, repeat, failure rollback, and secret-scan fixtures pass. | I/ops: yes; P: no; L: no |
| `G3-10` | **NOT STARTED** / high | Persona code-style tool parsing is allowlisted and accepts only a declared-call-only whole response; mixed prose and heuristic refusal auto-cure never trigger a second generation or consume another quota unit. | G3-01 | Parser fixtures accept only a complete allowlisted declared-call response; prose/mixed/refusal fixtures cause zero second generation. | I/ops: yes; P: no; L: no |
| `G3-11` | **NOT STARTED** / high | Persona versus Direct media dispatch uses only canonical resolved provider identity; API-key prefixes cannot cross-route Persona into paid Direct, whose media registries remain unreachable. | G2-03; G3-01 | Dispatch tests vary misleading API-key prefixes but always select by resolved provider ID; Direct media registry lookup always fails. | I/ops: yes; P: no; L: no |
| `G3-12` | **NOT STARTED** / high | Persona video frame count, FPS, inference steps, duration, scale, resolution, and polling controls are clamped to capture-backed enums/ranges with boundary and rejection tests. | capture-backed parameter review; G3-01 | A recorded capture-derived parameter table exists; each accepted boundary and every out-of-range video/poll input has a pass/reject test. | I/ops: yes; P: no; L: no |
| `G3-13` | **NOT STARTED** / high | UC next_reset parsing accepts only documented formats within a finite future horizon; the per-SID cooldown cache is bounded/evicted and explicitly non-durable. | G3-01 | Seconds/ms/date fixtures, past/far-future/nonfinite rejection, cache size/eviction, and restart/non-durability tests pass. | I/ops: yes; P: no; L: no |
| `G3-14` | **NOT STARTED** / high | A connection that requires a proxy fails closed when proxy lookup/assignment fails; no direct-egress fallback occurs. | G2; selected-connection policy | Proxy-required lookup/assignment failure returns before network; direct path works only for an explicit reviewed no-proxy assignment. | I/ops: yes; P: no; L: no |
| `G3-15` | **NOT STARTED** / high | UC speech is not eligible for error-mapping or live behavior in this release. | G3-02 | Known/unknown TTS/STT requests uniformly fail policy-disabled before transport and never consume credits. | I/ops: yes; P: no; L: no |

### G4 — MaxAI core slice

**Gate state:** `not_started` (**high**; exact checklist state). **Gate exit:** MaxAI offline core is green. **Gate dependency:** G3. **Live calls:** forbidden. Source: `RECONCILIATION-PLAN.md` phase-gate row `G4` and `RECONCILIATION-CHECKLIST.json::gates[id=G4]`.

| Item | Current status / strength | Exact remaining work | Dependencies | Observable completion proof | Approval |
|---|---|---|---|---|---|
| `G4-01` | **NOT STARTED** / high | Refresh and rotated-credential persistence are atomic across apiKey/accessToken/refresh/device/user/provider-specific fields; caller abort or persist failure exposes no mixed generation. Selected transport, retry media preservation, and cancellation are ported by concern. | G3; G2 credential invariant | Concurrency/abort/persist-failure tests prove one atomic credential generation across every field; transport/retry/cancel fixtures pass. | I/ops: yes; P: no; L: no |
| `G4-02` | **NOT STARTED** / high | Strict/fail-closed docs retain 64 MiB decode guard, count 5, image 10 MiB/PDF 48 MiB/other 20 MiB, conservative separate 64 MiB aggregate decoded cap, all-item prevalidation before first upload, global worker admission/resource limits, and URL/error hygiene. | G3; G0 resource policy | Boundary, all-item prevalidation, aggregate, worker-admission, URL/error, malformed/bomb/parallel/abort tests all pass with exact limits. | I/security: yes; P: no; L: no |
| `G4-03` | **NOT STARTED** / high | MaxAI STT ingress safety and full final-v8 bounded response/upload/PDF/tokenizer/runtime layer pass offline tests; final2 encoder.encode(text, [], []) fix is ported independently of spill/parallel. | G0-03; G4-02, G4-09, G4-10, G4-13, G4-19 | STT ingress/response and final-v8 packaged PDF/runtime suites pass; tokenizer literal-special-token regression passes without spill/parallel code enabled. | I/security: yes; P: no; L: no |
| `G4-04` | **NOT STARTED** / high | Unbiased nonce and credential separation survive every port. | G2-02; upstream `e243b04d...` | Statistical/deterministic nonce tests and credential-separation tests pass on the final merged tree. | I/ops: yes; P: no; L: no |
| `G4-05` | **NOT STARTED** / high | Unsupported/deferred claims remain absent and optional overflow/parallel remains off. | G0-02 | Capability/route/docs negative assertions show no overflow/parallel, TTS, video, quota API, self-heal, required-residential, or 13/13 claims. | I: yes; P only to opt into deferred features; L: no |
| `G4-06` | **NOT STARTED** / high | Email-code request/verify and model discovery propagate incoming aborts, use bounded timeouts, and have deterministic abort/timeout tests. | G4-01; selected transport | Fake delayed/hung email request, email verify, and discovery calls abort/timeout deterministically and leave no background work. | I/ops: yes; P: no; L: no |
| `G4-07` | **NOT STARTED** / high | One narrowly signature-shaped rejection forces re-extraction then at most one retry; non-signature and second failures never loop. | G4-17 design | Fixtures show exactly one forced extraction/retry only for the narrow signature error; other/second failures make no retry. | I/ops: yes; P: no; L: no |
| `G4-08` | **NOT STARTED** / high | Dirty maxai-refresh cleanup paths have explicit port/defer disposition and no false captured signer-vector prose is imported. | G0 ledger | Ledger records `ported` or `deferred` for each of the three cleanup files; scans find no false signer-vector prose/stale suppression. | I/ops: yes; P: no; L: no |
| `G4-09` | **NOT STARTED** / high | STT authenticates/admission-checks before parsing; advertised limit equals effective MAXAI_STT_UPLOAD_MAX_BYTES and is not 2 GB; proxy/body and actual file caps cannot be bypassed by absent/false Content-Length or chunking; oversized cases make zero provider calls and peak memory is bounded. | G0-03; G4-06 | Route tests prove auth before parse; proxy/header/file/chunked paths enforce one recorded cap; advertisements match; oversize yields zero provider calls and bounded peak memory. | I/security: yes; P: no; L: no |
| `G4-10` | **NOT STARTED** / high | PDF/tokenizer global concurrency/queue and worker resource limits survive malformed, decompression-bomb, parallel, saturation, abort, and cleanup tests. | G4-02; explicit admission values | Configured global/queue/worker limits reject saturation before spawn and survive malformed/bomb/parallel/abort/cleanup tests. | I/security: yes; P: no; L: no |
| `G4-11` | **NOT STARTED** / high | All documents are decoded/classified/prevalidated before the first remote upload; any local validation/parse failure causes zero provider uploads. | G4-02 | A bad final item in a multi-document request causes zero upload calls; all metadata/token/type/aggregate decisions complete before upload 1. | I/ops: yes; P: no; L: no |
| `G4-12` | **NOT STARTED** / high | A deterministic later-remote-upload or post-upload chat failure sends no chat but may leave earlier successful remote uploads; this non-atomic retention is tested and documented because no delete/transaction API was recovered. | G4-11 | Deterministic remote failure fixture records an earlier orphan upload, sends no chat, and docs state no recovered delete/transaction API. | I/ops: yes; P: no; L: no |
| `G4-13` | **NOT STARTED** / high | Model, image, upload, and STT response bodies are read through endpoint-specific byte-bounded cancellable helpers; over-limit bodies return typed sanitized errors without unbounded response.text() buffering or raw-body logging. | G4-06; endpoint cap policy | Endpoint-specific over-limit/abort tests for model/image/upload/STT return typed sanitized errors; memory/log assertions show no full body retained. | I/security: yes; P: no; L: no |
| `G4-14` | **NOT STARTED** / high | Prompted tool calls use a cryptographically random per-request nonce with mandatory exact presence/equality and an exact requested-name allowlist plus arguments-schema validation; weak/missing/wrong/replayed nonces, unrequested or normalized-collision names, mixed prose, and malformed args fail closed. | G2 security invariant | Copy/replay/wrong/missing nonce, unknown/colliding name, mixed prose, bad schema, oversized/many calls all fail closed; valid two-leg tool test passes. | I/ops: yes; P: no; L: no |
| `G4-15` | **NOT STARTED** / high | Captured HTTP-200 paywall/quota/auth/terminal-error and null-body SSE fixtures return typed sanitized non-success, never empty HTTP-200 completions. | G4 chat parser | Captured compact/expanded paywall/quota/auth/terminal/null-body fixtures return typed non-2xx errors and never an empty successful completion. | I/ops: yes; P: no; L: no |
| `G4-16` | **NOT STARTED** / high | MaxAI import requires a structured validated credential tuple; the generic one-string token copy path is absent or rejected. | G4-01 | Import route rejects one-string input and accepts only a fully validated structured tuple before persistence. | I/ops: yes; P: no; L: no |
| `G4-17` | **NOT STARTED** / high | Signer discovery uses bounded scanning, caller-abort isolation, strong proof, last-known-good rollback and TTL/invalidation; one signature-shaped 401/418 forces at most one retry. | G4-01; upstream dynamic discovery | Bounded scan/TTL/invalidation/LKG rollback/caller-abort/coalescing tests pass; one changed-generation signature retry is the maximum. | I/ops: yes; P: no; L: no |
| `G4-18` | **NOT STARTED** / high | All direct/env/NO_PROXY/edge-relay/nested provider-account transport branches preserve selected fail-closed egress; a transport fast-fail aborts any already-dispatched signed request. | G0 Firefox policy; G4-06 | Direct/env/NO_PROXY/relay/nested-context matrix proves selected Firefox-150/wreq egress or fail-closed 503; fast-fail makes fake upstream observe abort. | I/ops: yes; P: no; L: no |
| `G4-19` | **NOT STARTED** / high | Upload SSE parsing is incremental and bounded under tiny chunks; successful STT status without speech_text is a typed failure, not empty success. | G4-02, G4-09, G4-13 | One-byte-chunk upload SSE test stays linear/bounded and stops at terminal; missing `speech_text` success fixture returns typed failure. | I/ops: yes; P: no; L: no |

### G5 — whole-tree offline release

**Gate state:** `not_started` (**high**; exact checklist state). **Gate exit:** complete offline release evidence is green. **Gate dependency:** G4. **Live calls:** forbidden. Source: `RECONCILIATION-PLAN.md` phase-gate row `G5` and `RECONCILIATION-CHECKLIST.json::gates[id=G5]`.

| Item | Current status / strength | Exact remaining work | Dependencies | Observable completion proof | Approval |
|---|---|---|---|---|---|
| `G5-01` | **NOT STARTED** / high | All required unit/integration, provider, timeout, typecheck, lint/format, dependency, docs/count/quality, and production/standalone build gates pass. | G4 | One evidence bundle shows every required suite, typecheck, lint/format, dependency, generated check, production and standalone build green. | I/ops: yes; P: no; L: no |
| `G5-02` | **NOT STARTED** / high | Tests ran with provider egress denied; unexpected DNS/socket use is zero. | G5-01 harness | Network-deny logs/counters show zero provider DNS/socket traffic for every test/build command. | I/ops: yes; P: no; L: no |
| `G5-03` | **NOT STARTED** / high | Generated files were regenerated on target, not copied from donors. | G4 final tree | Clean-tree regeneration commands and diffs prove generated files derive from the candidate, not donor bytes. | I/ops: yes; P: no; L: no |
| `G5-04` | **NOT STARTED** / high | Source/test/build/image/SBOM/log/report secret scans have zero unresolved findings. | G5-01..03 | Zero unresolved secret findings across source, fixtures, build context, OCI layers/config/history, SBOM, logs, and reports. | I/security/reviewer: yes; P: no; L: no |
| `G5-05` | **NOT STARTED** / high | Independent diff/security review approves exact concern manifest and tree is clean. | G5-01..04 | Independent reviewer signs exact diff/concern-manifest hashes; final source status is clean. | I/security/reviewer: yes; P: no; L: no |
| `G5-06` | **NOT STARTED** / high | Every test/build record includes command, versions, non-secret environment, source/fixture hashes, timing, exit code, and output hash. | applies to every G5 command | Machine-readable record for every command contains versions, safe environment, hashes, timestamps, exit code, and output digest. | I/ops: yes; P: no; L: no |

### G6 — immutable artifact

**Gate state:** `not_started` (**high**; exact checklist state). **Gate exit:** content-addressed artifact is immutable and provenance-verified. **Gate dependency:** G5. **Live calls:** forbidden. Source: `RECONCILIATION-PLAN.md` phase-gate row `G6` and `RECONCILIATION-CHECKLIST.json::gates[id=G6]`.

| Item | Current status / strength | Exact remaining work | Dependencies | Observable completion proof | Approval |
|---|---|---|---|---|---|
| `G6-01` | **NOT STARTED** / high | One promoted release artifact from the exact clean candidate has a unique tag with enforced immutability/retention and a recorded repository digest; no bit-reproducibility claim is made without a second isolated matching build. | G5 | Registry proves unique immutable tag/retention and resolves it to the recorded digest built from the exact clean commit. | I/ops: yes; P: no; L: no |
| `G6-02` | **NOT STARTED** / high | OCI metadata records dirty=false, anchor, PR squashes, concern/test/lock/SBOM hashes without secrets. | G6-01 | OCI labels/attestation/SBOM contain the required non-secret SHAs/hashes and `source.dirty=false`; secret scan is clean. | I/ops: yes; P: no; L: no |
| `G6-03` | **NOT STARTED** / high | Packaged manifest contains UC Persona and MaxAI assets, final-v8 runtime closure, and executionMaxWaitMs; Direct remains ineligible. | G6-01 | Packaged manifest/binary marker checks find Persona, MaxAI, final-v8 assets, and `executionMaxWaitMs`; Direct route probes fail. | I/ops: yes; P: no; L: no |
| `G6-04` | **NOT STARTED** / high | Offline packaged smoke tests pass by digest; no mutable base/latest tag is used. | G6-03 | All packaged offline smoke tests pass by `repository@sha256:...`; deployment/render scans find no `:base`/`:latest`. | I/ops: yes; P: no; L: no |
| `G6-05` | **NOT STARTED** / high | Candidate matches the non-secret linux/arm64 runtime contract: egress-wrapper entrypoint, secret mounts, /app/data behavior, Redis/Tailscale dependencies, health command, ports, and rendered service pinned to digest. | G6-01; current runtime-contract inventory | Recorded diff against deployed non-secret contract passes platform, wrapper, mounts, data, Redis/Tailscale, health, ports, and digest render. | I/ops: yes; P: no; L: no |

### G7 — rollback and runtime-contract readiness

**Gate state:** `not_started` (**high**; exact checklist state). **Gate exit:** rollback and runtime compatibility are proven before candidate start. **Gate dependency:** G6. **Live calls:** forbidden. Source: `RECONCILIATION-PLAN.md` phase-gate row `G7` and `RECONCILIATION-CHECKLIST.json::gates[id=G7]`.

| Item | Current status / strength | Exact remaining work | Dependencies | Observable completion proof | Approval |
|---|---|---|---|---|---|
| `G7-01` | **NOT STARTED** / high | Exact pre-change image is retained in a protected OCI archive or immutable registry reference, protected from GC, and its digest verifies after transfer. | G6; current pre-change digest | Protected archive/registry reference survives transfer and digest verification; retention/GC protection is recorded. | I/ops: yes; P: no; L: no |
| `G7-02` | **NOT STARTED** / high | Pre-change image starts on an alternate private port with provider egress blocked. | G7-01 | Pre-change digest starts on an alternate private port with provider egress blocked and passes local health/runtime checks. | I/ops: yes; P: no; L: no |
| `G7-03` | **NOT STARTED** / high | Encrypted/access-controlled state backup exists; canary has an isolated writable store and never shares production SQLite or /app/data. | G6; protected backup process | Restore-tested encrypted backup exists; mount/DB inode/path evidence proves canary and production writable state are isolated. | I/ops: yes; P: no; L: no |
| `G7-04` | **NOT STARTED** / high | No irreversible migration exists; explicit legacy uc -> uc-persona migration is backup/dry-run/transactional/idempotent/rollback-tested; prior binary compatibility and selective restore preserving valid token rotations are rehearsed. | G3-09; G7-03 | Migration rehearsal proves backup/dry-run/idempotence/failure rollback/old-binary read and a selective restore that keeps valid rotations. | I/ops: yes; P: no; L: no |
| `G7-05` | **NOT STARTED** / high | Non-secret runtime contract diff covers platform, entrypoint, mounts, data, Redis/Tailscale, health, ports, and digest-pinned service render. | G6-05 | Signed runtime-contract diff matches all listed dimensions and digest-pinned rendered service. | I/ops: yes; P: no; L: no |
| `G7-06` | **NOT STARTED** / high | Provider lane-disable and atomic digest rollback procedure are executable before canary. | G7-01..05 | Dry-run/runbook proves lane disable and atomic switch to retained digest are executable without rebuild or mutable retag. | I/ops: yes; P: no; L: no |

### G8 — private blue/green readiness

**Gate state:** `not_started` (**high**; exact checklist state). **Gate exit:** offline canary readiness is correct. **Gate dependency:** G7. **Live calls:** forbidden. Source: `RECONCILIATION-PLAN.md` phase-gate row `G8` and `RECONCILIATION-CHECKLIST.json::gates[id=G8]`.

| Item | Current status / strength | Exact remaining work | Dependencies | Observable completion proof | Approval |
|---|---|---|---|---|---|
| `G8-01` | **NOT STARTED** / high | Candidate starts on separate private ports against isolated writable state with production untouched and provider egress blocked. | G7 | Candidate digest starts on separate private/loopback ports, production remains unchanged, and egress deny counters stay zero. | I/ops: yes; P: no; L: no |
| `G8-02` | **NOT STARTED** / high | Per-provider artifact/route/credential/offline/live/operational readiness matrix emits safe reason codes and evidence hashes. | G6 evidence; G7 runtime readiness | Machine-readable matrix emits every dimension with safe reason code, evidence hash, timestamp, and no account/secret data. | I/ops: yes; P: no; L: no |
| `G8-03` | **NOT STARTED** / high | UC Persona route may be ready but master/canary enablement remains OFF; Direct reports POLICY_DISABLED; no generic health state overrides provider readiness. | G2-03; G8-02 | Matrix assertions show Persona enablement false, Direct `POLICY_DISABLED`, and generic health cannot promote either state. | I/ops: yes; P: no; L: no |
| `G8-04` | **NOT STARTED** / high | Credential schema compatibility and sole-writer strategy are proven without exposing values. | G4-01; G7-03, G7-04 | Schema read/write compatibility and an explicit sole-writer/isolated-canary strategy pass without printing credential values. | I/ops: yes; P: no; L: no |

## Reconciliation of the source reviews' open questions

The source reviews predate the final plan. Some questions are now policy-resolved but still unimplemented. Others still need an implementation-security value. The plan states that no additional product decision is needed before core implementation (`RECONCILIATION-PLAN.md` §12, “Resolved defaults and remaining user approval”).

### UC `U-01`–`U-10`

Source: `UC-SOURCE-REVIEW.json::unresolved_before_signoff` and `UC-SOURCE-REVIEW.md` lines 268–279. Evidence strength is **high** that these were open at source-review time and **high** for the later plan disposition.

| Source item | Current conclusion | Remaining work / gate | Approval |
|---|---|---|---|
| `U-01` UC speech bounds | **Resolved by deferral.** UC TTS/STT are out of core and live validation. | No cap selection or positive implementation; add zero-transport policy-disabled tests. | I only; reopening requires new P/L credit decision. |
| `U-02` Persona attachment max and MIME set | **Partly resolved.** One attachment and 67,108,864 decoded bytes per item are the default. This is an application acceptance cap, not proven upstream capacity. | Freeze the capture-backed MIME allowlist in the concern record; test exact MIME/base64/count/±1 boundaries in G3-04/G3-05. | I/security. A different cap needs a recorded security review, not a live call. |
| `U-03` Persona video cost/poll bounds | **Direction resolved; exact table not yet materialized.** Only captured image-to-video is allowed. | Derive and record capture-backed enums/ranges for frame count, FPS, steps, duration, scale, resolution, interval, and timeout; G3-12 boundary/rejection tests. | I/security. No P or L under capture-backed behavior. |
| `U-04` `next_reset` and cooldown | **Rule resolved; numeric horizon/map size still implementation parameters.** Accept documented seconds/ms/date only; finite future horizon; bounded, evicted, non-durable cache. | Record horizon, maximum entries, and cleanup policy; pass G3-13/G3-15 fixtures. | I/security. No P or L. |
| `U-05` aliases, collisions, migration, rollback | **Policy resolved; implementation absent.** Canonical `uc-persona`; aliases `uc`,`ucn`; explicit transactional/idempotent migration. | Generic multi-alias support, all-surface lookup tests, collision handling, protected backup/dry run/rollback in G2-03, G3-09, G7-04. | I/ops. P only to change the owner-set identity. |
| `U-06` login attempt expiry/concurrency and `sia` | **Deferred from this release.** Production onboarding is import/seed-only; email-code UI/onboarding must be unreachable. | G3-08 negative route tests. If helper code remains, use synthetic fixtures only. A future email-code surface needs a separate UI/security review, expiry/concurrency design, and `sid`/`sia` validation/encoding decision. | Core: I only. Future surface: P + I/security + separate L envelope. |
| `U-07` required-proxy lookup failure | **Resolved as mandatory fail-closed behavior; unimplemented.** | G3-14 must distinguish explicit no-proxy from failed required-proxy resolution and prove zero direct fallback. | I/security. No P or L. |
| `U-08` whether Direct ships | **Resolved.** Source may remain compiled for provenance, but no onboarding, credential creation, default/fallback/manual eligibility, normal enable flag, or live call exists. | G3-03 and Direct-negative suites; optional fixture-only endpoint/catalog correctness if retained code compiles. | No new P for this policy. Reopening needs owner reversal, security/spend scope, and later L approval. |
| `U-09` target-native test/build | **Still not done.** | G1–G5 in a disposable current-anchor clone with provider egress denied and full evidence records. | I/reviewer. No P or L. |
| `U-10` immutable reconciled image/deployment | **Still not done.** G0–G8 ends at a private, egress-blocked candidate, not live promotion. | G6 immutable digest, G7 rollback rehearsal, G8 isolated private start. Production/live promotion is G9/G10. | I/ops for G6–G8; L only later. |

### MaxAI source-review unresolved list

The JSON list has no stable IDs, so `MX-U01`–`MX-U12` below preserve its exact order from `MAXAI-SOURCE-REVIEW.json::unresolved`. The shorter Markdown list is at `MAXAI-SOURCE-REVIEW.md` lines 490–500.

| Local item | Source question | Current conclusion | Remaining work / gate | Approval |
|---|---|---|---|---|
| `MX-U01` | Firefox-150 mandatory or optional | **Superseded by the final plan:** Firefox-150/wreq is mandatory for every MaxAI request; unavailable/ineligible paths fail closed with 503. It is not proof of, or a requirement for, residential egress. | G4-18 all-branch route/fingerprint tests. | I/security. P only to change policy; no L. |
| `MX-U02` | Account/provider/global/env/`NO_PROXY`/relay precedence | **Still needs an exact implementation contract.** Silent nesting or bypass is forbidden. | Define precedence/direct sentinel/conflict behavior; prove direct, env, `NO_PROXY`, relay, and nested provider/account cases in G4-18. | I/security. No P or L under fail-closed policy. |
| `MX-U03` | Atomic rotation on cancellation/persist failure/stale `apiKey` | **Mandatory and unimplemented.** | One refresh-plus-persistence consistency boundary across every credential field; G4-01/G4-16 tests for all-waiters-cancel and persist failure. | I/security. No P or L. |
| `MX-U04` | Coherent signer extraction, abort isolation, rollback, safe retry | **Mandatory and unimplemented.** Broad “instant self-heal” remains rejected. | Bounded scan/proof/TTL/LKG/coalescing and one changed-generation signature retry in G4-07/G4-17. | I/security. No P or L. |
| `MX-U05` | Attachment/STT/PDF memory/CPU and admission | **Partly parameterized.** Document aggregate decoded cap is 67,108,864 bytes; exact STT cap, proxy limit, PDF/tokenizer concurrency/queue values, and worker resource values still need recording. | G0-03, G4-02/G4-09/G4-10. | I/security. No P or L. |
| `MX-U06` | Remote retention/delete/partial upload | **Behavior concluded, cleanup unavailable.** Local prevalidation must cause zero uploads. A later remote failure may leave earlier uploads because no captured delete/transaction API exists. | Document and prove the non-atomic fixture in G4-11/G4-12. If this retention is unacceptable, change scope rather than invent deletion. | I/security for core disclosure/test; P/privacy for a different lifecycle. |
| `MX-U07` | Terminal SSE/paywall/auth/quota/reset/`Retry-After` | **Mandatory and unimplemented.** | Captured compact/expanded fixtures and typed non-success mapping in G4-15/G4-19; bounded/sanitized reads in G4-13. | I/security. No P or L. |
| `MX-U08` | Tool nonce/name auth and DeepSeek R1 parity | **Split.** Exact nonce/name/schema authorization is mandatory. The uncaptured DeepSeek R1 13th dialect is rejected/backlog; supported claim stays 12/13. | G4-14 positive/negative/two-leg tests; G4-05 negative capability claim. | I/security. P + new evidence to add dialect; later L. |
| `MX-U09` | Input/output image URL policy | **Mandatory and unimplemented.** | Bound reviewed `data:`/HTTP(S) inputs and approved output scheme/origin/final host; G4-13 plus vision/image tests. | I/security. No P or L. |
| `MX-U10` | Raw upstream error/header/body retention | **Mandatory and unimplemented.** | Endpoint byte caps, full authorization redaction, typed public errors, no raw-body logging; G4-13 and G5-04. | I/security. No P or L. |
| `MX-U11` | Cross-platform PDF/native/tokenizer packaging | **Mandatory final-v8 closure; unimplemented on current target.** | Port reviewed runtime assets, regenerate lockfile, stable module resolution, supported-platform/foreign-CWD/standalone tests in G4-03, G5, G6-03/G6-04. | I/release. No P or L. |
| `MX-U12` | Account concurrency/provider limit | **No provider concurrency contract is proven.** Core only requires bounded global/per-tenant PDF/tokenizer admission. Product parallel agents stay deferred/off. | Record conservative core admission values and G4-10 saturation/fairness tests. Any product parallel feature requires separate account-pinned design. | Core I/security. Parallel feature P/privacy + separate L. |

## Source-review port/finding coverage

This crosswalk prevents an older “must port” or blocking finding from disappearing inside the gate summary.

### UC concern-port map

| Source-review records | Gate coverage / current disposition |
|---|---|
| `UC-PORT-01` | G1 clean current anchor; G2 preserve all later upstream winners. |
| `UC-PORT-02` | G2-03 and G3-09 additive aliases plus staged migration. |
| `UC-PORT-03` | Credential correctness remains G3-01/G3-08/G3-09, but the later plan **defers production email-code onboarding** and uses import/seed-only. |
| `UC-PORT-04` | G3-01/G3-13 strict terminal, quota, reset, and bounded cooldown behavior. |
| `UC-PORT-05` | G3-10 declared-call-only parser; heuristic second generation is rejected. |
| `UC-PORT-06` | G3-04/G3-05 one attachment, strict bounded decode, DNS-pinned guarded input, fail before chat. |
| `UC-PORT-07` | G3-04/G3-14 exact upstream URL/path allowlists and redirect refusal. |
| `UC-PORT-08` | G3-02/G3-15 sanitizer composition and secret-like fixtures. |
| `UC-PORT-09` | G2-06, G3-11, G3-12 Persona-only media, provider-ID dispatch, UC-last order, captured image-to-video bounds. |
| `UC-PORT-10` | G3-04 cancellation/499 and stop-on-abort behavior. |
| `UC-PORT-11` | Superseded by owner D3: do not hand-port TTS; retain artifacts as provenance and prove speech routes policy-disabled before transport. |
| `UC-PORT-12` | Direct correctness is selective fixture-only if compiled; G3-03 policy disable is mandatory. |
| `UC-PORT-13` | Direct-media header use is deferred with Direct; safe-header behavior used elsewhere still needs G3 tests. |
| `UC-PORT-14` | G3-12 capture-backed Persona video controls. |
| `UC-PORT-15` | G5-03 regenerate target docs/counts/snapshots; do not transplant. |
| `UC-PORT-16` | G6–G8 immutable combined artifact and private readiness; live deployment is later. |

Exact source: `UC-SOURCE-REVIEW.json::concern_port_map[id=UC-PORT-01..16]` (high-strength commit/file/test citations are embedded in each record).

### MaxAI must-port records and findings

| Source-review records | Gate coverage / current disposition |
|---|---|
| `MP-01` documents | G4-02/G4-11/G4-12/G4-13/G4-19. Final-v8 wins; add aggregate/admission/prevalidation/incremental-parser controls. |
| `MP-02` STT | G0-03, G4-03/G4-09/G4-13/G4-19. Captured raw multipart only; auth/body/response/schema blockers first. |
| `MP-03` refresh | G4-01/G4-16/G4-17 atomic credential generation and persistence. |
| `MP-04` cancellation/response bounds | G4-06/G4-13/G4-15/G4-18 plus G5 fixtures. |
| `MP-05` selected transport | G4-06/G4-18. The final plan upgrades Firefox-150/wreq from source-review policy ambiguity to mandatory fail-closed behavior. |
| `MP-06` PDF/runtime | G4-02/G4-03/G4-10/G4-19, G5, G6. |
| `MP-07` image/model discovery | G4-06/G4-13/G4-18. |
| `MP-08` truthful docs | G4-05/G5-03: operator-selected egress, best-effort refresh, tools 12/13, no unsupported capability claim. |
| `MP-09` upstream contracts | G2 and all merge/review gates: unbiased nonce, separated credentials, timeout split, current routes. |

All 24 `MAXAI-SOURCE-REVIEW.json::findings` are covered as follows:

- **Anchor/integration:** `INT-01` → G1/G2.
- **Resource/document/STT/build:** `SEC-RES-01`, `SEC-RES-02`, `SEC-CPU-01`, `COR-ATT-01`, `COR-ATT-02`, `BLD-01`, `CON-01`, `COR-STT-01` → G0/G4/G5/G6.
- **Auth/tools:** `AUTH-ROT-01`, `AUTH-IMP-01`, `AUTH-TOK-01`, `SEC-TOOL-01`, `COR-TOOL-01` → G4; the 13th dialect remains rejected.
- **Transport:** `TRN-01`, `TRN-02`, `TRN-03` → G4-18.
- **Stream/privacy/URL/cancel:** `COR-SSE-01`, `PRIV-ERR-01`, `COR-URL-01`, `COR-CAN-01` → G4-13/G4-15/G4-19 and G5-04.
- **Optional privacy/concurrency:** `PRIV-01`, `CON-02` → deferred overflow/parallel slice, not core.
- **Fresh verification:** `TEST-01` → G5.

Exact source: `MAXAI-SOURCE-REVIEW.json::must_port[id=MP-01..09]` and `::findings[id=...]`; Markdown explanations and paths are at `MAXAI-SOURCE-REVIEW.md` lines 87–114 and 219–370.

Four additional correctness/privacy notes in `MAXAI-SOURCE-REVIEW.md` lines 372–397 are also pending and must be made explicit in the G4 concern ledger:

1. Bound discovered model names/groups and positive `max_tokens` before persistence or logging; test overlong/implausible values as part of G4-06/G4-13.
2. Make the one allowed narration-miss retry observable and configurable; it is a second upstream transaction and must count in any later live envelope (G4-01/G4-05, then G9).
3. Decide from captured semantics whether returned upload `doc_type` must equal the prepared type, then enforce/test that exact rule under G4-02/G4-11; a merely nonempty value is not enough unless documented.
4. Ensure settings/export diagnostics do not expose public-but-sensitive-shaped signer material, and verify existing `no_log`/retention behavior prevents transformed prompt/image bodies from entering logs or reports (G4-13/G5-04).

These are **high-strength findings that work is missing**, not proof of the final parameter values.

## Exact limits, upload behavior, and evidence boundaries

### Provider input and resource limits

| Provider/surface | What is established | What remains before completion | Strength and exact evidence |
|---|---|---|---|
| UC Persona text prompt/context | No UC-specific text-prompt ceiling or automatic prompt-to-file spill is established in these audit artifacts. Use generic context handling and return its normal context error; do not call UC “unlimited.” | Verify current generic limit behavior in the final tree. Do not add a UC spill/parallel mechanism. | **High** for absence/rejection: `CAPABILITY-MATRIX` delta `UC-LIMIT-2`; `RECONCILIATION-PLAN.md` §§4.2, 4.5, and 12. Exact upstream ceiling: **not concluded**. |
| UC Persona attachment | Exactly one capture-backed current-turn image/document. Strict canonical base64. Default decoded per-item acceptance cap: **67,108,864 bytes (64 MiB)**. This is a local acceptance limit, not a proven provider maximum. Requested upload failure must stop chat. | Freeze the exact capture-backed MIME allowlist and test count, canonical encoding, raw/preallocation, cap−1/cap/cap+1, remote HTTPS/public-DNS/origin/path/redirect failures. | **High:** plan §4.2 “Required behavior”; matrix `UC-DOC-1`, `UC-LIMIT-1`, `UC-SEC-1`; checklist G3-04/G3-05. |
| UC TTS/STT | Historical TTS protocol and repaired MP3 evidence exist; UC STT was absent. | Owner D3 excludes both from core/live validation. Preserve evidence only; reject routes before transport and consume zero credits. | **High historical evidence; current disposition:** deferred/OFF via `plans/OWNER-SCOPE-OVERRIDES.json`. |
| UC Persona video | Only captured `wan-2.2-spicy` image-to-video is in scope. Guessed text-to-video is rejected. | Record capture-backed frame/FPS/step/duration/scale/resolution/poll enums/ranges before enabling. | **High:** matrix `UC-MEDIA-1`; source `UC-PORT-14`; checklist G3-12. |
| MaxAI normal chat/context | Core is stateless full-history text flattening. No fixed textual prompt ceiling is concluded here. An upstream too-long response can use generic context handling. | Verify the current target behavior. Do not turn an oversized prompt into a remote document in core. | **High:** `CAPABILITY-MATRIX.md` rows `maxai.chat_streaming_reasoning_tools` and `maxai.limits_overflow_parallel`; plan §§4.5–4.6 and §12. Exact provider ceiling: **not concluded**. |
| MaxAI ordinary documents | Maximum **5**. Per item: image **10,485,760 bytes (10 MiB)**; PDF **50,331,648 bytes (48 MiB)**; other document **20,971,520 bytes (20 MiB)**. Inline decoder/preallocation guard **67,108,864 bytes**; separate aggregate decoded-request safety cap **67,108,864 bytes**. The inline guard is not an upload allowance. | All-document decode/classify/token/filename preparation before upload 1; exact MIME/filename/raw-encoded rules; global/per-tenant admission and worker resources; decide and mark reject-vs-truncate behavior. | **High:** plan §4.4 items 4 and 7 plus §12; matrix `MX-DOC-1/2/4/5`, `MX-LIMIT-1`; checklist `maxai_attachment_defaults`. |
| MaxAI PDF/text extraction | **800,000 text tokens**, **3,200,000 extracted PDF characters**, **60 s PDF worker**, **30 s tokenizer worker**. | Page/object/raw bounds, admission/queue values, `Worker.resourceLimits` or stronger isolation, malformed/encrypted/empty/bomb/parallel/abort/cleanup tests, supported-platform and foreign-CWD packaging. | **High at frozen final-v8 boundary, not current target:** plan §4.4 item 7 and §6.5; matrix `MX-DOC-2/4`; source findings `SEC-RES-02`, `BLD-01`, `CON-01`. |
| MaxAI STT | Captured route is `maxai/speech-to-text`, advertised WebM only; accepts EBML/WebM and the captured Ogg/Opus bytes while sending `audio.webm` / `audio/webm`; operation timeout is 30 s in the accepted source. | A positive numeric `MAXAI_STT_UPLOAD_MAX_BYTES`, reverse-proxy body limit, missing/false-length/chunked policy, actual `file.size` check, bounded peak copy and response size. Registry/API advertised max must equal the effective cap and must not be 2 GB. | **High:** source `MP-02`, finding `SEC-RES-01`, `COR-STT-01`; plan §4.4 item 6; checklist `maxai_stt_ingress`. Numeric cap: **not concluded**. |
| MaxAI response parsing | Final-v8 bounds total chat response to **16 MiB**, an SSE frame to **1 Mi-character**, upload response to **1 MiB**, and upload timeout to **120 s**. | Apply pre-parse/frame checks and endpoint-specific bounded/cancellable model/image/upload/STT readers; typed sanitized over-limit errors. | **High at final-v8 boundary:** plan §4.4 item 7 and §6.5; matrix `MX-CHAT-1B`, `MX-QUOTA-1`, `MX-SEC-3`; G4-13/G4-19. |
| MaxAI optional context spill | Accepted final2 used an inclusive **400,000-character/byte** inline boundary, with a **20 MiB / 800k-token** lossless ceiling, then uploaded the full assembled conversation as a provider document. | **Do not implement in core.** A separate privacy/retention design must cover consent, non-linkable naming, no recovered delete operation, lifecycle, account admission, isolated PR/tests, and separate live approval. | **High historical only:** `MAXAI-SOURCE-REVIEW.md` lines 190–217; matrix `MX-CHAT-4`, `MX-LIMIT-2`; plan §4.5 and §12. |

### When oversized input becomes an upload

- **UC Persona:** a user-supplied current-turn attachment uses the captured single-blob upload flow. An item above 64 MiB is rejected. There is no approved conversion of oversized conversation text into a file/reference. **Core status:** one-attachment upload is mandatory; prompt spill is rejected/unimplemented.
- **MaxAI ordinary documents:** requested attachments are locally decoded, classified, tokenized, canonicalized, and fully prevalidated. Only then are they uploaded serially and referenced through `doc_list` with `current:false`. A local failure must cause zero uploads. A later remote failure can leave an earlier remote upload; no delete/transaction operation was recovered. **Core status:** mandatory.
- **MaxAI context spill:** final2 can upload the full assembled conversation only after its 400,000 boundary. This is **not core** and remains off. It changes transient chat into persistent provider storage and has no recovered deletion path.

Evidence: plan §§4.2, 4.4, and 4.5; matrix `UC-DOC-1`, `UC-LIMIT-1`, `MX-DOC-1/2/4/5`, `MX-CHAT-4`, `MX-LIMIT-2`; MaxAI source findings `PRIV-01`, `COR-ATT-01`.

### File/image flows actually tested, by exact boundary

| Boundary | What the evidence proves | What it does not prove |
|---|---|---|
| Current live image ID `9ffbdaf00c2daa4c9107663b75d8df6a46033d2b81408c74c5b92e0b76465a08` / live digest `sha256:c47702d184a5f69da4b9e784d767e5844473110d10e2a9175d4f16e6a6f2a57b` | Dirty/mixed MaxAI v2; the exact v2 upload pair served retained **5/5 PDF, DOCX, PNG, JPG, and 60k-text** remote results. It has zero of 20 audited UC files. | It does not validate UC, final-v8, a clean combined build, current source, or all MaxAI security gates. |
| MaxAI final-v8 image `999e6c2c86dcd4ccacf82fbb70777a3169c887f0649dc503e87c3bf8521cf18d`, digest `sha256:eb5480ae186c5b7e21fb3ef4822c0015e747eb03c79b8e95cda73d294a4bccf7` | Frozen evidence records 54/54 focused tests, typecheck/build, PDF runtime assets, red/green bundle regression, and offline packaged PDF parse. It contains the stronger count/type/response/PDF bounds. | It did **not** serve the v2 remote 5/5 matrix and is not a target release artifact. It still lacks the new aggregate/admission/prevalidation/incremental-parser blocker closure. |
| Accepted MaxAI STT source hash `102d93707e924ecfa0745e481d33a9b4a5750cd89419a879efec9464b56cf5a1` | Byte-stable raw multipart and retained HTTP-200 behavior for EBML WebM and captured Ogg/Opus-as-WebM. | No safe 2 GB allowance; no current-target route/body/security proof. |
| Historical UC image `08ab818d328b324e2dbf943b93c9c8e7f5d3266ec408c52769f1ceb2305cb49f` and dirty TTS overlay patch SHA-256 `1a2b46bdd11554dc4ac54b38cd77d63a79594e2a7d43290ca677e8abf2bf71e7` | Historical Persona text/tool, vision, document/PDF, image, image-to-video evidence; TTS later succeeded in a **separate repair run**. The dirty TTS focused TAP was 140/140 at its own boundary. | It does not prove current availability, UC Direct, one uninterrupted 7/7 run, current sanitizer composition, or bounded TTS decoding. Exact UC document MIME coverage is not concluded by the synthesis artifacts. |
| Current target/candidate | Nothing: there is no candidate tree or image and no target-tip tests were run. | All G3–G8 completion claims. |

Strength is **high but boundary-limited**. Sources: `CAPABILITY-MATRIX.md` lines 10–15 and rows 99–131; `MAXAI-SOURCE-REVIEW.md` lines 51–63, 162–188, 430–450; `UC-SOURCE-REVIEW.md` lines 197–252; checklist `audit_facts` and `safety`.

### Catalog discovery and adding models

- **Current OmniRoute Persona is static.** The core baseline has 19 empirically selected chat models, with vision on 15/19. Retained web evidence later revealed a dynamic upstream Persona roster, but metadata refresh is optional/non-gating G3-D. A discovered ID is quarantined and still requires reviewed capability promotion, any model-specific tool-dialect allowlisting, cross-surface alias/executor/media tests, regenerated docs/counts/snapshots, and a new immutable build. It must not become automatic/fallback merely because it is listed.
- **UC Direct is different but disabled.** Its retained provenance has a static 82-model/15-provider fallback and an optional public `/api/v1/models` discovery repair. That code may be fixture-tested only if retained compiled; it cannot create route or credential eligibility.
- **MaxAI is both curated and dynamic.** The approved product set is a curated 13-chat-model catalog. Signed `/models/get_config` discovery refreshes metadata such as positive `max_tokens`, with a static fallback; valid models outside the curated 13 are filtered. New models do not auto-enter the catalog. Provider-controlled names/groups/token values must be bounded before persistence/logging.

Strength: **high**. Evidence: `CAPABILITY-MATRIX.md` UC catalog row 101, MaxAI catalog row 120, deltas `UC-CAT-1/2`, `MX-CAT-1/2`; `RECONCILIATION-PLAN.md` §§4.2–4.5 and §6.

### MaxAI parallel lanes, IDs, and reasoning: what is and is not concluded

- Accepted final2 evidence proves **one historical live two-lane host-side tool run** on one active MaxAI connection and one live 420k spill. Three/four/six lanes, continuation, failure cases, and positive reasoning isolation were offline or unproven. It is not a server/provider feature or a concurrency contract.
- Recovered stock native source supports 1/2/3/4/6 panel layouts; the examined bundle’s “30” is only Google search-result breadth. Separately, original shim Git and artifacts now prove seven-seat direct aggregate host execution, a committed 12-seat real-`ChatService` aggregate harness, and a configurable local council ceiling 30. Historical v2 remained single-chat. The exact owner-attested 30/32 per-provider request trace remains missing, not disproven.
- Current core MaxAI is stateless full-history text flattening with fresh provider request conversation IDs. It can separate provider-exposed `<think>` text, but the live two-lane run returned no reasoning. Hidden/full chain-of-thought and durable provider conversation identity per lane are not established.
- Therefore the release claim must remain narrow: captured chat/stream reasoning parsing plus required terminal/error fixtures; tools remain 12/13; no parallel-agent or full-reasoning claim. A later coordinator is a separate default-off project under `workers/maxai-parallel-lanes.md`.

Strength is **high** for the two-lane and stateless-source facts; **not concluded** for durable lane conversation IDs/full reasoning extraction. Evidence: `workers/maxai-parallel-lanes.md`; `MAXAI-SOURCE-REVIEW.md` optional/reject findings; `CAPABILITY-MATRIX.md` categories `maxai.chat_streaming_reasoning_tools` and `maxai.limits_overflow_parallel`; plan §§4.4–4.5 and §12.

### Safe egress, pacing, quota, and human approval

- G0–G8 must run with provider egress blocked. UC code stays network-topology-neutral and honors the selected connection; a required-proxy lookup failure must not fall back to direct. MaxAI uses Firefox-150/wreq and fails closed with 503, but this does **not** justify a public “residential egress required” claim.
- Use a compliant operator-selected connection. Follow provider terms. Do not add bot-evasion, prompt obfuscation, or synthetic “human-looking” behavior.
- Before any later live call, disable background tests/discovery/refresh/health jobs, allowlist exact hosts/methods, and enforce a hard transaction counter that includes refresh, discovery, retry, upload, polling, and generation. Use a dedicated canary connection and one credential writer.
- Pace conservatively, honor captured `Retry-After`, respect the approved cost/quota ceiling, and stop on the plan's errors. UC quota copy is metered/plan-dependent, never “unmetered.” UC Direct is ineligible.
- The **only live approval** is the later G9 envelope: exact digest/commit, provider/account, capability/model, hosts/methods, total transaction count, cost/quota, timeout/pacing, persistence permission, stop rules, observation/SLO thresholds, rollback consequence, and promotion authority.

Evidence: plan §§8–9 and §12; checklist `live_validation_enforcement`, `live_stop_conditions`, and `user_decisions[D-LIVE-ENVELOPE]`; matrix `UC-EGRESS-1/2`, `MX-EGRESS-1/1B/2/3`.

## Scope classification and complete matrix-ID crosswalk

The matrix is an action registry, not an implementation report. It contains 52 `mandatory port`, 5 `selective port`, 3 `regenerate`, 3 `optional privacy-sensitive`, 35 `reject`, and 0 registry-level `unresolved` entries. The later plan can refine a matrix disposition; two important precedence changes are called out below.

### Mandatory core

All rows below are unimplemented. The IDs list **all 52 matrix `mandatory port` deltas**.

| Capability | Matrix IDs | Gate(s) | Exact work family |
|---|---|---|---|
| UC identity | `UC-ID-1`, `UC-ID-2` | G2, G3, G7 | Separate Persona/Direct; exact canonical/display/route/aliases; staged transactional migration. |
| UC auth | `UC-AUTH-1`, `UC-AUTH-2` | G2, G3 | Keyless session/JWT UID and atomic storage; preserve current sanitization and credential separation. Production onboarding is narrowed by the later plan to import/seed-only. |
| UC catalog | `UC-CAT-1` | G3 | Persona catalog/capability flags on current registry shape. |
| UC chat/tools | `UC-CHAT-1` | G3 | Strict terminal/error behavior and allowlisted whole-response declared-call-only parser; no second-generation auto-cure. |
| UC vision | `UC-VISION-1` | G3 | Guarded remote image and fail-closed requested-image flow. |
| UC docs | `UC-DOC-1` | G3 | One captured attachment; fail-closed upload. |
| UC media | `UC-MEDIA-1`; owner D3 supersedes positive `UC-MEDIA-2/2B` scope | G0, G3 | Provider-ID routing and captured image-to-video bounds; TTS/STT policy-disabled before transport. |
| UC quota | `UC-QUOTA-1`, `UC-QUOTA-2` | G3 | Validated reset formats, bounded non-durable cooldown, safe headers, metered wording. |
| UC cancellation | `UC-CANCEL-1` | G3 | End-to-end signal/499 behavior. |
| UC limits | `UC-LIMIT-1` | G3 | Reconstruct strict bounded decoder and one-attachment contract; do not copy `846ee481...` literally. |
| UC timeout | `UC-TIME-1` | G2, G3 | Preserve `838fc00...` queue/execution split and add provider regressions. |
| UC egress | `UC-EGRESS-1` | G3 | Selected connection, topology-neutral copy, fail closed on required-proxy failure. |
| UC security | `UC-SEC-1`, `UC-SEC-2` | G3 | URL/origin/path/DNS/redirect/base64/header safety and upstream sanitizer preservation. |
| UC release | `UC-DEPLOY-1` | G1, G5–G8 | Build a combined immutable current-anchor candidate, not an old UC image. |
| MaxAI identity | `MX-ID-1` | G2 | Preserve `maxai`/`mx` and token credential class on combined base. |
| MaxAI auth/signing | `MX-AUTH-1`, `MX-AUTH-2`, `MX-AUTH-4` | G2, G4 | Atomic refresh persistence, current dynamic extraction/unbiased nonce/separation, bounded proof/LKG/TTL/one retry. |
| MaxAI catalog | `MX-CAT-1` | G4 | Refresh/persist and selected transport for curated discovery; preserve `97041954...`. |
| MaxAI chat/tools | `MX-CHAT-1`, `MX-CHAT-1B`, `MX-CHAT-1C`, `MX-CHAT-3` | G4 | Retry media preservation, cancellation, bounded SSE, exact tool nonce/name/schema, typed HTTP-200 terminal failures. |
| MaxAI vision | `MX-VISION-1`, `MX-VISION-2` | G4 | Preserve current-turn images and restrict URL schemes. |
| MaxAI documents/PDF | `MX-DOC-1`, `MX-DOC-2`, `MX-DOC-4`, `MX-DOC-4B`, `MX-DOC-5` | G4, G6 | Strict serialized upload, exact final-v8 bounds/runtime, aggregate/admission controls, incremental SSE, all-item prevalidation. |
| MaxAI STT/image | `MX-MEDIA-1`, `MX-MEDIA-1B`, `MX-MEDIA-2` | G0, G4 | Captured raw STT plus auth/body/memory/response schema; image refresh/cancel/transport/URL validation. |
| MaxAI errors/quota | `MX-QUOTA-1` | G4 | Bounded abort-aware reads, full redaction, typed errors; no quota API claim. |
| MaxAI cancellation | `MX-CANCEL-1`, `MX-CANCEL-3` | G4 | Reader/STT/image/doc/worker cancel plus login/discovery/signer/retry signals and timeouts. |
| MaxAI limits | `MX-LIMIT-1` | G4 | Exact final-v8 core limits, independent of spill/parallel. |
| MaxAI timeout | `MX-TIME-1` | G2, G4 | Preserve queue/execution split; 300 s is admission only. |
| MaxAI egress | `MX-EGRESS-1`, `MX-EGRESS-1B`, `MX-EGRESS-2` | G4 | Stable selected route, abort dispatched request on fast-fail, Firefox-150/wreq everywhere or 503. |
| MaxAI security | `MX-SEC-1`, `MX-SEC-2`, `MX-SEC-3`, `MX-SEC-3B` | G2, G4 | Strict docs/PDF, unbiased nonce, bounded URL/body/redaction, explicit credentialed redirect/final-host policy. |
| MaxAI release | `MX-DEPLOY-1` | G1, G5–G8 | Current-anchor concern ports and immutable combined provenance. |

**Later-plan upgrade:** `MX-LIMIT-1C` was `selective port` in the matrix, but `RECONCILIATION-PLAN.md` §4.4 item 7 and checklist G4-03 now require the narrow ordinary-text fix `encoder.encode(text, [], [])` as core. This does not approve spill, custom BPE, the final2 worker queue, or parallel agents.

### Selective work

| ID | Current disposition | Needed approval |
|---|---|---|
| `UC-CAT-2` | If Direct source remains compiled, fixture-test the exact `/api/v1/chat/completions` endpoint and public-model/static fallback only as unreachable provenance. Never expose onboarding/credentials/routing. | I only; P required to do more. |
| `UC-MEDIA-1B` | Keep Direct image/video unregistered, disabled, and ineligible. The negative policy boundary is mandatory; extra compiled-code preservation is selective. | I only. |
| `MX-LIMIT-1B` | Final2 queue may be a design input only after byte weighting, tenant fairness, overload typing, PDF coverage, resource isolation, termination recovery, stable tokenizer API, and worst-case tests. Core may implement an independent admission gate instead. | I/security. No product feature implied. |
| `MX-LIMIT-1C` | **Upgraded to mandatory core by the later plan**, as noted above. | I/security. |
| `MX-DEPLOY-5` | Review the three-file dirty `maxai-refresh` cleanup path-by-path. Port or defer it as isolated hygiene; never import false signer-vector prose or stale suppression. | I. No P or L. |

### Regenerate, never transplant

| ID | Required action | Gate |
|---|---|---|
| `UC-DEPLOY-2` | Regenerate UC counts, i18n docs, snapshots, release material, and file-size baselines from the final target. The delta wording “carry” is the thing rejected by the `regenerate` disposition. | G5-03 |
| `MX-TIME-1B` | Correct stale test prose that calls MaxAI queue wait an execution budget. | G2/G5 |
| `MX-DEPLOY-2` | Regenerate provider counts, translation snapshots, docs, lock/build manifests, and file-size baselines on the final tree. | G5-03 |

### Optional or deferred

| ID/source item | Status and reason | Preconditions / approvals |
|---|---|---|
| `UC-AUTH-1B` | Production browserless Clerk email-code onboarding is deferred; import/seed-only is the core release. | Separate UI/security design, P decision, implementation tests, and later L envelope. |
| `MX-CHAT-4`, `MX-LIMIT-2` — context-spill portion | Default OFF and outside core. Automatically uploads the complete assembled conversation above its threshold; no remote delete contract was recovered. | Separate privacy/retention decision, explicit consent/lifecycle, threat model, isolated PR/offline gates, and separate live approval. |
| `MX-CHAT-4`, `MX-LIMIT-2` — parallel-coordinator portion | Separate default-OFF coordinator project. Parallelism does not inherently require full-conversation spill and must not be bundled with it. Latest live proof is two lanes only. | Separate product/terms/concurrency decision, account-scoped admission, isolated offline tests, future operations-policy revision, and separate live staircase approval. |
| Checklist `OPT-MAXAI-REFRESH-CLEANUP` / source cleanup layer | Optional three-file hygiene only: `config/quality/eslint-suppressions.json`, `scripts/check/check-provider-assets.mjs`, `tests/unit/maxai.test.ts`. | I disposition only; false signer prose may never be imported. |
| MaxAI source `OP-03`/`OP-04` | Final2 worker queue is redesign input; parallel probe stays restricted manual QA, never a provider/server capability or routine CI. | I/security for a redesigned queue; P/privacy + L for any productized parallel behavior. |

**Source-review precedence note:** `MAXAI-SOURCE-REVIEW` item `OP-01` treated universal Firefox-150 as policy-gated because evidence alone did not prove it. The later reviewed plan explicitly chooses it as mandatory, fail-closed release policy. This is a policy decision, not a claim that residential egress or byte-identical provider fingerprint success was historically proven.

### Rejected or superseded

The following 35 matrix IDs must remain absent. Negative tests and review scans are the completion proof where relevant.

| Capability | Matrix reject IDs | Rejected action/claim |
|---|---|---|
| UC identity | `UC-ID-3` | Either old provider branch as a whole landing base. |
| UC auth | `UC-AUTH-3` | Treat stale live `apikey` metadata as working Persona auth. |
| UC chat | `UC-CHAT-2`, `UC-CHAT-3` | Raw provider errors; operational Direct beyond disabled compiled provenance. |
| UC vision | `UC-VISION-2` | Claim current live vision from a historical image. |
| UC docs | `UC-DOC-2` | Invent Persona multi-file or local PDF extraction. |
| UC media/speech | `UC-MEDIA-3`, `UC-MEDIA-4`; owner D3 | Copy dirty TTS wholesale; add UC STT; run any UC speech call; guessed Persona text-to-video. |
| UC quota | `UC-QUOTA-3` | Call historical local 15 s 504s provider quota failures. |
| UC cancellation | `UC-CANCEL-2` | Treat final TTS frame behavior as complete cancellation coverage. |
| UC limits | `UC-LIMIT-2` | Copy MaxAI spill/parallel into UC. |
| UC timeout | `UC-TIME-2` | Give UC the old 300 s queue-wait workaround. |
| UC egress | `UC-EGRESS-2` | Encode the present Tailscale wrapper as a UC protocol requirement. |
| UC security | `UC-SEC-3` | Permissive base64 or credentialed redirect following. |
| UC release claims | `UC-DEPLOY-3`, `UC-DEPLOY-4` | Merge old test counts across boundaries; claim Direct live readiness. |
| MaxAI identity | `MX-ID-2`, `MX-ID-3` | Treat adjacent hub routing as provider source; infer automatic fallback from provider existence. |
| MaxAI auth | `MX-AUTH-3`, `MX-AUTH-5` | Recover hardcoded signing constants; accept generic one-token import instead of a validated composite tuple. |
| MaxAI catalog/tools | `MX-CAT-2`, `MX-CHAT-2` | Auto-expand beyond curated 13; claim or invent 13/13 tool parity. |
| MaxAI documents/media | `MX-DOC-3`, `MX-MEDIA-3` | Promote live v2 as final; add/claim video, image-edit, TTS, or uncaptured STT formats. |
| MaxAI quota/cancel | `MX-QUOTA-2`, `MX-QUOTA-3`, `MX-CANCEL-2` | Invent quota API; interpret 502/504 as quota; treat one live 499 as full cancellation proof. |
| MaxAI overflow | `MX-LIMIT-3`, `MX-LIMIT-4` | Use parentless/dirty trees wholesale; recover rejected first overflow image or claim larger layouts live-proven. |
| MaxAI timing | `MX-TIME-2`, `MX-TIME-3` | Replace shared limiter with final2 queue; conflate 8 s model-route and ~90 s response-start failures. |
| MaxAI egress/security | `MX-EGRESS-3`, `MX-SEC-4` | Encode residential/Tailscale in public provider behavior; recover embedded constants/superseded image variants. |
| MaxAI release | `MX-DEPLOY-3`, `MX-DEPLOY-4` | Treat prose/declaration counts as a fresh run; deploy through mutable `:base`. |

Plan-level rejected inputs also remain excluded: whole-tree/branch imports from `deace9d1c4fae7bc41c0600a891e1c1a8206ac57`, `801fb15757a36f22c4c751211b0561097cbe1b3b`, `6120febd4e2189d53086ef8f6d4440c8c6d3c10d`, `7b73b6bad0f5f2ee7eb716ee0548bfb83b7cfae0`, `809064106d92e320df8f7b8bfcd1f4e0edf60d35`, `77dcecae3b229b057dc974615865a0c5d6e79435`, `8a7e109a34f0b1077294ebf698cf254cdfd75d65`, `baadc16e7b0eabe515380c712d82ebdb65375c91`, `4b0e3ac8002f4130c7575337306b106d124ebaf3`, or parentless `afa50d9b4fcea841fb476819de8f223855da6f8d`; pre-dynamic signing branches `bc17d8dcc2ee8b310d5a06f716ccec88cf9edb92` and `9b0065b3dea5544f2e36575b28f795570bfc2aeb`; mutable `localhost/omniroute:base`; live v2 image `9ffbdaf00c2daa4c9107663b75d8df6a46033d2b81408c74c5b92e0b76465a08` as source/release; `.project-intel`; unrelated Tailscale changes; old generated output; UC `wsPath.ts` as provider logic; operational Direct/compare/memory/web-search/image-edit/dashboard work; MaxAI TTS/video/quota API; “instant self-heal,” one-year refresh, residential requirement, 13/13 tools, or “unmetered” UC. Exact wording is in `RECONCILIATION-PLAN.md` §4.6 “Explicitly rejected or superseded inputs and claims” and checklist `scope.rejected_or_superseded`.


### Source-review-only optional/reject crosswalk

The MaxAI source review used its own IDs before the matrix/plan dispositions were finalized:

| Source ID | Final disposition |
|---|---|
| `OP-01` Firefox-150 transport | Upgraded by the final plan to mandatory fail-closed MaxAI policy (`MX-EGRESS-2`, G4-18). This does not establish residential egress as a provider requirement. |
| `OP-02` lossless context spill | Deferred/off privacy slice (`MX-CHAT-4`, `MX-LIMIT-2`); no core prompt upload. |
| `OP-03` final2 worker queue/tokenizer refactor | Split: narrow `encoder.encode(text, [], [])` is now mandatory; queue code remains selective redesign input. |
| `OP-04` parallel probe | Restricted manual evidence tooling only; no product/server concurrency claim. |
| `RJ-01` | Reject whole `c303fca6`/`801fb157` branch/tree/image replay. |
| `RJ-02` | Reject `801fb157` signer bytes/modulo nonce; current unbiased `randomInt` wins. |
| `RJ-03` | Reject image-only v2 documents/PDF source as the landing source. |
| `RJ-04` | Reject older `FormData` STT; accepted raw multipart source wins. |
| `RJ-05` | Reject required-residential, guaranteed refresh cadence, or roughly one-year validity claims. |
| `RJ-06` | Reject generic one-string MaxAI import. |
| `RJ-07` | Reject unverified `source_type=mix` for every ordinary attachment. |
| `RJ-08` | Reject final2 probes/docs verbatim in product or routine CI. |
| `RJ-09` | Reject parentless `afa50d9...`, dirty worktrees, `.project-intel`, and unrelated Tailscale changes wholesale. |
| `RJ-10` | Reject old hardcoded signing constants/pre-dynamic branches. |
| `RJ-11` | Reject MaxAI TTS/video/quota/server-history and 13/13 tool claims. |

Exact records: `MAXAI-SOURCE-REVIEW.json::optional[id=OP-01..04]` and `::reject[id=RJ-01..11]`.

The UC source review's 12 unnumbered reject rules are also preserved: no wholesale candidate cherry-pick/file copy; no two-name rename that drops `ucn`; no Direct image/video exposure; no credential-prefix Direct dispatch; no guessed Persona text-to-video; no heuristic auto-cure/universal permissive code parser; no verbatim `846ee481` decoder; no `cursorImages` substitution for DNS-pinned `remoteImageFetch`; no dirty TTS file wholesale; no old generated outputs/fragments; no image-registry reorder that reverts `752aac65...`; and no UC-specific workaround for the already-fixed 15 s limiter. Exact source: `UC-SOURCE-REVIEW.json::reject` and `UC-SOURCE-REVIEW.md` lines 254–266.

### Required post-port verification from the MaxAI source review

All nine ordered items in `MAXAI-SOURCE-REVIEW.json::required_verification_after_port` remain pending and map to the gates as follows:

1. Disposable current-tip worktree/no unapproved live call → G1 and G5-02.
2. Preserve `e243b04d...` nonce, `239d8fc...` credentials, and `838fc00...` timeout tests → G2/G4/G5.
3. Full current MaxAI, final-v8, STT/image/refresh/cancel/registry/typecheck/lint/docs/standalone/Docker/Electron gates → G4/G5/G6.
4. No-network import/signer/transport/fast-fail/redaction blockers → G4-13/G4-16/G4-17/G4-18.
5. Attachment/STT raw/aggregate/whitespace/filename/PDF-bomb/worker/chunked/response/cancel/zero-network tests → G4-02/G4-09/G4-10/G4-11/G4-12/G4-13/G4-19.
6. Captured terminal/auth/paywall/quota/`Retry-After`, unsafe URL, tool dialect/two-leg fixtures → G4-14/G4-15; DeepSeek parity remains a negative 12/13 assertion unless new evidence changes scope.
7. Overflow tests only if separately approved → deferred optional slice, outside G0–G8 core.
8. Historical live evidence is planning-only; any request/refresh/upload/concurrency probe needs later explicit approval/pacing → G9, not G0–G8.
9. Literal tokenizer special-token text regression → G4-03 (now core).

## Dependency spine

`G0 → G1 → G2 → G3 → G4 → G5 → G6 → G7 → G8`

There is no safe shortcut:

- Old test counts and historical live calls cannot satisfy G3–G5.
- An image label or mutable tag cannot satisfy G6.
- A healthy global endpoint cannot satisfy provider readiness in G8.
- G8 does not authorize a provider call; G9 is still required.

## Source-byte verification

Before finalizing this synthesis, the refreshed compact copies were reread against `evidence-index/SOURCE-COPY-MANIFEST.json` schema `uc-maxai-recon-source-copy/v5` (`copied_at_utc=2026-09-10T08:08:15.051475+00:00`). Relevant SHA-256 values:

- `RECONCILIATION-PLAN.md`: `8205901ef422d9eb17756fdd7483e642b395c371df8595ae172d53297f6a43c4`
- `RECONCILIATION-CHECKLIST.json`: `3ffadeb7c786ffb6f4999fe98325f04a3d27df3f33b706914a5e0676b29202dd`
- `CAPABILITY-MATRIX.md`: `f0494dc76479d2d8fc0886a8e0999d658ff6e39be45e8e76f5ce0551323a232d`
- `CAPABILITY-MATRIX.json`: `c286e9841c071fcd8924d006a8d8301da8496e5bdd82441b45d110ee42eb4fcc`
- `UC-SOURCE-REVIEW.md`: `686990e0dc51ad55cdfc1cd1a4a9af995d316efe08a1d21b302d562f996e4ce6`
- `UC-SOURCE-REVIEW.json`: `9f0201d3835dc07d23e9355988ce04622332e5b0087c37388a000ad1d53f7b77`
- `MAXAI-SOURCE-REVIEW.md`: `13a57a1e63aad950cf0a7a9b2268953b9af42221e5f6cb59d2110c50d50974ca`
- `MAXAI-SOURCE-REVIEW.json`: `88f9601eba49d467a4478ba51ea2a561acd00228d9518bfe4de7baeb8c2a764e`

Restricted evidence was not copied into this project (`restricted_evidence_copied=false`). No credential, cookie, token, email code, account identifier, or private prompt body is reproduced here.
