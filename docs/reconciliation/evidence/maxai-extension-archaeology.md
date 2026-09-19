# MaxAI extension archaeology

> **Cross-source update:** Separate legacy archaeology later recovered direct aggregate seven-seat execution, a real-ChatService 12-seat aggregate harness, original inner Git provenance, and a configurable 30-seat host council ceiling. The exact 30/32 per-provider request trace remains missing. This does not change the extension finding that the recovered stock native UI supports 1/2/3/4/6; it shows that host council fanout was a separate >6 mechanism.


## Scope and verdict

This was a read-only archaeology pass over saved artifacts. I made **no MaxAI, UC, provider, login, discovery, or egress request**. I did not execute an extension or change an OmniRoute/Hermes worktree, runtime, database, capture, or extension source. The only new files are this report and deterministic analysis copies under local-only `private-evidence/maxai-extension-archaeology-analysis/`; publication-safe hashes/inventory are copied to `evidence-index/extension-analysis/`.

Evidence root: `/mnt/devvm/custom/MaxAI` (also reached through `/home/ndsadmin/_/MaxAI`). The relevant saved files are clean at repository `HEAD 8d2bf176b385210beff7ac5888cbef4cbcbb8ded`; unrelated pre-existing changes remain elsewhere.

### Verdict

1. **Recovered native mechanism:** stock v8.37.1 has layouts **1, 2, 3, 4, 6**. A shared composer runs `Promise.all`, retargeting each cloned action to one panel conversation ID and model. Each leg builds a normal scalar `/gpt/cwc/chat` request and owns separate stream/message/UI state.
2. **No recovered >6 unlock:** no larger enum, selector, route value, grid, default, flag, model slot, or lazy chunk was found. A generic list helper lacks a local numeric bound, but no stock caller supplies >6 and the rest of the route/UI chain blocks it. This is not an unlock.
3. **This does not disprove >6.** Six is the largest recovered native layout, not a provider/historical maximum. `docs/09-owner-scope-update.md` records owner-attested historical Hermes behavior substantially above six; later archaeology recovered seven/twelve aggregate host evidence, while the exact 30/32 request trace remains unrecovered.
4. **Thirty is search breadth:** `pro_chat ? 30 : 6` is inside `GET_CONTENTS_OF_SEARCH_ENGINE` for Google results. It is not a panel/chat limit. No 30/32-panel proof exists.
5. **Reasoning means provider-exposed text only:** the client removes inline `<think>...</think>` text from the visible answer and stores it as `metadata.thinkingText`. It does not expose hidden chain-of-thought.
6. **Mistral is nuanced:** fallback code has `mistral-7b-instruct`/`MAXAI_FREE`; the newest saved catalog has `mistral-7b-instruct-free`. Its group/provider aliases still use the old ID, the stock picker hides FREE, and `MAXAI_MISTRAL` is deprecated residue. There is no extension-only Mistral route or proved current backend identity.
7. Native multi-panel wire behavior and provider capacity remain unresolved. UC TTS/STT remain deferred/OFF and were not tested.

## 1. Package, entrypoint, and lazy-chunk inventory

### Chrome / Firefox identity

| Artifact | Direct facts | SHA-256 |
|---|---|---|
| `extension/manifest.json` | 3,358 B; lines 5, 9-12: v8.37.1, MV3, module service worker `background.js`; content wrapper at line 20 | `ebe82284314059b5ac6b95e63d45abe7f107379c96f8135e31f296f445a6ce7d` |
| `extension/_metadata/verified_contents.json` | 96,523 B; signed-payload inventory says version 8.37.1 and 608 vendor files. Independent Chromium tree-hash recomputation matched 608/608. Publisher RSA signatures were not independently verified. | `95c42e6948dda9986beb9f80b96112c9a0faa25983f0cfc4d69fc68fa0de7189` |
| `extension-firefox/manifest.json` | 3,528 B; lines 3, 7, 19-23: v8.37.1 MV3 Firefox background-script form. Private Gecko ID omitted. | `a5b5fe4f847d5823b2ab42004868e832fe5b758bcf1c3a2242f46e4761394ada` |
| `maxai-firefox-8.37.1.xpi` | 32,288,248 B; 605 files, all byte-identical to `extension-firefox/`; zero `META-INF` entries, so it is unsigned | `a2efa3c6b2c49385d26dac2256c1dd04f08a687d1fec650976c121a96e8381c8` |

