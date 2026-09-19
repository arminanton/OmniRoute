# MaxAI multi-lane chats, conversation tracking, and reasoning

Current protocol design: `../workers/maxai-multilane-protocol-design.md`
Completed historical/extension recovery: `../workers/maxai-legacy-lane-recovery.md` and `../workers/maxai-extension-archaeology.md`
Owner decision: `09-owner-scope-update.md`

## Current conclusion

Do not treat six as the historical or technical maximum. Keep three mechanisms and evidence boundaries separate:

1. **Native saved extension panels:** stock v8.37.1 exposes layouts **1/2/3/4/6**. The shared composer retargets one ordinary scalar chat operation to each panel's own conversation and model. Each call has its own stream accumulator, message state, and UI state. No supported stock layout above six was recovered. That is a statement about this saved client, not a provider or historical maximum.
2. **Recovered host-shim council:** a separate Python coordinator has a configurable local ceiling of **30**, a direct outer trace for **7 seats with `parallel=7`**, and a committed **12-seat** aggregate plus its real-MaxAI driver. This is not the native panel UI. The retained artifacts do not enumerate successful provider requests per seat.
3. **Missing 30/32 episode:** the owner attests that a historical API episode triggered about **30 or 32** calls at once. Its request-level trace, completion set, IDs, and exact implementation have not been recovered. It remains owner-attested and unproved, **not disproven**.

The bundle expression `pro_chat ? 30 : 6` is a Google search-result extraction limit. Correcting that false citation does not negate either the recovered 7/12 host-shim evidence or the separate owner attestation. Latest OmniRoute final2 live-tested two lanes; its six-lane isolation and continuation results were offline only. None of these numbers sets a safe live concurrency policy.

## Native extension panels

The completed extension archaeology recovered this stock v8.37.1 path:

- The selector, route validator, defaults, grid, and locale support layouts 1, 2, 3, 4, and 6.
- A shared composer uses `Promise.all` across the active panel conversations.
- Each leg has one conversation object and ID, one selected scalar model, one normal `/gpt/cwc/chat` request, one stream accumulator, and separate user/assistant message IDs and parent state.
- The normal per-call parser merges that call's SSE frames. It removes provider-exposed leading `<think>...</think>` text from the answer and stores it as visible thinking metadata.
- There is no recovered multi-model request body, central shared stream mux, or supported stock >6 unlock.

This is static client architecture evidence. No retained native multi-panel capture proves live overlap, per-panel provider-returned IDs, positive concurrent reasoning, or provider capacity.

## Recovered host-shim council

The earlier host shim is a different mechanism. It contains `MAXAI_COUNCIL_FANOUT`, a configurable `MAXAI_COUNCIL_FANOUT_CEILING` with local default 30, council/panel/coordinator routes, and a `ThreadPoolExecutor` persona pool. The configured 30 ceiling and its tests are real local scheduler behavior, but the value came from the now-corrected search-limit interpretation. It is not a native extension layout or provider capacity proof.

Recovered execution evidence is narrower and stronger than a source-only claim:

- Five successful outer shim records declare `seats=7` and `parallel=7`. The final 36.9342-second request ran three **sequential** seven-seat council rounds and ended `REVISE → REVISE → ACCEPT`; it must not be described as 21 simultaneous lanes.
- A committed driver builds the real MaxAI `ChatService`, sets the worker fanout to 12 for the wide phase, and produced five completed narrow-versus-wide aggregate cases.
- The original inner Git backup is fsck-clean and binds the 12-seat driver/result and 7-seat force-run driver/result through commits `51477e8d...` and `dec963ab...`.

Neither artifact retains every seat's provider request/response IDs, timestamps, status, conversation/message chain, or provider-exposed reasoning. The 12-seat aggregate can complete even when an individual critic returns an error-shaped result. The safe claim is recovered **host-side MaxAI-backed 7/12 council execution**, not wire-proven provider concurrency or a native panel ceiling.

## Missing owner-attested 30/32 episode

The owner separately recalls an API episode supporting roughly 30 or 32 parallel calls. No retained 30/32 provider-wire record, implementation run, completion distribution, or per-call identity set has been found. The local shim ceiling of 30 is not that missing episode, and the extension's Google-result limit is not evidence for it. Preserve the episode as owner-attested history under recovery. Do not promote it to release proof, and do not mark greater-than-six behavior disproven.

## Extension model and Free/Mistral findings

The extension uses a cached dynamic model configuration shared with the web client; the recovered configuration routes are not extension-only. The newest saved catalog contains `mistral-7b-instruct-free` as non-deprecated `MAXAI_FREE`, group `free`, with an 8K limit. However:

