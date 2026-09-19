# MaxAI legacy lane recovery

**Status:** read-only follow-on archaeology, 2026-09-10
**Result:** a historical **more-than-six host-side MaxAI council episode was recovered**. The best evidence is a successful local-shim request trace configured for **7 seats with `parallel=7`**, followed by a committed **12-seat** live-path A/B aggregate. Neither artifact is a provider-wire capture. The `30`/`32` maximum remains owner-attested and unproved, not disproved.

## 1. Scope and safety

I searched the following local evidence only:

- pre-PostgreSQL `~/.hermes/lcm.db` and `~/.hermes/cmx.db`;
- current `~/.hermes/state.db` and CMX PostgreSQL `cmx_dev`;
- 625 legacy Hermes session JSON files, 136 request dumps, five session JSONL files, backups, memory files, and externalized CMX payloads;
- five frozen Copilot event streams, their checkpoints, and the current Copilot session store;
- MaxAI shim/council source, live-proof summaries, archived Git objects, browser storage, request/capture files, and MaxAI/Hermes documentation;
- the private reconciliation corpus and current project synthesis.

The searches covered `maxai`/`maxia`, multi-chat/model, panel/lane/plane, parallel/simultaneous/at-once, instantiate/spawn/fanout, council, `PersonaPool`, `ThreadPoolExecutor`, `COUNCIL_MAX_PARALLEL`, conversation arrays/IDs, `Promise.all`, counts 7/8/10/12/20/24/30/32, reasoning/thinking, extension/unlock, and Mistral/free-tier terms.

No network, provider, login, discovery, or egress call was made. All SQLite access used read-only connections. All PostgreSQL work ran in explicit read-only transactions. No worktree, runtime, database, capture, or extension source was changed. This report does not reproduce credentials, account identifiers, raw provider conversation IDs, private prompts, or raw reasoning bodies. UC TTS/STT remained deferred/OFF and was not tested.

### Evidence labels

- **Direct host execution:** a retained local request trace or process result from the historical live shim.
- **Immutable provenance:** an original Git object or committed artifact whose bytes are still available.
- **Direct static:** source or captured client bytes, without a provider execution.
- **Aggregate run evidence:** a completed harness result without per-request wire receipts.
- **Owner-attested:** the owner says behavior occurred, but the supporting wire record is absent.
- **Echo/recovery attempt:** a later memory, prompt injection, report, or archaeology discussion. It is not independent corroboration.

## 2. Executive finding

The prior statement that historical v1 had only report-level 3- and 5-way fanout is incomplete.

Two older MaxAI-shim artifacts survive:

1. **Seven-seat live local-shim trace.** Five successful outer request records between `2026-06-13T10:15:15Z` and `10:19:50Z` declare `level=high`, `seats=7`, and `parallel=7`. The last request completed three seven-seat council rounds and ended `REVISE → REVISE → ACCEPT` in 36.9342 seconds.
2. **Twelve-seat MaxAI-backed harness aggregate.** A 12-lens wide panel ran in five A/B cases. The exact driver builds the real MaxAI `ChatService`, sets `COUNCIL_MAX_PARALLEL=12` for the wide pass, and calls the council. The result and driver are preserved in the original inner-shim Git history.

These artifacts give credible, concrete support for a historical **greater-than-six host-side council fanout**. They do not establish a native MaxAI UI with more than six visible panels. They also do not establish seven or twelve successful simultaneous arrivals at the provider, because no retained artifact lists all per-seat request start/end times, HTTP results, or provider conversation/message IDs.

The safe correction is therefore:

> Recovered historical MaxAI shim artifacts show completed live local-shim requests configured for seven council seats with `parallel=7`, plus a committed 12-lens wide-council aggregate whose driver requests a 12-worker fanout. This is credible evidence of a >6 host-side MaxAI council episode. It is not provider-wire capacity proof. The broader 30/32 claim remains owner-attested and unproved, not disproved.

## 3. Strongest recovered episode: seven-seat live host trace

### 3.1 Trace artifact

`/mnt/devvm/custom/tmp/maxai-live-trace.jsonl`

- size: 28,403 bytes;
- records: 58 JSONL records;
- whole-file SHA-256: `adc427b7dad5eee57a8e87029b322f54e5e3b4b842d582034c85c0936915c12f`;
- current mtime: `2026-06-22T01:25:46.443426Z`, which is a later append time, not the run time;
- privacy check: records contain request metadata and layer events only. They contain no prompt body, token, cookie, authorization header, account ID, or provider conversation ID.

All line hashes below include the terminating LF byte.