Chrome and Firefox have the same 199 JS/MJS paths. **198/199 are byte-identical**; only `background.js` differs for the Firefox port. All capability chunks cited below are identical. A saved CRX was not verified.

### Entrypoints and reachability

The manifest reaches `background.js`, `import_content.js`, settings, popup, and content scripts. I computed literal import closure across all 198 `.js` files. Every referenced JS target exists.

```text
manifest -> import_content.js -> content.js
content.js byte 1428 -> chunks/FHKQS6FH.js -> chunks/6GSZNDSL.js
content.js byte 1582 -> chunks/ZBIDAW4O.js -> chunks/AJLSRNNV.js
                                             -> P6DBQQEF.js + 6GSZNDSL.js
pages/settings/index.js line 1 -> P6DBQQEF.js + 6GSZNDSL.js
```

Key raw files:

- `extension/content.js`: 1,918 B, SHA `1877563cc298d9ee424a1473638acff2a51443b40be27ef6bf6a8d22d308b2d7`; six literal dynamic imports at bytes 1089, 1186, 1252, 1428, 1582, 1700, all retained.
- `extension/pages/settings/index.js`: 64,975 B, SHA `f90a87bdab898de9acd2fe7a3b2ff689b584f10292d8fd3d141e54194e3e27f9`; line 1 imports the critical chunks.
- `extension/chunks/P6DBQQEF.js`: 750,967 B, SHA `0d30f1a8cfe632639bbde3fec7c650615cd7358cc588a8591de7fc02a7dae736` — panel selector, broadcast, grid.
- `extension/chunks/6GSZNDSL.js`: 2,563,810 B, SHA `97273b89236b4f5d58ff658c19034f8ab8d7cae3fadd49839128e87ccdb3bce0` — storage, conversations, request, SSE/reasoning.
- `extension/chunks/V7VTM2NH.js`: 58,460 B, SHA `ba78582b2d8ab29100c2ed07560f1a580cf0d26f2ae349056117696e47a12f31` — catalog/cache.
- `extension/chunks/O4YOWW5G.js`: 10,728 B, SHA `794bd4b4c46743225b60931371145c4ab62d391920df56e3ae61b60da87518ea` — model menus/groups.

Web route loading is explicit: `site/www.maxai.co/app/index.html` (SHA `e5da1387156efe2e70611bc249982e2145611c0eaabc3fd244623b8e53dda9d5`) lists 41068/61954/37974; `chunks/pages/app-af45b4cd46252f02.js` (SHA `5a5d172c7946a6f6db47e2c9a9eb2b7b4c67ae15294edf19dce4587cf0657f2c`) line 28 lists their IDs; `_buildManifest.js` (SHA `ca9cba84c5a407e09bfb54f287488cd640bc46898134a98b45b4e46f36415531`) line 30 ties them to `/app`; webpack runtime (SHA `c63be5553922c36c638b8f0aafdc6a9714e0c7d900d306f97ffca17714b732e7`) line 76 maps IDs to URLs.

### Deterministic readable copies

I ran only `js-beautify 1.15.4 --indent-size 2 --end-with-newline --no-preserve-newlines`. `evidence-index/extension-analysis/PROVENANCE.tsv`, `INVENTORY.json`, and `RELOCATION.json` bind source paths, ignored local outputs, sizes, hashes, and generation commands. The third-party JavaScript copies are not published.

