# What is still pending

Source detail: `../workers/gates-and-pending.md`
Owner scope override: `../plans/OWNER-SCOPE-OVERRIDES.json`

**Current scope override:** UC TTS and UC STT are deferred/OFF and are not core or live-validation requirements. Initial audit TTS checks are satisfied for this release by negative, zero-transport disabled-route tests—not by implementing or calling speech.

## Status in one sentence

The plan exists, but no implementation gate has been accepted as complete. The machine checklist has 77 required checks in total. The 69 required pre-live checks in G0–G8 remain recorded as `not_started`; the remaining eight belong to G9–G10.

A separate clean clone was prepared after the audit, but this is only preparation. It has not been accepted as G1 evidence, contains no reconciled provider changes, and its incomplete dependency install was quarantined.

## Gate summary

| Gate | Purpose | What remains | Exit proof |
|---|---|---|---|
| G0 | Freeze scope and safety constants | Freeze concern ledger; select UC attachment/video/reset and MaxAI STT/PDF/resource caps; record UC speech as deferred/OFF | Versioned defaults and threat-reviewed constants |
| G1 | Freeze a clean current upstream anchor | Recheck public head; prove the corrected ten-SHA ancestry list; verify provenance-only behavior equivalences and both PR diff hashes; clean clone; hash baseline | Exact SHA, clean status, ancestry, behavior/test equivalence, PR diff, and source manifest |
| G2 | Preserve shared invariants | Credentials, aliases, registry ordering, queue versus execution time, routing policy | Shared contract tests pass before provider ports |
| G3 | Implement UC Persona first | Auth, aliases/migration, chat/tools, one attachment, vision/image/video, quota, cancellation, gates, negative Direct and speech tests | All UC offline tests pass with network denied |
| G4 | Implement MaxAI core | Refresh/persistence, signer, transport, tools, errors, documents/PDF, STT, resource limits | All MaxAI offline tests pass with network denied |
| G5 | Validate the whole tree | Typechecks, focused and full tests, build, generated files, secret/security reviews | Clean reproducible build and review record |
| G6 | Build immutable combined artifact | One image containing both providers, SBOM/attestation, digest-pinned config | Packaged provider files and runtime assets verified |
| G7 | Prove rollback and runtime contract | Retain current image, isolated state backup, rollback rehearsal, compatibility check | Candidate can fail and roll back without data loss |
| G8 | Private blue/green readiness | Separate ports/data, egress blocked, provider/capability readiness | Candidate starts privately with correct readiness states |

G9 is the first live-call gate. It cannot waive G0–G8.

## UC Persona implementation backlog

- Canonical `uc-persona` plus compatibility aliases `uc` and `ucn` across every resolver.
- Transactional, idempotent migration of the stored legacy `uc` connection.
- Clerk credential tuple and UID/session validation.
- Declared-call-only tool parser; remove heuristic second generation.
- One attachment only, strict base64/MIME/size checks, public pinned fetch, redirect denial.
- Provider-ID-only Persona versus Direct dispatch.
- Vision, image generation, captured image-to-video, and bounded video controls.
- UC speech negative closure: TTS and STT routes remain disabled before transport; no credit-consuming speech validation.
- Correct quota/error/reset handling with bounded non-durable cooldown state.
- Abort/499 handling and required-proxy fail-close behavior.
- Persona master/media/video gates start off; UC TTS/STT remain out of scope and disabled for the release.
- Optional/non-gating G3-D: metadata-only dynamic model discovery and quarantine after the static 19-ID core is ready.
- Negative tests proving UC Direct cannot become eligible.

## MaxAI implementation backlog

- Structured credential import; no one-string token replication.
- Atomic refresh and persistence across every credential field.
- Bounded signer discovery, last-known-good rollback, TTL, abort isolation, and one classified retry.
- Fail-closed Firefox-150/wreq selected transport across all proxy branches.
- Abort an already-dispatched signed request when transport fails.
- Cryptographic required tool nonce, requested-name allowlist, and argument schema checks.
- Typed handling of HTTP-200 paywall/quota/auth/error/null responses.
- Bounded response readers for chat, model discovery, image, upload, and STT.
- Final-v8 documents/PDF implementation with aligned ingress and file limits.
- All-document local prevalidation and explicit non-atomic remote-retention behavior.
- Incremental bounded upload SSE parser.
- Global byte-weighted PDF/tokenizer admission and worker isolation.
- STT auth before multipart parsing, effective body/file cap, chunked strategy, and nonempty result validation.
- Selected image/model refresh, persistence, cancellation, and URL policy.
- Regenerated lockfile, runtime assets, catalogs, documentation, translations, snapshots, and quality baselines.

## Not part of the core release

- UC Direct live use.
- MaxAI automatic full-conversation spill.
- MaxAI parallel lanes.
- MaxAI video or TTS.
- UC TTS, UC STT, or guessed Persona text-to-video.
- Claims of 13/13 MaxAI tools, instant signer self-heal, unlimited subscriptions, or universal prompt ceilings.

## Decisions

The implementation defaults are already settled. No new product decision is needed for G0–G8 unless the scope changes.

The later live canary still needs explicit approval for account, capability/model, total upstream transaction budget, quota/cost, pacing, egress, stop conditions, and promotion authority.