| JSONL line | Request start UTC | Elapsed | Exact recovered event | Outcome | SHA-256 |
|---|---:|---:|---|---|---|
| 11 | `2026-06-13T10:15:15.299300Z` | 12.1481 s | `level=high`, `seats=7`, `parallel=7`, `cost_tiered=false` | accepted | `e1115efa2ae474b815f7060c886b48f186cf79ddd447e8562cc381b7b23fa84b` |
| 12 | `2026-06-13T10:17:55.984400Z` | 8.7699 s | high / 7 / 7 | accepted | `9ff9bf1cc717baf1ada00753f7e360bbd565d4ebc3bc5871ad639d0f0612c378` |
| 13 | `2026-06-13T10:18:05.055900Z` | 10.4807 s | high / 7 / 7 | revise, then budget exhausted in this first attempt | `c14707844afd55966e04abc3f97510177f9d730bc03b9f3976d4021938596bb4` |
| 14 | `2026-06-13T10:19:04.833200Z` | 8.7027 s | high / 7 / 7 | accepted | `b18ffddacdaf605bf2d70ab27354ef28e78aa3f25f7d9a1defa3802da3a85e1c` |
| 15 | `2026-06-13T10:19:13.837600Z` | 36.9342 s | three high / 7 / 7 rounds at `10:19:14.357000Z`, `10:19:25.025000Z`, and `10:19:38.753600Z` | `REVISE`, `REVISE`, `ACCEPT`; text lengths 26, 750, 1282 | `64b8c358ffcfb9427b1f7b7de0c949abfbc4698b55791fe0cc787aff5b58a948` |

The outer model was `gpt-5-mini`; the trace names the council-side paid route as `gpt-5-2-thinking` / `USE_CHAT_GPT_PLUS`. No account identity is retained here.

### 3.2 Matching committed result and exact execution path

The line-15 run is independently tied to:

- `/mnt/devvm/custom/MaxAI/shim/analysis/live-proofs/force-iteration.json`
  - SHA-256 `251253c7dc60980267305b21006994cedc41507802f56f2a990b550627e48b6f`;
  - records high effort, 36.9 seconds, three iterations, `REVISE/REVISE/ACCEPT`, and lengths 26/750/1282.
- `/mnt/devvm/custom/MaxAI/shim/tools/force_iteration.py`
  - SHA-256 `464f0c4bc63f3253352c404004bda94cca29aae6e15ed15f24d2b1c6f5d83085`;
  - lines 39-40 select loopback shim `127.0.0.1:8799` and the trace path;
  - lines 64-76 submit `/v1/chat/completions` with a reasoning-effort field.
- `~/.hermes/lcm.db`, session `20260613_030822_ef8689`:
  - `messages.store_id=112024`, assistant command record; content SHA-256 `ac6add6caa24f21d10925a40f72a3abb1e5f4d85b26a30d6ab36b5108282fe12`, tool-call SHA-256 `912d8d14fcd70061e3a2d44d64790fa23e4384cb3083a4f64d961289d63daafe`;
  - `store_id=112027`, process result, exit code 0; content SHA-256 `265d9fb517c3caad910120a90b4c58bcaa593ae361da9acd26da73e2c4784055`;
  - the LCM timestamp is `2026-06-13T10:22:22.314685Z`, a bulk/snapshot storage time. The embedded trace times above are the useful request times.

The code path at the preserved original commit is explicit:

1. `council_backend.py:608-626` writes the `seats`/`parallel` trace event, enters `_council_parallelism(_par)`, then calls `run_council`.
2. Historical council source preserved in `lcm.db`, session `20260613_030822_ef8689`, `store_id=111724`, content SHA-256 `b561ea8a3e730e4a3992f22991d88c9eab0b6527bda051aab629e9d18f200a66`, shows `ThreadPoolExecutor(max_workers=min(max_parallel, len(names)))` followed by `ex.map(run_one, names)`.
3. Historical `_deliberator_output` source in `lcm.db`, `store_id=106723`, content SHA-256 `e39738d1c0b5f5878633ef67554090300b7ba43854ac2296965bf3c6552430d2`, shows each `run_one` reaching one `call_model(...)` invocation.
4. `council_backend.py:388-502` replaces that model seam with `maxai_call_model`; lines 473-492 build a MaxAI request and await `ChatService.complete`.
5. `chat_service.py:32-54` makes a non-stream `POST /gpt/cwc/chat` through the signed transport. File SHA-256: `990d66f4e707d7007f05ab1ee9fb0a479abf27c4491d3daaff6f68e7791fded7`.

### 3.3 Exact strength and limitation