| Copy | Source SHA | Copy SHA |
|---|---|---|
| `P6DBQQEF.pretty.js` | `0d30f1a8cfe632639bbde3fec7c650615cd7358cc588a8591de7fc02a7dae736` | `9cf4044a9f60682e1fb0c374568ac9793ec3aca0de1e6825797d0d078a0c00c4` |
| `6GSZNDSL.pretty.js` | `97273b89236b4f5d58ff658c19034f8ab8d7cae3fadd49839128e87ccdb3bce0` | `dd38e31149b9051548e4dc4dd198d3dbf415e4c4ad0855fa8c4bfdae776c1344` |
| `V7VTM2NH.pretty.js` | `ba78582b2d8ab29100c2ed07560f1a580cf0d26f2ae349056117696e47a12f31` | `61559642d92bf33efcaea4133d3e31449e9e85c52f73caf8493660f0fe9a0646` |
| `O4YOWW5G.pretty.js` | `794bd4b4c46743225b60931371145c4ab62d391920df56e3ae61b60da87518ea` | `0dc95a6706504b03b0917ad02478a9d6a1df91895b893301b78c4695f37fea95` |
| `cap379.pretty.js` | `284a133cb41985eaaea910656f0437a5c2cc4fa2a4f0d241ef8f840a349f26b0` | `aeb0a278275e74aad6c1ca5b74176e7995a02974f51f7777be37408210d1a45d` |
| `capture-41068.pretty.js` | `09aeb6ae5d57571ec25b1dad45905f06ebb3d57610f57008a53fbdf02c1a1b7f` | `f1340994515c87720b4c7f8c121e3d45a9f21f44adf375e64cefcc38120c73d8` |
| `capture-61954.pretty.js` | `14a37dff8396f7e6bcab758094f4d22dca152e90c2a160fe760276376e4bb5e0` | `41e1d580f836bcf3c087972f4b37c93dc517836f44382ce9a76e9a859f920bb5` |
| `capture-97888.pretty.js` | `f26dc7ce2b9e84f2690df74b0e797e7f6f88b54b85c93fc8be4635903fa68fc5` | `3f94ae011b865bb931c78be8c430fcbc14f99ab394a39d2f0cd3fc0ce4819dde` |

## 2. Source-map and capture archaeology

### No recoverable MaxAI maps

This negative result is bounded:

- Chrome signed inventory: 608 files, 199 JS/MJS, zero `.map`.
- Firefox XPI: 605 files, 199 JS/MJS, zero `.map`, source-tree, or `node_modules` paths.
- All packaged JS/MJS: zero `webpack://`, `vite://`, `sourceURL`, real anchored source-map directives, or parsed embedded source-map objects.
- Saved `site/`, `bigger/`, MaxAI capture bodies, and reachable repository history contain no MaxAI source maps.

`6GSZNDSL.js` contains third-party *source-map library implementation*. Its strings `sourceMappingURL` at bytes 1,171,150, 1,171,345, 1,178,323, 1,178,795 parse/emit annotations; they are not a directive for this file. `GTMUK5EY.js` byte 150,628 builds a worker-loader string. Neither yields original `sourcesContent`.

One real source-path label survives at raw `6GSZNDSL.js` byte 1,377,996 (physical line 155), just before `sendQuestion`:

```text
@maxai-client/features/chat/service/chat-ask/ChatAskService.ts
```

The same label exists in web 41068. It identifies only that service; other minified modules cannot be assigned invented filenames.

### Retained chunk-response proof

| Raw captured body | Bytes / SHA | Matching request receipt |
|---|---|---|
| `capture/runs/run-20260714-193021/bodies/resp-0059-37974-73f7312a1f44f6bb.js.bin` | 26,301 / `284a133cb41985eaaea910656f0437a5c2cc4fa2a4f0d241ef8f840a349f26b0` | same run `net.jsonl:55`, GET exact 37974 chunk URL |
| same run `resp-0057-61954-6daf701966d403c0.js.bin` | 534,547 / `14a37dff8396f7e6bcab758094f4d22dca152e90c2a160fe760276376e4bb5e0` | `net.jsonl:54`, exact 61954 URL |
| `run-20260714-215419/.../resp-0131-41068-da84cf3cda187570.js.bin` | 571,343 / `09aeb6ae5d57571ec25b1dad45905f06ebb3d57610f57008a53fbdf02c1a1b7f` | `net.jsonl:50`, exact 41068 URL |
| same run `resp-0059-97888-85c99044eaf6961c.js.bin` | 118,317 / `f26dc7ce2b9e84f2690df74b0e797e7f6f88b54b85c93fc8be4635903fa68fc5` | `net.jsonl:54`, exact 97888 URL |

37974 is duplicated 44 times byte-identically across 18 saved run directories; 61954 48 times across 18; 41068 50 times across 16; 97888 24 times across 15. This proves the browser loaded those chunks. It does **not** prove multi-panel use.

Separate readable saved site files have SHA-256: 37974 `7b9f5eea36cd7afdbaec039a727d859367ae609d4b3099c17bcb1159319edc21`; 61954 `301ee76f87c1961eb89e123b39fdb68dc5ef2232fb93aec821ef350b2a3c7edd`; current 41068 `92989a8f1c4c58c780fb9b0264405e740a1ee6099a40e43798ece229f03f24ec`; 97888 `254b2734e695cb6a826067a3e508a2172350845e991bd923cb0d8b4d8def531c`.