- fallback and group/provider lists still use `mistral-7b-instruct`, while exact lookup has no recovered alias joining the two IDs;
- the stock Chat picker omits the FREE group;
- old `MAXAI_MISTRAL` / `mistral-large-2` data is deprecated residue;
- changing to free chat does not assign Mistral. It keeps the normal scalar chat request and existing conversation model;
- no `/mistral`, `/free`, extension-only generation endpoint, or current backend identity was recovered.

A historical explicit `mistral-7b-instruct-free` request returned a generic PING through the normal chat route. This proves historical request acceptance only. It does not prove current serving identity, automatic free-mode routing, or a new endpoint. Treat these values as catalog archaeology; do not silently add or route a model without current, separately approved validation.

## Required per-lane architecture

Every future lane must be a complete ordinary single chat. It must reuse the same validated request builder, stream parser, and provider-exposed reasoning splitter as the single-chat path. A coordinator may schedule and correlate lanes; it must not create a reduced parallel protocol or infer a batch endpoint.

Every lane owns:

- unique opaque local `run_id`, `lane_id`, `turn_id`, and `attempt_id` values allocated before dispatch
- requested, resolved, and returned model identity
- a unique provider conversation identity with mode-correct scope: per attempt in request-replay, stable per lane in native-thread mode
- unique provider-protocol user/assistant message IDs and exact parent chain in native-thread mode
- provider-returned request/response IDs only when the wire actually supplies them
- one ordinary request context and response object
- one private stream accumulator and normal stream parser
- one private provider-exposed reasoning splitter
- tool nonce, allowed tools, tool calls, and results
- cancellation and timeout tree
- terminal status/error
- continuation revision and history

The system supports two explicit modes:

### Request-replay mode

Current OmniRoute style:

- fresh provider request conversation UUID,
- caller-supplied full history replay,
- no claim of durable provider-thread identity.

### Native-thread mode

Gated until recovered and validated:

- one stable provider conversation per lane,
- append user/assistant messages,
- preserve message IDs and parent chain,
- journal ambiguous provider effects,
- continue a selected lane or all lanes without cross-wiring.

A lane never changes mode mid-conversation.

## Streaming and reasoning

Reasoning means only text/fields the provider exposes, such as `<think>...</think>` narrative. It does not mean hidden internal chain-of-thought.

Each lane runs a separate instance of the hardened normal single-chat accumulator, parser, and reasoning splitter:

1. bind the response to that lane's unique IDs before reading its first byte,
2. receive only that lane's SSE stream,
3. classify terminal/error frames,
4. split provider-exposed reasoning from visible answer,
5. parse authorized tools only after reasoning separation,
6. persist answer/reasoning hashes and safe metadata under that lane ID,
7. preserve deterministic display order even when lanes finish out of order.

The latest two-lane live run returned no reasoning payload. Offline tests proved synthetic reasoning isolation through six lanes. The recovered 7/12 host-shim artifacts and missing 30/32 episode retain no per-seat provider-exposed reasoning, so they do not close the positive concurrent-reasoning gap.

## Persistence and recovery

The coordinator must use:

- write-ahead provider-effect records,
- compare-and-swap lane revisions,
- outbox for provider actions,
- explicit `ambiguous` state after uncertain network effects,
- no blind retry,
- reply-all against a revision-pinned lane snapshot,
- selected continuation addressed by stable `lane_id`, not panel ordinal.

## Capacity policy

Do not encode the extension layout six, shim ceiling 30, recovered 7/12 seat counts, or attested 30/32 episode as a provider capacity claim.

- Logical lane count is configurable local capacity.
- Active live concurrency is a separate account-scoped operations policy.
- Current live policy prohibits parallel provider calls.
- Any future live use requires a reviewed policy revision, terms/provider basis, explicit envelope, account-scoped admission, and a staged test.
- Recovered history can shape test cases, but no recovered or attested number automatically becomes a scheduler setting.

## Validation path

### Offline

- one ordinary request/conversation context and one normal accumulator/parser/reasoning splitter per lane
- unique run/lane/turn/attempt IDs, plus mode-correct conversation/message/parent identity
- reverse completion order
- reasoning present/absent
- tool isolation
- reply-all and selected continuation
- cancellation, timeout, malformed stream, auth/rate failure
- restart/reconciliation and duplicate delivery
- many logical lanes behind a low active mock cap

### Later live, only after policy revision

Begin with the smallest approved concurrency. Expand only after observation, budget, and stop criteria pass. Do not jump directly to the historical maximum.

## Release disposition

- Core MaxAI ships without multi-lane coordination.
- Multi-lane is a separate default-OFF project.
- Automatic context spill is separate and must not be bundled.
- The recovered 7/12 host-shim evidence does not authorize live fanout.
- The exact owner-attested 30/32 episode remains a recovery target, not an overruled or disproven claim.
- UC TTS and UC STT remain deferred/OFF and outside this project.