This is **direct host-execution evidence** that the running shim entered and completed council operations configured for seven seats and seven worker slots. The implementation schedules the seven named deliberators through a seven-worker executor and maps each call to the real MaxAI chat service.

It is **not** seven request-level provider receipts. The trace uses request-scoped `contextvars`; worker-thread events are not enumerated in the parent record. Only one `council_member` metadata event survives per council round, likely the main-context arbiter call. There are no seven provider request IDs, response IDs, HTTP timestamps, or per-seat completion statuses. The safe claim is “seven-seat host fanout was configured and the aggregate request returned,” not “seven upstream requests are wire-proven to have overlapped and succeeded.”

Line 15 contains three sequential council rounds. It must not be described as 21 simultaneous lanes.

## 4. Wider recovered episode: twelve-seat MaxAI-backed A/B run

### 4.1 Result artifact

`/mnt/devvm/custom/tmp/wide-vs-narrow-council.json`

- mtime: `2026-06-13T10:08:03.512291Z`;
- size: 1,476 bytes;
- SHA-256: `e837f457e345096504431b1cb24fcaa0ba2cd489a22a365b7b51d52a2bff8dee`.

A byte-identical committed copy survives at:

`/mnt/devvm/custom/MaxAI/shim/analysis/live-proofs/wide-vs-narrow-council.json`

The aggregate names three narrow lenses and twelve wide lenses. It records five completed narrow-then-wide comparisons. Combined per-case elapsed times are 13.7-18.5 seconds. Both panels caught four planted defects; both shipped the good control. “PASS” in this harness means no regression and wide-at-least-as-good, not proof that twelve provider calls all succeeded.

### 4.2 Exact driver and original transcript

`/mnt/devvm/custom/MaxAI/shim/tools/wide_vs_narrow_council.py`

- SHA-256: `fd9434f544b3254b33bb1f9715401cb30d258d87cc8752426df77b33f4bfc4ba`;
- lines 38-43 define `NARROW` with 3 lenses and `WIDE` with 12;
- lines 93-104 construct the real `MaxAIClient` and `ChatService` from live shim state;
- lines 118-128 install the MaxAI model seam, set `COUNCIL_MAX_PARALLEL=min(len(personas), fanout_ceiling())`, and call `run_council(..., personas=personas, peer_review=True)`;
- lines 144-150 run narrow and wide sequentially for each case. Thus this is not a 15-at-once test. The wide phase requests twelve concurrent seats.

The original LCM transcript survives as one logical result plus replay copies:

- session `20260613_030822_ef8689`, `store_id=111960`: starts the live 3-vs-12 harness; content SHA-256 `56a206b7c64c3a3ab1f1de0756cdbcd3f9ab428e6325209ad5bd83b3bc34f679`; tool-call SHA-256 `a786b82c32515ae7233521b44b573403c94fd4153831a0af5858630a3745df2b`;
- `store_id=111965`: exit code 0 and the five-result table; content SHA-256 `386e383a3da73c8e74230373115b7106e56c3d150b36c8804bf02c24eac0540a`;
- duplicates `112423` and `112428` have the same content and are replay copies, not new runs.

The driver output names inherited `HERMES_SESSION_ID=20260613_030017_dc122e`. The LCM lifecycle table says that identifier was already finalized at `2026-06-13T10:01:03.801309Z`, before the 10:08 result. Treat it as a stale subprocess environment label, not the authoritative message container. The command/result records are stored under `20260613_030822_ef8689`.

### 4.3 What the twelve-seat artifact proves

It strongly supports a real MaxAI-backed 12-seat harness execution because all of these survive together:

- the exact live-client constructor;
- the exact 12-seat roster;
- the executor setting the worker count from roster length;
- five completed aggregate results;
- the original session's command/result records;
- immutable original Git objects containing the same driver and result bytes.

It does not preserve the twelve individual deliberations, per-seat failures, provider IDs, start/end times, HTTP status values, or stream/reasoning output. The council engine converts a failed critic into an error-shaped deliberation instead of necessarily aborting the whole run. Therefore the artifact cannot prove that all twelve upstream calls succeeded or arrived concurrently at MaxAI.

## 5. Original Git provenance recovered from backup

The current outer MaxAI repository once stored `shim/` as a gitlink. The original inner repository is recoverable, not lost:

- backup: `/mnt/devvm/custom/MaxAI/tools/shim-dotgit-backup.tgz`;
- size: 567,256 bytes;
- SHA-256: `8e33653d0c7b2604325f2d4bf4c15c32a3e2370457d4a58fe4fb5e318b2634b2`;
- `git fsck --full --no-reflogs`: clean;
- archived `HEAD`: `refs/heads/feat/cc-port-phases-a-d`;
- archived branch head: `e4ad9652ba045da6465d0e22339be3ed84d7a65f`;
- outer commit `d824498d4e400ef4f033715425b7ae0e3ca1ad3f` stores `shim` as a gitlink to exactly `e4ad9652...`;
- outer commit `75486bc5fab09709d32cbdf017c4cfae59360264` at `2026-07-15T06:45:03Z` de-embeds and preserves the files as ordinary blobs.

Key original commits:

| Commit | Time | Meaning |
|---|---|---|
| `47bb758e210d0b8bebb19b507e43f5581d0332a8` | `2026-06-13T09:36:15Z` | Implements P2 seat-count fanout and a configurable local ceiling. Its “verified 30-chat ceiling” rationale is now known to rely on a bad source interpretation. The generic fanout code remains real. |
| `51477e8dc7a9fc9b5b054e9d315188cbcfb5a52d` | `2026-06-13T10:06:58Z` | Widens `high` 3→7 and `xhigh` 5→12. |
| `dec963ab51a191c5d3679c9733dab5b1aa2f4804` | `2026-06-13T10:20:15Z` | Commits the force-iteration driver/result and the 3-vs-12 driver/result; commit message describes the loopback `/v1/chat/completions` run as live. |
| `e4ad9652ba045da6465d0e22339be3ed84d7a65f` | `2026-06-13T16:52:41Z` | Final archived branch head; it descends from `dec963a`. |

At `dec963a`, exact Git blobs and SHA-256 values are:

| Path | Git blob | SHA-256 |
|---|---|---|
| `tools/wide_vs_narrow_council.py` | `eff1d435a469b6aa68de082f3530c19d06c9a58b` | `fd9434f544b3254b33bb1f9715401cb30d258d87cc8752426df77b33f4bfc4ba` |
| `analysis/live-proofs/wide-vs-narrow-council.json` | `3c20c46a3fe275e24474dacf3bc91bd418841f3c` | `e837f457e345096504431b1cb24fcaa0ba2cd489a22a365b7b51d52a2bff8dee` |
| `tools/force_iteration.py` | `18a577968366788c5b18fbffebd35cbbf7cce329` | `464f0c4bc63f3253352c404004bda94cca29aae6e15ed15f24d2b1c6f5d83085` |
| `analysis/live-proofs/force-iteration.json` | `354944ff2d6a2120a1e57275dde17dadb8260218` | `251253c7dc60980267305b21006994cedc41507802f56f2a990b550627e48b6f` |
| `src/maxai_shim/facade/council_backend.py` | `9055f172fc462bcecbb64e6f831ef818abcd693b` | `c40de0cb0f0dd80ceabecfb0f0aba0c86bdac81e91b06243b1bca96b702edece` |
| `src/maxai_shim/facade/trace.py` | `e749e5a9a246325524ff15e50680e4993e6c9eb6` | `fe34ddc20c5b6d836c807c5faf15a4698d1c3bf94cdc15522c5d4daafb7ac4bc` |
| `src/maxai_shim/upstream/chat_service.py` | `974c9c52f2818dc6b48c58a32f0828d5602c06a2` | `990d66f4e707d7007f05ab1ee9fb0a479abf27c4491d3daaff6f68e7791fded7` |

The current local copies match those original Git bytes. This removes the earlier concern that the 12-seat evidence survived only as an unversioned file. The raw `maxai-live-trace.jsonl` itself was not committed, so its line-level evidence remains a current local survivor correlated to the committed aggregate.

## 6. Session and rotation binding

The original evidence is split by old session rotation and replay. `~/.hermes/lcm.db` has SHA-256 `af387a42d48a19b6d78402a21b520dc25f3f2ebca086ca78dfcae2c00d185c02`.

Relevant lifecycle rows, with raw conversation keys withheld and replaced by SHA-256:

| Session | Bound/finalized UTC | Last finalized session | Conversation-key SHA-256 | Interpretation |
|---|---|---|---|---|
| `20260613_030017_dc122e` | bound `10:00:17.377429Z`; finalized `10:01:03.801309Z` | `20260613_021327_09b92c` | `ae733ae13171538b3eae646f66388dff8a308374decde8f71b66ccfba65c6fdd` | The 12-seat process output inherited this label, but its artifact completed later; do not treat it as the canonical transcript container. |
| `20260613_030822_ef8689` | bound `10:08:22.172119Z`; finalized `10:23:40.218536Z` | `20260613_021327_09b92c` | `4a436961fe91ab2ce1095184fcdeef9b65d2ef9fa931c57f09e77edabd242624` | Contains the replayed 12-seat command/result and the 7-seat force-run command/result. |