## 3. Native UI control to request trace

### Layout enum, selector, route, and renderer

Raw extension `P6DBQQEF.js`:

- byte **583,877**: complete selector list has layout 1, 2, 3, 4, 6.
- bytes **584,721-584,856**: create missing conversations and set the chosen layout.
- byte **617,569**: final grid branch is `layout===6`; byte **617,746** displays only `:nth-of-type(-n+6)`.

Readable copy `P6DBQQEF.pretty.js:28922-28937`:

```js
[{layout:1,...}, {layout:2,...}, {layout:3,...},
 {layout:4,...}, {layout:6,...}]
```

The captured web route also validates count. `capture-97888.pretty.js:3557-3573` parses query `models` and accepts only `[1,2,3,4,6]`; raw accept-list byte **68,814**. It parses conversation IDs using `id.split("_")`, creates missing ones up to the accepted count, and serializes with `id: ids.join("_")` at lines 3601-3608.

Web enum: `bigger/.../37974...js:871-878` and `cap379.pretty.js:892-899` recover `ONE=1, TWO=2, THREE=3, FOUR=4, SIX=6`. English locale `extension-firefox/i18n/locales/en/index.json:2705-2709` (SHA `d3521c26ee62f05bf134913d7a2c906a668806db5a6f3c01ea656c19f5013879`) ends with `"Chat with 6 AI models"`.

### State, arrays, and model slots

- `6GSZNDSL.pretty.js:26853-26894`: catalog defaults `chat_hub.free_user[0..5]`.
- `:26897-26938`: `paid_user[0..5]`.
- `:26940-26948`: generic `chatHub[index] = {AIProvider,AIModel}` setter.
- `:27978-28018`: exactly six default Chat entries plus `MaxAIClientChatHubLayoutMap` and `MaxAIClientChatHubLayoutCount` keys.
- `:28019-28055`: stored map is merged only over the six-entry default `.length`; extra persisted entries are not returned.

`docs/browser-storage/LocalStorage.json` (SHA `9963908b619e91653a4f0869a6c66edbdfd508d971730a6107d6c3ed57617305`) is a decoded **website-origin** snapshot, not extension storage proof. It corroborates the schema: lines 1455-1507 six catalog defaults; 1644 stored count 1; 1983-2035 layout map; 2041-2103 selector state. Nearby `search.maxResultsCount:6` is a search setting. Safe beta flags contain no lane-count/unlock switch.

### Shared-composer fanout

Raw P6 anchors: active slice byte 613,802; non-Pro clamp byte 614,432; `Promise.all` byte 614,484; question-ID rewrite 615,037; runner follows; stop-each byte 615,401. Readable `P6DBQQEF.pretty.js:30532-30590`:

```js
active = conversationIds.slice(0, layout)
if (localSettings.chatMode !== "pro_chat") layout = 1
await Promise.all(active.slice(0, layout).map(async (conversationId, index) => {
  // select primary chat model or chatHub[index]
  // clone actions
  action.message.conversationId = conversationId
  action.message.metadata.AIModel = panelModel.AIModel
  action.AskChatGPTActionQuestion.conversationId = conversationId
  return askAIWithShortcutsV2_or_V1(..., {conversationId})
}))
```

Web capture corroborates at `cap379.pretty.js:540-612`, raw fanout byte 11,022. Each ID renders in its own chat component with `chatHubOrder` (`P6DBQQEF.pretty.js:30792-30864`; web 37974 lines 795-865). `Promise.all` results are not judged/synthesized; aggregation is side-by-side panels.

A generic conversation-creation helper (`beautified/extension...6GS...:44195-44212`; web 41068 lines 8326-8340) maps caller-supplied `layoutModels` without a local numeric check. It is **not** a recovered >6 feature: no stock caller supplies >6, route validation rejects other values, defaults stop at six, and selector/grid only know the enum.

### Panel model to scalar request

