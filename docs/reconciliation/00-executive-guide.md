# Executive guide

## Bottom line

OmniRoute is not yet fully usable with both providers.

- **UC Persona:** not usable in the current live container because the image contains no UC implementation.
- **MaxAI:** the deployed image has one recent basic-chat success, but current operational readiness is not established. It is a mixed historical validation image, and the recovered safer attachment, STT, auth, tool, timeout, and resource controls are not reconciled into one current build.
- **UC Direct:** intentionally excluded. It is metered pay-as-you-go and is not part of normal routing or validation.

The repair is not “deploy an old image.” The old UC and MaxAI improvement trees are divergent. The correct approach is to port reviewed concerns onto one current upstream base, build one immutable combined image, and enable capabilities in stages.

## Direct answers

| Question | Answer |
|---|---|
| Is UC Persona working live? | No. The audited live image has no UC files. |
| Is MaxAI fully repaired? | No. The deployed image has one recent basic-chat success, but operational readiness is not established and important recovered fixes are not in one clean current candidate. |
| Is there a universal prompt maximum? | No. MaxAI has a 400,000-character cross-model safe point and one 6,000,000-character single-model success. UC Persona has a historical 480,586-character success. None is a universal ceiling. |
| Does current OmniRoute automatically upload huge prompts as files? | No. Only an excluded prototype does this when either assembled JavaScript characters or UTF-8 bytes exceed 400,000. |
| Which MaxAI files were live-tested end to end? | TXT, PDF, DOCX, PNG, and JPG. |
| Which UC Persona files were live-tested end to end? | PDF input and PNG vision. Image generation and image-to-video were also proven. Repaired TTS is retained as historical evidence but is now deferred/OFF because speech consumes AI credits. |
| Did more than six MaxAI lanes work historically? | Yes at the host-aggregate level: a seven-seat direct trace and committed 12-seat real-`ChatService` harness were recovered. The exact owner-attested 30/32 per-request trace remains missing. Native UI panels (1/2/3/4/6), host council seats (7/12 with configurable 30 ceiling), and latest two-lane OmniRoute proof are separate evidence boundaries; none authorizes live concurrency. |
| Is reasoning captured for parallel MaxAI lanes? | The code can separate provider-exposed `<think>` text and offline tests isolate it. The two-lane live run returned no reasoning payload. Hidden chain-of-thought is neither available nor claimed. |
| Does UC Persona detect new models dynamically? | No. OmniRoute still exposes 19 static Persona IDs while retained web evidence shows the upstream roster grew to 32. |
| Can live validation start now? | No. G0–G8 must pass first. |

## Target operating model

After reconciliation:

- MaxAI is the normal general provider after readiness.
- UC Persona is a manual-only route named `uc-persona-manual`; it is never an automatic fallback.
- UC Persona uses canonical ID `uc-persona`, while legacy `uc` and `ucn` inputs remain compatible.
- UC Direct stays disabled and ineligible.
- Both providers use one immutable, digest-pinned OmniRoute image.
- Provider readiness is checked by capability, not inferred from container health.
- Live calls use an approved residential connector, one active operation per account, genuine user-authored prompts, and explicit request budgets.

## What “fully usable” means

### UC Persona

1. Correct login/session and legacy-ID migration.
2. Chat, streaming, tools, vision, one document, image generation, captured image-to-video, cancellation, and quota handling. UC TTS/STT remain disabled and out of core.
3. Static reviewed 19-model core. Metadata-only dynamic discovery is a recommended optional G3-D follow-on; new IDs stay quarantined until separately approved.
4. Manual-only routing and capability-specific readiness.

### MaxAI

1. Correct dynamic signing, refresh, token persistence, and selected residential transport.
2. Chat, streamed reasoning that the provider actually exposes, authorized prompted tools, vision, image generation, documents/PDF, and STT.
3. Bounded request/response memory, PDF worker admission, typed terminal errors, and exact file limits.
4. Parallel lanes only as a separate default-off feature after the core provider is stable.

## Read next

- `01-what-is-pending.md`
- `02-inputs-files-and-media.md`
- `03-maxai-parallel-lanes.md`
- `04-uc-model-discovery.md`
- `05-residential-operations.md`
- `06-implementation-roadmap.md`