The predecessor `20260613_021327_09b92c` has no surviving message rows in the current `lcm.db`. The first record in the successor, `store_id=111524`, is a `[Recent Summary (d0, node 583)]`; content SHA-256 `8bc34cbe6ae4785a27455a523dd5ccaa1ee5c29f048f60dd2b58121485f24a0d`. This confirms the session is a continuation/rotation, not a clean original transcript. Artifact mtimes, embedded trace times, and Git commit times are therefore stronger chronological anchors than the repeated LCM row timestamp.

Neither current SQLite `cmx.db` nor current PostgreSQL contains a lineage row for these session IDs. This missing migration linkage is a gap, not evidence that the run did not occur.

## 7. The 30/32 claim: attested, but the old source citation is false

### 7.1 Owner attestation remains valid as attestation

CMX PostgreSQL `public.messages.id=229407`, session `20260828_032311_39572a`, role `user`, time `2026-08-28T10:41:49.330701Z`, content SHA-256 `1192c34fa423e44803ad1f76a58e0007ca6b5397d8b5a4481beafcc8b1f45851`, contains the safe excerpt:

> “I recall that we found that their api supported up to 30 or 32 parallel calls to be run/triggered at once”.

Message `230226` is byte-identical. It is one recollection, not two independent observations. The current owner's renewed statement that >6 was observed is consistent with the recovered 7/12 host-side episode. It must not be downgraded to disproven merely because the 30-way wire evidence is absent.

The original June interaction also shows the owner asking to use more seats. `lcm.db` session `20260613_030822_ef8689`, `store_id=111923`, role `user`, content SHA-256 `866447c3a6ef740e3b3f726a55d21c1a53e61ac4658ae620651162e086220dc4`, asks whether more council members should run in parallel. `store_id=111931`, SHA-256 `3495f10dcbcfd72e483433a4e021b19aa81701b172826c30b2350a84189592ee`, approves widening and testing. These records explain the 7/12 change but do not independently prove a 30-call run.

### 7.2 Exact source correction

The older claim that source proved a 30-chat cap came from this line in:

`/mnt/devvm/custom/MaxAI/beautified/site__www.maxai.co___next__static__chunks__41068-6f8108ba5efbd08c.js.pretty.js`

- file SHA-256 `a7808ea27e3f2b028d2967c089062493919341e3165d2286585c8b7db0ef538a`;
- line 30018: `limit: n === s.ht.PRO_CHAT ? 30 : 6`.

Lines 30012-30026 place it under `GET_CONTENTS_OF_SEARCH_ENGINE` and `URLSearchEngineParams` for Google. It is a search-result count, not a chat/panel/fanout limit.

Frozen CMX rows preserve the correction:

- message `230241`, session `20260820_150715_bf2212`, `2026-08-28T11:41:16.921222Z`, content hash `0b11502dcc950324e65343f43852691a9e866a94e7f9cd8643797dcddb2322d9`;
- message `230236`, same session, `11:41:16.893598Z`, content hash `a7c2dc58273e5ff75dc1c98c9345ff6229cb40863a584b18b658597a6db12613`, preserves the layout enum `ONE=1`, `TWO=2`, `THREE=3`, `FOUR=4`, `SIX=6` and six-panel CSS;
- message `230237`, `11:41:16.895656Z`, content hash `2b46908e7ba95a5f699582c5d454f051d7fbc14af96cc110f6433c4445b4804b`, preserves the actual chat dispatcher: `Promise.all(r.map(...))`, one indexed `conversation`, `AIModel`, and `AIProvider` per leg.

The dispatcher itself has no numeric server-cap check. Thus the saved client proves client-side fanout and a recovered six-panel layout. It does not prove that six is the server maximum. It also does not prove 30.

### 7.3 False positives and stale claims

| Hit | Correct classification |
|---|---|
| `PRO_CHAT ? 30 : 6` at line 30018 | Google search-result limit, not chat concurrency. |
| `MAXAI_COUNCIL_FANOUT_CEILING=30` and related tests/comments | Local safety/configuration ceiling derived from the mistaken source reading. It is not a provider limit or run receipt. |
| CMX insert of 30 lineage children or 30 concurrent PostgreSQL writers | Local database exercise, not MaxAI traffic. |
| Exactly 30.0-second failures | Old transport timeout, not a lane count. |
| Final2 mocked “all” mode with 30 total requests | Sequential waves/total request count, not 30 simultaneous calls. |
| 24 council personas | Roster size, not observed provider concurrency. |
| `32` matches | Output/token/dimension or owner-recollection hits; no retained 32-chat implementation or run. |
| `plane` | Control-plane/ordinary-language noise; no distinct MaxAI “plane” feature recovered. |
| Later memory/recovery reports calling 30 “verified” | Echoes of the line-30018 misread, not new proof. |