- `P6DBQQEF.pretty.js:12652`: visible model tabs are FAST/SMART/REASONING.
- `:12668-12710`: choice resolves a descriptor.
- `:12969-12987`: slot 0 uses `setChatAIModelAndProvider`; other slots use `setChatHubAIModelAndProvider(index, model)`.
- Saved pretty `beautified/extension...6GS...:44175-44212`: model change writes `conversation.meta.{AIProvider,AIModel,maxTokens}` and layout-map slot.
- Deterministic `6GSZNDSL.pretty.js:31644-31653`: the ask action passes that provider/model and same conversation ID to `sendQuestion`.
- `:31143-31163`, raw byte **1,379,298**: one body has scalar `chat_mode`, scalar `conversation_id`, scalar `model_name`, and `message_content`.
- `:31219`: normal route is `cwc/chat`; `:31398-31415`: `fetchSSE(`/gpt/${T}`)` parses frames into that call's accumulator.

The sequential native lifecycle is documented in private-audit `MAXAI-REAL-WIRE-FORMAT.md` (SHA `8bf1b65fd528cb2ebe2d0addf5b89437482f5431edf3333adaeb00e386c0ad1d`): user `add_messages` with conversation/message/parent IDs; scalar chat; AI `add_messages`; conversation upsert. A captured 23-turn thread kept one conversation ID and `chat_history:[]`. This is sequential proof, not multi-panel proof.

## 4. Stream demux, reasoning, and IDs

### Per-call stream accumulator

`6GSZNDSL.pretty.js:30639-30681` (raw offsets **1,368,842** and **1,369,045**) expands compact fields `K/T/S/M/V` to `data_key/data_type/streaming_status/need_merge/value`. With `need_merge`, text appends, JSON arrays concatenate, and JSON objects merge; otherwise data assigns/overwrites.

`sendQuestion` creates one accumulator containing that leg's conversation ID (`:31256-31265`). The `fetchSSE` closure feeds frames only into it (`:31398-31415`). Higher up, that action persists its answer under the same conversation (`:31648-31655` onward). Together with one shortcut engine and component per conversation, this is static per-panel demux. No central multi-stream mux was found.

### Provider-exposed reasoning only

`6GSZNDSL.pretty.js:30639-30647` accepts a closing tag or end-of-text. Lines 30725-30738 apply it when text starts with optional whitespace and `<think>`, remove the block from answer text, and save `originalMessage.metadata.thinkingText`. Web equivalent: `beautified/site...41068...pretty.js:14308-14324,14483-14497`, SHA `a7808ea27e3f2b028d2967c089062493919341e3165d2286585c8b7db0ef538a`. UI display: `bigger/.../61954...js:12358-12433`, SHA `301ee76f87c1961eb89e123b39fdb68dc5ef2232fb93aec821ef350b2a3c7edd`.

This is provider-exposed stream text, never hidden chain-of-thought. The extension parser is narrower than the historical shim's multi-tag parser. Static separation is recovered; positive live multi-panel reasoning isolation is not.

### Conversation and message identity

The client creates one conversation object per panel. In the ask action, it creates a user `messageId`, reads the latest message, and sets `parentMessageId` (`beautified/extension...6GS...:46683-46711`). Deterministic lines 31619-31620 create the AI message ID and parent it to the user message. The scalar request uses the same conversation ID.

Source targeting:

- shared composer -> every active conversation;
- compare answers -> current response's `conversationId` (`bigger/.../61954...js:13681-13741`);
- regenerate -> one supplied conversation and its saved actions (`beautified/extension...6GS...:69044-69083`).

No retained parallel capture proves provider-returned per-panel IDs, reply-all, selected-lane continuation, branching, restart/resume, or failure ordering on the wire.

## 5. Correcting the false 30-panel lead

`6GSZNDSL.pretty.js:33179-33198`, raw byte **1,426,059**:

```js
{
  type: "GET_CONTENTS_OF_SEARCH_ENGINE",
  parameters: {
    URLSearchEngine: "google",
    URLSearchEngineParams: {
      q: ..., region: "",
      limit: chatMode === "pro_chat" ? 30 : 6,
      ...
    },
    URLSearchEngineExtractDetails: chatMode === "pro_chat"
  }
}
```

This controls Google result extraction. It does not touch the chat-hub selector, route validator, conversation array, or chat fanout. Current web equivalent: `site/.../41068...js:22583-22599`. Another `maxCount:30` is a file limit. Thus:

- native panel layout recovered: 1/2/3/4/6;
- search result breadth: 6/30 by mode;
- no 30/32 chat layout recovered;
- no claim about technical/provider capacity above six.

Earlier reports that promoted this search value to a concurrency ceiling are superseded.

## 6. Model catalog, hidden groups, free route, and Mistral

### Catalog/cache implementation

