# Owner scope update: MaxAI lane ceiling and UC speech

Recorded after the initial reconciliation guide.

## D1 — Keep native panels, host council, and the missing 30/32 episode separate

The completed recovery establishes three different evidence boundaries:

1. **Native stock extension:** saved v8.37.1 exposes panel layouts 1/2/3/4/6. Each panel gets its own conversation/model, ordinary scalar chat request, per-call stream accumulator, message state, and provider-exposed `<think>` parsing. No supported stock layout above six was found. This does not establish a historical or provider maximum.
2. **Recovered host shim:** a separate Python council has a configurable local ceiling of 30. Five successful outer trace records declare seven seats with `parallel=7`; a committed real-`ChatService` driver and aggregate cover a 12-seat wide phase. These artifacts do not retain a successful provider receipt, IDs, timestamps, or reasoning stream for every seat.
3. **Owner-attested 30/32 episode:** the owner recalls about 30 or 32 API calls being triggered at once. The exact request-level trace, completion set, and implementation remain missing. This episode is owner-attested and unproved, not disproven.

The extension expression `pro_chat ? 30 : 6` controls Google search-result breadth. It is not a panel or chat ceiling. The host shim's local ceiling of 30 is real configuration, but it inherited that mistaken rationale and is not proof of provider capacity.

Disposition:

- Do not treat six as the historical or technical maximum.
- Do not merge extension panel counts, host council seat counts, or the owner-attested 30/32 episode.
- Describe 7/12 only as recovered host-side MaxAI-backed council execution, not wire-proven upstream concurrency.
- Preserve the exact 30/32 episode as missing owner-attested evidence; do not say greater-than-six behavior is disproven.
- Do not enable live parallel calls until a separate policy revision, provider/terms basis, explicit envelope, and staged approval exist.

## D2 — Every future lane is one normal chat with unique identity

Each future lane/panel must have:

- unique opaque local run, lane, turn, and attempt IDs allocated before dispatch,
- one mode-correct provider conversation identity that is never shared across lanes,
- unique provider-protocol user/assistant message IDs and exact parent state in native-thread mode,
- provider-returned request/response IDs only when the wire supplies them,
- requested, resolved, and returned model identity,
- one ordinary single-chat request context and response,
- its own normal single-chat stream accumulator/parser,
- its own provider-exposed reasoning splitter and text,
- separate history, tool calls/results, cancellation, timeout, terminal status, and continuation state.

The coordinator only schedules and correlates these complete single-chat operations. It must reuse the hardened normal-chat request, stream, and provider-exposed reasoning code. It must not invent a batch endpoint, central stream mux, or reduced parallel response path.

## D3 — UC TTS and STT are not core scope

UC speech consumes AI credits and is not required for the intended Persona use.

Disposition:

- UC TTS: recovered historical evidence retained, but implementation/enablement/live validation deferred and OFF.
- UC STT: absent and out of scope.
- No UC speech request is permitted in G0–G10 for this release.
- Reopening either requires a separate explicit owner decision, credit budget, and live envelope.

UC Persona core becomes: text/streaming, provider-exposed reasoning, tools, vision, one reviewed document, image generation, capture-backed image-to-video, quota/cancellation, identity/migration, and manual-only routing.