The old `MULTIMODEL-AND-COUNCIL-FINDINGS.md` and several June memory rows should be read as historical interpretations, not current proof of 30.

## 8. Conversation identity and retained wire evidence

### Native client static evidence

The saved client dispatcher at lines 10773-10795 of the `41068...pretty.js` file calls `Promise.all` and pairs each model with `a.conversations[n]`. This is direct static evidence of one conversation slot per active panel.

A separate tracked bundle, `/mnt/devvm/custom/MaxAI/bigger/www.maxai.co/_next/static/chunks/37974-73f7312a1f44f6bb.js`, SHA-256 `7b9f5eea36cd7afdbaec039a727d859367ae609d4b3099c17bcb1159319edc21`, contains the 1/2/3/4/6 layout implementation.

### Single-thread wire evidence

`/mnt/devvm/custom/hermes/maxai-real-turns-20260615.jsonl`, SHA-256 `bf4f91328c6aaa7b5c852caf7b8fd7fe6d691c061f58ba5f713d3a4db761f7ee`, records 23 chat turns and 45 `add_messages` operations around one stable provider conversation. Every chat body had `chat_history_len=0`; state was server-side. Raw conversation IDs are intentionally not reproduced.

The broader local capture scan found 79 `/gpt/cwc/chat` POSTs across seven `jshook.jsonl` runs and 23 distinct conversation IDs. The maximum outstanding request count was **1** in every retained run, measured from request start through `stream.done`. This is direct negative evidence about the retained capture set only. It does not disprove the June host-side shim episode because those requests were not captured into these later browser-run files.

### Missing IDs in the recovered 7/12 episode

The old host shim's `openai_to_maxai_chat` builds a stateless body without a durable lane conversation ID. The 7/12 artifacts retain no per-seat provider conversation ID, message ID, response ID, attempt ID, or local lane ID. They also do not prove selected-lane continuation or reply-all. Do not merge the later one-thread native conversation proof into the older 7/12 council result.

## 9. Reasoning/thinking evidence

For this report, **reasoning means only provider-exposed stream text or fields**. It never means hidden chain-of-thought.

Direct sequential capture:

- `/mnt/devvm/custom/MaxAI/capture/runs/run-20260716-215709/decoded/wire.jsonl`;
- size 7,760,945 bytes;
- SHA-256 `233777e0521c9c77b98a48324897c8e66a5e2e07864f258bc20db73a5274e075`;
- 47 chat responses, all 200; 31 streams contain paired provider-exposed `<think>` tags; all 47 contain `preprocessing_tracker`; zero raw `reasoning_content` and zero raw `thinkingText` fields.

The saved client parses leading `<think>...</think>` from provider text and writes client-side `metadata.thinkingText`. `preprocessing_tracker` is progress/status metadata, not reasoning text.

The recovered 7/12 council artifacts preserve **only aggregate council metadata and verdicts**. They preserve no per-seat provider-exposed reasoning stream. The old shim's `thinking_transcript()` can render local council critiques into a `reasoning_content` channel, but that is host-generated council narration. It is not evidence of hidden model reasoning and is excluded from the provider-reasoning claim.

## 10. Mistral/free tier and extension-unlock hits

### Mistral/free tier

Direct captured configuration at:

`/mnt/devvm/custom/MaxAI/capture/runs/run-20260722-005931/decoded/bodies-decoded/get_config(2)`

- SHA-256 `880bb08e5074fbd9a1dc46a237ae1b86689aa815eee75e41c7a4a1dbd3c3d5d6`;
- one `mistral-7b-instruct-free` chat model, display name “Free AI”, group `free`, provider enum `MAXAI_FREE`, maximum 8,000 tokens;
- the six chat-hub slots appear for both free and paid presets.

An older LCM tool result (`store_id=103648`, SHA-256 `2f3461012d316c6c9ea8f853dee18458df6a0028516c818bd1d67f2b815fcd88`) records `200 PING_OK` for the free model. A later July pro-chat test returned empty for the Mistral slugs and left the correct `free_chat` wire unresolved. These are different routes/builds; the later result does not disprove the earlier report. Neither is >6-lane evidence.