`V7VTM2NH.pretty.js` (source SHA `ba78582b2d8ab29100c2ed07560f1a580cf0d26f2ae349056117696e47a12f31`, copy SHA `61559642d92bf33efcaea4133d3e31449e9e85c52f73caf8493660f0fe9a0646`):

- lines 67-88: fallback `mistral-7b-instruct`, `MAXAI_FREE`, group free, 8K, non-deprecated;
- 1082-1141: cache key `MAXAI_MODEL_CONFIG_CACHE`; POST config version/full config; parameter `client_type: extension|web`; cache `{version,timestamp,data}`;
- 1238-1251: exact `model_name` or `old_model_values` lookup.

The same logic exists in website 86042. `analysis/COMPLETE_ROUTE_INVENTORY.json` (SHA `0db4dc3789de56f0a05a586a19735579930d15e0d6a027ff9aca76cc1d9b40d2`) classifies both config routes as **BOTH**, not extension-only.

### Newest saved catalog and drift

Newest direct saved response: `capture/runs/run-20260722-005931/decoded/bodies-decoded/get_config(2)`, 35,219 B, SHA `880bb08e5074fbd9a1dc46a237ae1b86689aa815eee75e41c7a4a1dbd3c3d5d6`. It is one-line JSON, so byte offsets are used:

- byte 787: active `gpt-5.6-luna`; byte 19,081: `claude-5-sonnet`;
- byte **9,754**: `mistral-7b-instruct-free`; its record is `MAXAI_FREE`, free, 8K, non-deprecated, `thinking_mode:false`;
- bytes **28,718** and **30,930**: free group/provider lists instead use `mistral-7b-instruct`;
- no `old_model_values` connects them, while the resolver is exact;
- 40 chat + 6 image records exist, but only 14 chat records are non-deprecated: 1 free, 6 fast, 3 smart, 4 reasoning;
- normal free/paid chat defaults and their chat-hub defaults are the same paid-model set; chat hub has only slots 0..5.

The readable older snapshot `analysis/live-models-config.json` (SHA `baff2eb782c2c65b08c754843843d6b8ff1e04255316d3e415716ec897226e3c`) shows the same Mistral ID drift at lines 381-403 versus 1073-1080/1225-1232. It is useful corroboration, not newest authority.

### Picker and legacy residue

`O4YOWW5G.pretty.js:407-430` can construct FREE/FAST/SMART/REASONING/LEGACY/ART groups. But stock Chat menus at lines 532-538 omit FREE. `P6DBQQEF.pretty.js:12652` exposes only FAST/SMART/REASONING tabs. Free/Mistral is latent catalog data, not a hidden menu that unlocks panels.

Older `MAXAI_MISTRAL` points to `mistral-large-2` and is explicitly deprecated (`beautified/extension__background.js.pretty.js:42464-42476`, SHA `031b87f69ceba12da46cb86f0741402a92679b2187f0852d6158822231a45593`). It is absent from the newest catalog/provider list. It is dormant residue, not a usable paid-Mistral route.

### Free mode uses the normal route

The switch at `P6DBQQEF.pretty.js:8931-8974` (raw `sendUserAction` call begins byte **185,004**; action string begins 185,023) changes local `chatMode` and starts an entitlement/paywall action. It does not assign Mistral. The request independently reads the existing conversation model and writes `chat_mode` plus `model_name` (`6GSZNDSL.pretty.js:31143-31163`). `MAXAI_FREE` and `MAXAI_MISTRAL` shaping cases are empty (`:31189-31195`). Normal text stays `/gpt/cwc/chat` (`:31219,31398`); free mode only forces response language AUTO (`:31240-31243`) and blanks the displayed model (`:31612-31630`).

Static code therefore does not prove `free_chat -> Mistral` mapping or a `/mistral`/`/free` endpoint. A historical results file (SHA `5758598d02ac2efc57023572c1063899d05cbe075b4f68a916782b26ccbd30c1`) records explicit `mistral-7b-instruct-free` returning a generic PING; the historical report at `MAXAI_LIVE_VALIDATION_RESULTS.md:25-35` (SHA `a08bee6d2e5cd491017c37f5684b9c0e48cc43d6fe40a682b99cae0248a86391`) says it used normal `/gpt/cwc/chat`. This proves historical request acceptance, not current backend identity. No new request was made.

### Flags and hidden routes

