# MaxAI extension findings

Full report: `../workers/maxai-extension-archaeology.md`
Published provenance: `../evidence-index/extension-analysis/`

## What was inspected

Saved MaxAI v8.37.1 artifacts include:

- Chrome MV3 package
- Firefox port/XPI
- website route chunks
- retained network-response chunks from browser captures
- manifests, Webpack runtime maps, dynamic imports, local-storage schema, and model catalogs

No extension code was executed and no provider request was made. Minified files were converted into deterministic local-only beautified copies. The repository publishes hashes and inventory, not the third-party JavaScript copies.

## Native multi-panel path

The recovered stock UI supports layouts:

`1, 2, 3, 4, 6`

The same set appears in:

- layout selector
- route/query validator
- enum
- six model slots
- persisted layout map
- renderer/grid
- English labels

The shared composer:

1. takes the active conversation IDs for the layout,
2. clones the outgoing action per panel,
3. rewrites that action with the panel conversation ID,
4. assigns the panel model/provider,
5. invokes the normal chat runner,
6. awaits all legs with `Promise.all`.

Each leg then sends one scalar `/gpt/cwc/chat` request. There is no recovered batch endpoint or automatic judge/synthesis layer.

## Per-panel identity and streams

The stock path associates each panel with:

- a conversation ID,
- a selected model/provider,
- cloned message/action metadata,
- a separate per-conversation stream accumulator,
- a separate chat component and display order.

This directly supports the design requirement: each future OmniRoute lane should run the same ordinary single-chat protocol and parser rather than a reduced “parallel result” protocol.

## Reasoning

The recovered client handles only provider-exposed text. It removes inline `<think>...</think>` content from the visible answer and records it as `metadata.thinkingText` for that conversation.

It does not expose hidden internal chain-of-thought.

No retained native multi-panel run exercised this path, so per-panel live reasoning demultiplexing is supported by static code but not a recovered live trace.

## More-than-six evidence

No stock extension end-to-end unlock above six was found in the recovered selector, route validator, enum, renderer, defaults, model slots, beta flags, lazy chunks, or local-storage schema.

That does not disprove the separate Hermes/shim episode:

- seven-seat aggregate host trace recovered,
- twelve-seat real-ChatService aggregate harness recovered,
- configurable 30-seat host council ceiling recovered,
- owner-attested 30/32 episode still missing at request-trace level.

Native panels and host council fan-out are different mechanisms. Neither should be used to erase the other.

## The unrelated 30 value

`pro_chat ? 30 : 6` was located inside `GET_CONTENTS_OF_SEARCH_ENGINE`. It controls Google result breadth, not chat panels.

This corrects that one source citation only. It does not prove that no other 30-lane host implementation existed; the shim source proves that a separate configured 30 council ceiling did exist.

## Lazy-loading and source maps

- Manifest entry points and dynamic imports were traced.
- Retained browser captures prove the critical chunks were fetched.
- No usable MaxAI source maps or `sourcesContent` were recovered.
- Chrome and Firefox critical capability chunks are byte-identical.
- The Chrome signed inventory matched 608/608 content hashes; the publisher signature itself was not independently verified.

## Model/free-tier findings

The newest saved catalog has:

- 40 chat entries total
- 14 active entries
- `mistral-7b-instruct-free` under `MAXAI_FREE`

However:

- aliases still reference unsuffixed `mistral-7b-instruct`,
- the stock picker hides the FREE group,
- `MAXAI_MISTRAL` / `mistral-large-2` appears deprecated,
- no extension-only Mistral endpoint or current backend identity was proven.

Treat Mistral/free models as catalog evidence requiring a separate current metadata and capability review—not as a ready route.

## Implementation implications

1. Reuse normal chat request and stream/reasoning parsing per lane.
2. Store stable local lane identity separately from provider conversation identity.
3. Preserve panel/lane model and conversation mapping through continuations.
4. Never share stream accumulator, reasoning parser, tool state, or abort controller across lanes.
5. Keep native-thread behavior gated until append/upsert/message-parent semantics are validated in current code.
6. Do not hard-code six as a provider maximum.
7. Do not authorize 30 concurrent calls from the historical host ceiling.
8. Keep logical-lane capacity separate from permitted live concurrency.