### Extension unlock

A tracked Firefox package exists (`maxai-firefox-8.37.1.xpi`, SHA-256 `a2efa3c6b2c49385d26dac2256c1dd04f08a687d1fec650976c121a96e8381c8`), but presence is not proof that an extension-on multi-panel run occurred.

Retained notes conflict by feature/build: some say the extension unlocked sidebar/page scraping or was needed for web search; a later owner correction says persistent-library upload/select worked without it. The `x-app-env=MaxAI-Browser-Extension` header also appeared in pure web-app traffic, so it cannot prove the extension was active. No dedicated extension-on >6-panel capture was found.

## 11. CMX, current state, Copilot, backups, and deduplication

### CMX PostgreSQL

A fresh read-only query at `2026-09-10T09:53:46.626796Z` found:

- PostgreSQL 17.10 with `transaction_read_only=on`;
- `cmx_dev.public.messages`: 266,579 rows, 1,527 sessions, 291,502,884 content bytes;
- `public.session_lineage`: 364 rows / 52 roots;
- `public.fanout_lineage`: **0 rows**;
- metadata fingerprints unchanged from the frozen audit: messages `d5393c96c8d62805737af99ee0df3d9e`, lineage `30f4683c1c8fda661ed5a85cde52b93e`.

The original LCM session ID is absent from current PostgreSQL. CMX contains later durable summaries and recovery discussions, not the original 7/12 request records. For example, row `431` says live fanout reached five; rows `424/426` repeat the stale 30 interpretation; later rows preserve the August owner recollection and correction. `fanout_lineage=0` is a schema/history gap, not a negation of the old run.

### Pre-PostgreSQL SQLite

- `~/.hermes/lcm.db`: 126,304 messages; SHA-256 `af387a42d48a19b6d78402a21b520dc25f3f2ebca086ca78dfcae2c00d185c02`. This contains the original command/result and implementation transcript used above.
- `~/.hermes/cmx.db`: 119,388 messages and 159 session-lineage rows; SHA-256 `b1cf52e76b62dbb8b626048e7d42b1d614ea3bb418e24142b07b776fccd8ab01`. Its 8 `wide-vs-narrow` hits reduce to 3 unique content hashes and are later memory/tool echoes, not original run receipts.
- `~/.hermes/state.db`: 235,489 messages and 2,422 sessions at inspection time. Its `wide-vs-narrow` search produced 16 rows across 14 sessions, dominated by repeated injected memory and later file inventories. No original June request-level trace was recovered there.

### Legacy JSON and request dumps

The legacy session corpus contains 625 `session_*.json` files, 136 `request_dump_*.json` files, and five JSONL files (771 files total including four temporary files; 430,084,835 bytes). No independent >6 run receipt was found.

One older direct hit is useful only for account-history context: `session_20260527_221610_4f14f1.json`, file SHA-256 `83f7e310ec0e83d6ecddbf6824754fb0a282f00d35112bfd08026f6f38becaff`, message index 91/tool, content SHA-256 `2abef66fdab91ea24402f5d992776bf50be392cb572f7b089bf92df8c5f7a397`, parsed a conversation-list page of 10 with `total_page=6`. There is no exact total-count field, so it is not evidence of 60 conversations or concurrent lanes.

Nine July request dumps repeat one extension/free-tier memory paragraph inside injected developer context. They are echoes, not nine observations. `~/.hermes/backups/` yielded no separate >6 evidence.

### Copilot events and checkpoints

All five frozen primary/support Copilot event snapshots were streamed: 207,372 JSONL events total. Every exported checkpoint for those sessions was also searched.

No Copilot checkpoint contains the 7-seat trace body, 12-seat aggregate body, per-lane IDs, or upstream-overlap receipt. The relevant frozen Copilot session `02c0df78-32b8-4b0b-be8b-38294042d366` contains a later file inventory:

- event line 1296;
- `2026-06-13T13:07:53.510Z`;
- event ID `d147a404-01ac-4c88-a4f6-0059497ab77e`;
- raw-line SHA-256 `d61f7dcab60dfa61d7cea9b9ec5b5505b1c79dbcb01085688ff0769b7ede1ad9`;
- it lists `tools/wide_vs_narrow_council.py` after the run. This is custody corroboration only.

The current Copilot `session-store.db` has one later August turn that mentions the wide-vs-narrow file and no matching checkpoint. It is a recovery echo, not the original run.

### Deduplication rules applied