Recovered beta flags cover chat sync, voice input, artifacts, project content, page translator v2, document v2, and appearance v2. None controls >6 or Mistral entitlement. `appearance_v2_enabled` only chooses V1/V2 shortcut runner during fanout.

No extension-only generation route was found. Normal generation is dynamic `/gpt/${T}` with `T="cwc/chat"`. Hidden Memo/FAQ/ContextMenu types and conversation “group” routes are not multi-agent buses. Editing local mode/count/query/state is not a recovered entitlement bypass; remote paywall checks remain and the stock route/UI chain still constrains count.

## 7. Candidate >6 configurations

| Candidate | End-to-end trace | Verdict |
|---|---|---|
| Set `MaxAIClientChatHubLayoutCount` >6 | Persistence setter exists; route later accepts only 1/2/3/4/6; defaults/map/getters/grid stop at six. | **Not an unlock.** |
| Add more route conversation IDs | `id` parses to an array, but `models` validator rejects other counts and fanout slices by accepted layout. | **Blocked by stock route.** |
| Add extra selector-store keys | Generic object setter accepts an index; catalog getters/default refresh/layout map return only 0..5 and UI never requests more. | **Generic behavior, not a feature.** |
| Call generic `layoutModels` helper with >6 | Helper would map supplied entries; no stock control/flag/caller supplies them, and renderer/provider behavior is unproved. | **Code-mutation hypothesis only.** |
| Use `pro_chat ? 30 : 6` | Trace terminates in Google search-result extraction. | **Rejected: search limit.** |
| Use historical shim council | Separate Python host orchestrator. The recovered backup `tools/shim-dotgit-backup.tgz` (SHA `8e33653d0c7b2604325f2d4bf4c15c32a3e2370457d4a58fe4fb5e318b2634b2`) gives real shim lineage, but not native panel mechanics. | **Different mechanism.** |
| Call six a historical/provider maximum | Evidence covers this saved native client only. | **Incorrect; >6 remains owner-attested/unrecovered.** |

## 8. Recovered versus unresolved

| Topic | Recovered | Unresolved |
|---|---|---|
| Packages | Chrome Web Store treehash parity; Firefox port/XPI; entry/lazy closure | Unretained older/newer builds; unsigned Firefox runtime execution |
| Source maps | Exhaustive absence; one real logger source path | Original TypeScript names/structure beyond that label |
| Layout | Selector, route accept-list, enum, grid, locale through six | Any different historical/custom client's UI |
| Fanout | Shared composer, per-panel retargeting, `Promise.all`, separate conversations | Live overlap, same-account/provider capacity, error/cancel semantics |
| Request | Scalar conversation/model normal chat request | Any unobserved batch endpoint; none recovered |
| Demux | One accumulator/engine/store/component per conversation | Live out-of-order and cross-lane isolation |
| Continuation | Broadcast source path; one-conversation compare/regenerate; sequential parent chain | Live reply-all/selected-pane continuation, branching/resume |
| Reasoning | Provider-exposed inline `<think>` -> separate `thinkingText` | Hidden reasoning (not claimed); positive live parallel reasoning |
| Mistral | Fallback/current catalog, ID drift, normal free-chat mechanics, historic explicit-ID acceptance | Current serving identity, automatic free-mode model, extension exclusivity |
| >6 | No supported stock native-UI unlock; false search-result 30 lead corrected | Separate legacy archaeology recovered seven/twelve aggregate host execution and a configurable 30 host ceiling; exact owner-attested 30/32 request trace remains missing, not disproved |

A prior bounded private-corpus audit counted 79 historical chat starts across seven runs, none within three seconds. This is negative evidence for a retained multi-panel run, not a provider limit.

## 9. Final verdict

**Recovered:** the complete saved stock v8.37.1 mechanism through six panels; entry/lazy chunks; selector/state/defaults; per-panel model/conversation wiring; shared broadcast; scalar request; per-conversation stream/message demux; provider-exposed `<think>` handling; sequential ID/parent chain; dynamic catalog/cache; Free/Mistral residue.

**Not recovered:** a supported >6 native-panel configuration; a chat-specific 30/32 limit; live multi-panel wire proof; provider concurrency capacity; current extension-only Mistral endpoint/backend identity; or original source maps.

**Historical context:** owner-attested >6 Hermes behavior remains an open recovery target. The newly located inner shim Git backup is evidence for a separate host-side council implementation, not an extension unlock. Do not infer or enable wide live fanout from this archaeology.