- Byte-identical content was counted once by SHA-256, even when imported into several sessions/databases.
- LCM replay copies after context rotation were not counted as new runs.
- Memory blocks injected into request dumps or system messages were treated as echoes.
- Later audit reports and file listings were used for custody only, not as independent behavioral proof.
- The raw browser captures, host-side shim traces, offline tests, and owner statements remain separate evidence boundaries.

## 12. Chronology

| Time | Event | Evidence / classification |
|---|---|---|
| 2026-05-27 | Conversation-list page shows 10 rows and 6 pages. | Direct legacy JSON; account-history only. |
| 2026-06-12 | Saved source is interpreted as a 30-chat Pro limit. | Historical interpretation; later disproved as a citation because line 30018 is a search-result limit. |
| 2026-06-13 09:36Z | P2 commit enables seat-count fanout under `COUNCIL_MAX_PARALLEL`. | Immutable implementation; local ceiling 30, not provider proof. |
| 2026-06-13 09:49-09:56Z | Three- and five-seat council/panel/coordinator runs are recorded. | Lower-count live report evidence. |
| 2026-06-13 10:06:58Z | Commit `51477e8` widens high to 7 and xhigh to 12. | Immutable original Git object. |
| 2026-06-13 10:08:03Z | 3-vs-12 A/B aggregate is written. | Aggregate MaxAI-backed execution evidence; no per-seat receipts. |
| 2026-06-13 10:15-10:19Z | Five outer requests log high / seats 7 / parallel 7. | Direct host trace. |
| 2026-06-13 10:19:13-10:19:50Z | Final outer request performs three 7-seat rounds, then accepts. | Strongest >6 host-execution record. |
| 2026-06-13 10:20:15Z | Commit `dec963a` freezes both harness/result pairs. | Immutable original Git provenance. |
| 2026-06-15 onward | CMX/memory rows summarize 3/5 runs and repeat the old 30 premise. | Derived memories/echoes. |
| 2026-07-14/15 | Outer MaxAI repo imports the shim gitlink, then flattens it while preserving `.git` backup. | Preservation chain. |
| 2026-07-16 | Later browser capture proves long single-thread IDs and provider-exposed `<think>` text. | Direct sequential wire evidence; not parallel. |
| 2026-07-21 | Historical notes still mark native multi-chat capture as missing. | Correct for browser/native-panel boundary; does not erase old shim council run. |
| 2026-08-28 | Owner recalls 30/32; audit recovers 1/2/3/4/6 UI source and corrects line-30018 mistake. | Owner attestation plus direct static correction. |
| 2026-09-10 | This archaeology recovers the original inner Git history, 7-seat trace, and 12-seat aggregate. | Present finding. |

## 13. Remaining gaps

1. No retained provider-wire record enumerates seven, twelve, thirty, or thirty-two overlapping `/gpt/cwc/chat` requests.
2. The 7-seat trace has coordinator metadata but not seven request IDs/start times/statuses. The 12-seat result has aggregate verdicts only.
3. No per-seat provider conversation ID, message parent, response ID, retry/attempt ID, or continuation state survives for either run.
4. No per-seat provider-exposed reasoning stream survives. Local council narration is not provider reasoning.
5. No native browser multi-panel run above six was recovered. The saved UI build exposes layouts only through six.
6. No exact 30/32 implementation run, completion set, or failure distribution was recovered. The local value 30 is a configurable ceiling built from a misread source constant.
7. The original pre-rotation session `20260613_021327_09b92c` has no surviving messages. LCM holds a replay/summary in its successor.
8. The raw 7-seat JSONL trace is an unversioned current survivor, though its timing/outcome matches an immutable committed aggregate. Its historical bytes were not separately frozen at run time.
9. The 12-seat harness can return an aggregate even if individual critics fail. The retained summary does not expose a per-seat success count.
10. The current browser capture set is sequential. It neither confirms nor disproves an older lost native >6 event.

## 14. Disposition

- **Recovered:** historical >6 **host-side MaxAI council** execution evidence at configured seven-way fanout; a wider 12-seat aggregate and exact live-path driver; original Git lineage; static per-panel `Promise.all`; single-thread conversation and provider-exposed `<think>` evidence; Mistral/free-tier configuration.
- **Still owner-attested:** a native/API capacity of 30 or 32 simultaneous chats, and any separate lost UI episode above six.
- **Disproved only as a citation:** the claim that bundle line 30018 proves 30-chat capacity. It is a Google search-result limit.
- **Not disproved:** the owner's historical >6 recollection. The recovered 7/12 shim episode now gives it concrete support, while the exact provider-level concurrency remains unresolved.
- **No release implication:** this archaeology does not authorize live retesting, production parallelism, or changes to the current no-parallel policy.
