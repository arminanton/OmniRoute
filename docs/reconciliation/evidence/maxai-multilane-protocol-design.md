# MaxAI multi-lane protocol design

> **Legacy-recovery update:** `maxai-legacy-lane-recovery.md` subsequently recovered direct aggregate seven-seat evidence, a real-ChatService 12-seat aggregate harness, original branch objects, and a configurable 30-seat host ceiling. The exact 30/32 per-provider request trace and per-seat reasoning are still missing. The architecture below remains valid and must not hard-code six as a provider maximum.


**Status:** read-only architecture reconstruction. No implementation or live request was made. The only file created for this task is this report.

**Decision:** a MaxAI multi-lane run is a set of independent, durable single-chat lanes. Each active lane uses the normal MaxAI chat request and the same hardened stream parser as single chat. The coordinator schedules lanes and adds correlation, persistence, reply routing, and recovery. It does not invent a batch request or a reduced “parallel” parser.

This document is an implementation contract, not a claim that a production implementation exists.

## 1. Scope and safety boundary

This design covers:

- stable local run, lane, turn, and attempt identity;
- provider conversation, message, parent-message, and request identity;
- one normal request and one private parser state per active lane;
- provider-exposed answer and reasoning demultiplexing;
- prompted tools and tool continuations;
- selected-lane continuation and reply-all;
- durable ordering, cancellation, restart recovery, admission, and audit;
- a configurable number of logical lanes, independent of live concurrency.

It does not cover or authorize:

- any MaxAI, UC, provider, login, discovery, egress, or capacity probe;
- deployment or changes to an OmniRoute/Hermes worktree, runtime, database, capture, or extension;
- UC TTS and UC STT. Both remain deferred/OFF and were not live-tested;
- automatic context spill. That remains a separate, privacy-sensitive, default-OFF feature;
- hidden chain-of-thought. In this document, **reasoning** means only text or fields that the provider sends to the client.

No raw credential, cookie, auth header, private prompt, or account identifier belongs in this design or its normal audit output.

## 2. Evidence boundary

The aliases below make the citations readable.

- `UP` — the read-only clean source at `/mnt/devvm/custom/omniroute-uc-maxai-reconcile-9492357/repo`, inspected at `949235736042b13cf64215632e6d44db7985af76`.
- `R` — the private reconciliation audit at `/home/ndsadmin/.prime/agent/session-artifacts/01a08922-a4e7-750c-a7c6-575c2e7283a2/uc-maxai-reconciliation`.
- `I` — `R/workers/maxai-git/evidence/image-patch-snapshots/validated-overflow-parallel-final2-bf65/image`.
- `F2` — `R/workers/maxai-git/restricted-evidence/frozen-validation/maxai-overflow-parallel-final2-review-bundle`.
- `H` — `R/workers/copilot-lineage/restricted-verbatim/archived-evidence/linked-external/maxai-handoffs`.
- `CR230` — `R/workers/cmx-lineage/restricted-verbatim/externalized-payloads/230233.txt`. Its current-path file does not hash-match the historical database row, so it is corroborating analysis, not a frozen verbatim artifact.
- `EXT` — the saved local MaxAI web/extension sources under `/mnt/devvm/custom/MaxAI`. The unpacked Chrome manifest reports MV3 version 8.37.1. These sources corroborate the frozen audit but are outside its frozen manifest; the Firefox XPI is a derived unsigned port and is not treated as provider-signed provenance.
- `SYN` — this project's prior synthesis, `workers/maxai-parallel-lanes.md`.

Evidence labels used here:

- **direct/static** — source or an immutable artifact can be read directly;
- **offline** — deterministic tests used a mock provider boundary;
- **live, exact-boundary** — a retained live result applies only to its named image, account, and run;
- **report/wire-derived** — a retained report summarizes a capture or run, but the raw provider exchange is not present in the frozen audit;
- **owner-attested** — the owner states the behavior occurred, but supporting artifacts have not been recovered.

### 2.1 What the generations establish

| Evidence generation | Established | Not established |
|---|---|---|
| Current single-chat source | `UP:open-sse/executors/maxai/protocol.ts:1-145` builds one ordinary `POST /gpt/cwc/chat` body with one `model_name`, `streaming:true`, `chat_history:[]`, and a newly minted `conversation_id`. The executor flattens local OpenAI history into `message_content`, parses SSE text, separates exact `<think>` text, and supports prompted tools (`UP:open-sse/executors/maxai.ts:149-410,455-619`; `UP:open-sse/executors/maxai/stream.ts:1-101`). | It has no product multi-lane coordinator. Its `conversation_id` is request-scoped, not a stable lane thread. Its normalized `chatcmpl-*` ID is locally fabricated, not a recovered provider response ID. The recovered SSE does not supply a completion/message ID, finish reason, or usage object. Its parser ignores important 200-level error/terminal frames, and the prompted-tool parser has nonce/name authorization gaps. |
| Saved web/extension source | The saved client holds an array of conversation IDs, maps a separate chat component to each conversation, rewrites each panel action to that panel's conversation/model, and dispatches ordinary operations with `Promise.all` (`EXT:bigger/www.maxai.co/_next/static/chunks/37974-73f7312a1f44f6bb.js:538-613,795-865`; corroborating current-path synthesis at `CR230:results[1]`, rendered lines 101-162 and 213-243). Stopping iterates over active conversations. Each stream has its own accumulator. Provider-exposed `<think>` text is removed from answer text and stored as visible thinking metadata (`EXT:beautified/extension__chunks__6GSZNDSL.js.pretty.js:45583-45704`). | Static source is not a live provider-capacity contract. It does not prove a production-safe concurrent count, restart semantics, or server-side idempotency. |
| Saved message source and historical wire report | The saved extension generates a message ID, chains `parentMessageId` to the previous message, assigns the conversation ID, and posts messages through `/conversation/add_messages` (`EXT:beautified/extension__chunks__6GSZNDSL.js.pretty.js:40827-40931,41046-41059,46683-46822`). Historical captures kept one conversation ID, used empty `chat_history` in every retained body of two runs (56/56 on a fresh recount; the older `EXT:docs/sections/g-history-triggers/analysis.md:7-22,43-53` prose says 50 and is stale), and showed the semantic sequence conversation ensure/touch, user append, normal chat stream, completed-AI persistence, and metadata sync. The 23-turn report describes user append → chat → assistant append → upsert (`H/MAXAI-REAL-WIRE-FORMAT.md:103-134`). | The current TypeScript executor does not implement this native history sequence. Exact first-create/touch timing can differ from the simplified four-step report. Provider duplicate-message/idempotency semantics and crash recovery are not proven. A later 41-turn report observed selective loss of one early fact around turn 30, so “unlimited recall” is not proved (`SYN:59`). |
| Historical v1/host shim | Original inner Git provenance, a direct host trace for seven configured seats, and a committed real-`ChatService` 12-seat aggregate harness are recovered (`workers/maxai-legacy-lane-recovery.md`). The shim also preserves a configurable 30-seat host ceiling and stronger multi-tag reasoning splitter. | Aggregate 7/12 execution is credible, but no per-seat provider request IDs/timestamps or per-seat reasoning survive. The exact owner-attested 30/32 episode remains missing. Host council fanout does not prove native per-lane threads or provider capacity. |
| Historical v2 | The v2 line explicitly began as single chat. It implemented a stable-conversation registry, message/parent chain, durable-turn filtering, and the captured append/chat/append protocol. Ten golden/mock tests covered two turns, dedup, and tool-loop filtering (`H/MAXAI-V2-SERVERSIDE-HISTORY-IMPLEMENTED.md:3-39`). | Live revalidation was deferred. There was no v2 parallel implementation or run. The process-local 256-entry registry is not durable restart recovery. V2 plugin “reasoning” also included local scaffold narration; that is not provider-exposed reasoning (`SYN:58-60`). |
| Final2 | The probe gave each lane private messages, tool state, working directory, timing, answer, and reasoning. Offline tests covered modes 2/3/4/6, reverse completion, reply-all, one-lane continuation, cancellation, budgets, and isolation. The exact live run had two overlapping lanes and six successful chat calls (`SYN:65-69`). | It is a manual host probe, not a product API. Lane identity is an array index. It has no durable run/lane ledger or restart recovery. Every executor request gets a fresh provider conversation ID. Probe continuations disable tools, and its `all` mode is sequential waves 2→3→4→6 rather than one wide wave. The live run had no continuation and no reasoning payload. A one-active-connection topology was reported, but request-to-account binding was not retained, so it is not independent same-account capacity proof. |
| Owner and recovery update | The owner attests that historical Hermes behavior exceeded six lanes. Seven/twelve aggregate host execution and original Git are now recovered (`workers/maxai-legacy-lane-recovery.md`; `docs/09-owner-scope-update.md`). | The exact 30/32 per-request trace and per-seat reasoning remain missing. That narrower claim is neither promoted to proof nor marked disproven. |

The saved UI layouts `1/2/3/4/6` are recovered interface evidence. They are **not** a recovered live maximum. One earlier bundle value of 30 was traced to Google-result count, while a separate v1 value of 30 was a local coordinator/configuration ceiling; neither is provider-capacity proof (`SYN:33-44,54-55`). Separate legacy archaeology now recovers credible seven/twelve aggregate host execution. The exact owner-attested 30/32 per-request episode remains unrecovered, not disproven. No number in this document is presented as the provider's maximum.

### 2.2 Non-negotiable invariants

1. Local `lane_id` is authoritative and never changes.
2. Every generation is one normal single-model chat operation owned by one lane.
3. Each active request has private parser, reasoning, tool, buffer, timeout, and abort state.
4. A lane has at most one active turn. Cross-lane completion order never changes lane order.
5. Two lanes never share a provider conversation ID or parent chain. Recovered conversation-group routes are history folders, not a group-chat bus.
6. Provider IDs are typed and scoped. Missing IDs remain missing; adapter IDs are not relabeled as provider IDs.
7. One run stays pinned to one connection/account reference. No silent failover changes identity.
8. Unknown provider or tool outcomes are never retried automatically.
9. Reasoning means provider-exposed content only.
10. Logical lane count and authorized live concurrency are independent controls.
11. The feature remains default-OFF and all evidence claims retain their generation and strength.

## 3. Architecture decision

### 3.1 Core shape

```text
Multi-lane command
       |
       v
Durable coordinator ---- policy/admission ---- account-scoped scheduler
       |                                      |
       | creates stable lanes                 | grants bounded slots
       v                                      v
  lane mailbox A --------------------> normal single-chat driver A
  lane mailbox B --------------------> normal single-chat driver B
  lane mailbox C --------------------> normal single-chat driver C
       |                                      |
       v                                      v
per-lane ordered events <---- private stream parser / tool loop / abort tree
       |
       v
transactional event outbox -> client stream and deterministic final aggregate
```

The coordinator never combines models into a provider request. It never parses a shared provider byte stream. It binds the returned `Response` object to the lane before reading its first byte. Model name and completion order are not correlation keys.

For each admitted generation:

1. select one lane and its pinned account/connection;
2. build one normal single-model MaxAI request;
3. issue one normal `/gpt/cwc/chat` operation;
4. create a fresh parser instance owned by that lane attempt;
5. emit lane-tagged answer, reasoning, tool, error, and terminal events;
6. release the scheduler slot only after the response body and tool work are drained or canceled.

A tool continuation is another normal chat operation in the same lane. A reply-all is N separately admitted lane turns. There is no inferred batch endpoint, group-conversation bus, or cross-model synthesis step.

Stateless helpers may be shared. Account-scoped credential refresh must also use one atomic, persistent singleflight so lanes do not race token rotation. The scheduler, signer constants, and immutable model catalog may be shared. Mutable request, parser, reasoning, tool, history, and abort state may not be shared.

### 3.2 Two conversation drivers, never mixed in one lane

The persistence model must support two explicit provider-history modes.

#### `request_replay` — current proven bridge

This is the behavior in the current TypeScript executor.

- The local lane owns the durable transcript.
- Each chat attempt mints a fresh `provider_request_conversation_id`.
- The lane's full relevant transcript is flattened into the normal request.
- Provider message and parent-message IDs are absent and stored as `null`.
- Continuation uses the stable local lane ID and local transcript.

This is the closest directly verified path for an initial coordinator. It must not call its request-scoped provider UUID a stable conversation.

#### `native_thread` — product-parity target, gated

This follows the saved extension and historical wire design.

- Each lane owns one random `provider_conversation_id` for its lifetime.
- Each durable user and final-assistant message has a preallocated random provider-protocol `message_id`.
- Each message stores its exact `parent_message_id`.
- The generation request uses the same lane conversation ID and empty `chat_history`.
- Provider bookkeeping surrounds the same normal `/gpt/cwc/chat` stream.

This is the correct target for native panel-like threads, but it is not yet proved on the current TypeScript base. It also deliberately persists conversation content at the provider, while no safe delete/rollback contract has been recovered. Keep it disabled until current-base offline fixtures, retention/consent review, and separately authorized live validation pass. Do not switch an existing lane between modes. A mode change creates a new forked lane and records the lineage.

The distinction prevents a serious identity error:

- `provider_conversation_id` is stable only in `native_thread`;
- `provider_request_conversation_id` is per attempt in `request_replay`;
- `normalized_completion_id` is an OmniRoute-facing ID and must never be logged as a provider response ID;
- `provider_response_id` is populated only if an actual provider field/header supplies one. Otherwise it remains `null`.

## 4. Identity contract

All local IDs are generated and committed before admission. They are opaque random UUIDs. They do not contain a model name, account ID, array position, or provider ID.

| Field | Scope and rule |
|---|---|
| `run_id` | Stable ID for one submitted multi-lane run. Reusing the same client idempotency key returns this run instead of creating another. |
| `lane_id` | Stable ID created once per logical lane. It survives queueing, retries, restart, selected continuation, and reply-all. It is never the display index. |
| `lane_ordinal` | Immutable display/order value within the run. It can be `0..N-1`, but is never used as identity. |
| `parent_lane_id` / `fork_turn_id` | Optional lineage when an earlier turn is branched or a conversation mode changes. |
| `turn_id` | Stable ID for one user-visible input in one lane. A reply-all creates a different `turn_id` in each lane. |
| `reply_group_id` | Stable local ID for one reply-all command. It identifies the immutable target snapshot but never replaces each lane's own `turn_id`. |
| `attempt_id` | ID for one dispatch attempt of a turn. Retries never overwrite an earlier attempt. |
| `provider_conversation_id` | Stable lane thread only for `native_thread`. Generate randomly, persist before first provider side effect, and never reuse across lanes or accounts. |
| `provider_request_conversation_id` | Request-scoped conversation UUID for `request_replay`, and optionally a separate request correlation field if the provider later exposes one. Never promote it to lane identity. |
| `provider_user_message_id` | Client-generated provider-protocol ID for the durable user append in `native_thread`. Persist before sending. Track submitted and provider-acknowledged state separately. |
| `provider_assistant_message_id` | Client-generated provider-protocol ID for the final assistant append in `native_thread`. Persist before sending. Track submitted and provider-acknowledged state separately. |
| `provider_parent_message_id` | Exact prior committed provider message ID. The first user message uses the captured empty-root form. A final assistant message points to the current user message. The next user points to the last committed assistant. |
| `provider_response_id` | Actual provider response/request identifier only when present on the wire. Do not synthesize it. |
| `normalized_completion_id` | Local OpenAI-compatible response ID. It is not provider evidence. |
| `tool_call_id` | Lane-local tool call identity, unique within a turn and bound to `lane_id`, `turn_id`, and `attempt_id`. |

Namespace every provider-side identifier internally by provider, restricted connection reference, and protocol version. The same UUID-shaped value from another account or generation is not the same identity. For provider mutations, keep `submitted`, `acknowledged`, and `reconciled` states separate; a locally allocated ID is not proof that the provider accepted it.

The selected connection is stored as an internal opaque `connection_ref`. Public responses and normal logs must not expose a raw account, device, user, token, or cookie identifier. Pin the run to this connection. Never fail over an existing lane to another account because that changes both provider history and quota identity.

The saved client's `taskId` is an in-memory cancellation lookup key, not a provider conversation, message, or response ID. If an implementation keeps the concept, name it `local_transport_task_id` and scope it to one attempt.

## 5. Per-lane state machine

### 5.1 Lane states

```text
CREATED -> QUEUED -> READY -> RUNNING -> IDLE
                         |        |       |
                         |        |       +-> QUEUED (next turn)
                         |        +-> SYNC_PENDING
                         |        +-> FAILED / CANCELLED / AMBIGUOUS
                         +-> REJECTED / CANCELLED
```

A lane has at most one active user turn. Each lane has a FIFO mailbox and a monotonic `lane_revision`. Dispatch uses compare-and-swap on the expected revision. This prevents a selected reply and a reply-all from entering the same lane in the wrong order.

A run reaches a terminal state only after all admitted lane work has reached a terminal or explicitly recoverable state. The normal outcome for mixed results is `COMPLETED_WITH_ERRORS`, not silent loss of failed lanes.

### 5.2 Native-thread turn sequence

For `native_thread`, one ordinary user turn is a small saga:

1. **Prepare locally.** In one database transaction, validate the lane revision, create `turn_id` and `attempt_id`, allocate the user message ID, copy the current provider parent ID, store a content digest/reference, and set `USER_APPEND_PLANNED`.
2. **Admit all expected work.** Reserve queue bytes, memory weight, and the endpoint/request budget before any upload or provider side effect. Acquire an account/global scheduler lease immediately before each provider operation; do not hold an active-chat lease while waiting on local tool work.
3. **Ensure the conversation if required.** On first use, run only the current fixture-proved create/upsert/touch operation and journal it. The saved implementations differ in when they sync metadata, so do not assume an unverified ordering.
4. **Append the user message.** Send one normal captured-shape `/conversation/add_messages` operation. It uses the lane conversation ID, the preallocated user message ID, the saved parent ID, and `includeHistory:true`. Record intent before send and receipt after the response.
5. **Generate normally.** Send the ordinary single-model `/gpt/cwc/chat` request with the same conversation ID, `chat_history:[]`, `streaming:true`, and the lane's current active input. Use the standard signed transport and a lane-private parser.
6. **Run tools if requested.** Intermediate tool-call and tool-result messages stay in the local turn state. Each tool continuation is another normal chat request in the same lane. Do not append intermediate prompted-tool artifacts as durable provider messages unless a future capture proves the exact native contract.
7. **Commit the answer locally.** After a valid stream terminal, store the visible answer and any provider-exposed reasoning separately. Allocate the final assistant message ID with the current user message as parent.
8. **Append the final assistant answer.** Append only the user-visible final answer through `/conversation/add_messages`. Do not silently put provider-exposed reasoning or local tool traces into the provider's durable answer.
9. **Sync metadata.** Upsert/touch conversation metadata and `lastMessageId` using the current fixture-proved shape. Treat this as bookkeeping, but audit its result.
10. **Commit the lane.** Atomically advance the lane's last provider message ID and revision, mark the turn committed, and publish the durable terminal event through the outbox.

Native history is authoritative only if its writes succeed. A failed or ambiguous user append blocks chat. A failed or ambiguous assistant append leaves the turn `SYNC_PENDING` and blocks later continuation. Do not copy v2's historical best-effort “log and continue” behavior; it can make the local and provider parent chains diverge.

Keep the full local transcript in native mode too. It is needed for audit, recovery, explicit forks, and provider-state comparison. Provider-exposed reasoning is stored separately and is not replayed into provider history unless a later, reviewed protocol contract explicitly requires it.

The exact handling of system/developer instructions and intra-turn tool context in native mode still needs captured-fixture verification on the current base. Do not invent a provider field or claim this part is live-proven. Until that gate passes, `request_replay` remains the defensible bridge.

### 5.3 Request-replay turn sequence

For `request_replay`:

1. create the local turn and attempt;
2. reserve admission and budget;
3. build the lane-only local transcript;
4. mint and persist a fresh request-scoped provider conversation ID;
5. invoke the normal current single-chat request/parser;
6. persist answer, provider-exposed reasoning, tools, and terminal state;
7. append the committed local turn to that lane only.

There are no provider message/parent IDs in this mode. Fields must be `null`, not guessed. The current executor mints its UUID internally, so the coordinator interface must be extended to accept a preallocated request conversation ID or durably return it before dispatch. Recovering it only from the normalized completion after success is too late for cancellation and crash audit.

## 6. Stream parsing and reasoning demultiplexing

### 6.1 One parser instance per active lane request

Each active lane request owns all of this mutable state:

- `TextDecoder` state;
- incomplete SSE-line buffer;
- normalized compact/expanded frame accumulator;
- reasoning-tag splitter state;
- answer and reasoning byte counters;
- terminal/error classification;
- per-lane `event_seq`;
- cancellation flag and upstream reader;
- tool-envelope buffer when prompted tools are enabled.

No item is global or shared with another lane. The response task closes over `lane_id`, `turn_id`, and `attempt_id` before reading the body. Every emitted event includes those local IDs. This is the demultiplexer. It does not depend on model name, response order, or a provider-supplied lane field.

The public event envelope is:

```text
run_id
lane_id
lane_ordinal
turn_id
attempt_id
lane_event_seq
kind: answer_delta | reasoning_delta | tool_call | tool_result |
      usage | warning | error | terminal
payload or restricted payload_ref
```

A separate global `emit_seq` can preserve the exact interleaving seen by a streaming client. Replay uses `emit_seq`; per-lane reconstruction uses `lane_event_seq`.

### 6.2 Normal parser requirements

Recovered ordinary chat is blank-line-delimited `data: <JSON>` SSE. Expanded frames use `data_key`, `data_type`, `streaming_status`, `need_merge`, and the keyed value. Captured ordinary streams included chat-mode, preprocessing, text, and next-action data (`EXT:docs/sections/c-thinking/analysis.md:52-74`). The saved client also recognizes compact aliases `K/T/S/M/V` (`EXT:beautified/extension__chunks__6GSZNDSL.js.pretty.js:45596-45633`), but a fresh recount of the retained baseline found only expanded frames. This is a protocol observation, not permission to ignore the compact compatibility path.

Use one hardened successor of the normal single-chat parser everywhere. Do not maintain a weaker parallel parser.

It must:

1. parse bounded SSE lines incrementally, including a final line without a trailing newline;
2. normalize the captured expanded frame keys and the saved-client compact aliases. The fresh baseline recount saw expanded frames only, so compact framing remains static compatibility evidence;
3. apply the saved-client merge rules for text, arrays, and objects;
4. classify auth, paywall, quota, preprocessing, error, and terminal frames;
5. require a valid success condition. HTTP 200 plus an empty/ignored stream is not success;
6. bound individual frames, total bytes, answer bytes, and reasoning bytes before parsing or appending;
7. cancel and release the upstream reader on client, lane, run, deadline, or policy cancellation;
8. preserve typed error class and `Retry-After` without logging raw provider bodies.

The current parser's text-frame and `<think>` logic is reusable as a tested core, but not sufficient unchanged. `UP` recognizes only mergeable text frames and exact lower-case `<think>`. The audit shows that ignored 200-level error frames can become empty success (`audit-source/MAXAI-SOURCE-REVIEW.md:303-309`). Terminal recognition must be event-aware: a captured `chat_mode` frame can report `complete` near the start, so `streaming_status:"complete"` alone is not global end-of-stream proof. The captured SSE also supplies no authoritative finish reason or usage object; any normalized usage estimate must be labeled local.

### 6.3 Reasoning contract

Reasoning is only one of these:

- a provider-exposed reasoning field with a captured and fixture-tested meaning; or
- provider-emitted text inside an allowlisted reasoning tag, such as the captured `<think>...</think>` form.

It is never a reconstruction of hidden model state. In the current recovered native evidence, the positive reasoning signal is inline exact lower-case `<think>` text. No separate provider reasoning endpoint/field or request-side effort setting was observed. The normalized `reasoning_content` field is an adapter output.

Rules:

- emit answer and reasoning as different event kinds and persist them in different fields;
- keep a separate splitter instance per lane attempt;
- handle tags split at every byte/frame boundary;
- support answer text before and after a tagged block;
- mark an unterminated tagged tail as exposed reasoning plus `incomplete_tag:true`; do not silently move it into the answer;
- treat the no-reasoning case as `reasoning_present:false`, not proof that the model did not reason;
- never use model name to decide which lane owns reasoning;
- never mix scaffold/plugin narration from historical v2 with provider-exposed reasoning.

The older v1 multi-tag parser supports `think`, `thinking`, `reason`, `reasoning`, `thought`, and `reasoning_scratchpad`, including case/attributes, multiple blocks, split tags, and unterminated blocks (`SYN:56,76-80`). That is a useful parser design and test corpus. Only dialects accepted by current captured fixtures should be enabled in production. Broader recognition can create false positives in normal prose.

## 7. Tool contract

MaxAI tools in the reviewed TypeScript line are prompted text, not a recovered provider-native function-call API. The captured stream's `next_action` value is UI follow-up metadata, not a native tool call. Tool processing therefore remains a local lane concern.

Each lane owns:

- an immutable snapshot of the requested tool definitions;
- a cryptographically random per-attempt tool nonce;
- an exact allowlist of canonical tool names;
- a unique-call-ID set;
- call-count, argument-byte, output-byte, cycle, and time budgets;
- a private capability scope and working directory;
- ordered assistant-tool-call and tool-result messages in the local transcript.

Parse and remove provider-exposed reasoning before scanning for tool envelopes. Only the visible-answer channel may produce a tool call. Reasoning text is never executable. When tools are enabled, keep the visible-answer channel in a bounded per-lane buffer until envelope classification finishes; otherwise an accepted tool block could already have leaked as answer text. Reasoning events may still be emitted under their separate policy.

A tool envelope is executable only when all checks pass:

1. the exact nonce is present and matches;
2. the name is an exact member of the submitted tool set;
3. arguments are valid JSON and pass that tool's schema;
4. the call count and bytes remain within the lane budget;
5. the call ID is new in the turn;
6. the lane and attempt are still active.

Rejected or malformed envelopes remain text or produce a typed lane error. They do not fall through to an arbitrary emitted tool name.

The current shared parser cannot be reused unchanged. It creates the nonce with `Math.random()`, tolerates a missing nonce, and can accept an explicit unknown name (`UP:open-sse/translator/webTools.ts:33-40,427-500`; audit finding `SEC-TOOL-01`). The current narration-miss retry also spends another provider request. Keep it OFF by default. If later retained, it must be an explicit, budgeted, audited attempt and must not hide its cost.

Tool continuation rules:

- serialize tool loops inside the lane;
- never share tool-call IDs, results, paths, or mutable working state across lanes;
- do not send tool output to reply-all siblings;
- persist the tool result before the next normal chat request;
- do not automatically retry a tool with unknown side effects;
- cancellation stops future calls and signals current work, but an already committed external side effect is reported as `side_effect_unknown` unless the tool has its own idempotency proof.

Final2's private directories, no-follow file checks, call-ID checks, bounded local tools, and artifact hashes are reusable patterns (`I/scripts/probes/maxai-parallel-agent-probe.mjs:335-520,626-753`). They do not constitute a general production tool sandbox.

## 8. Continuation, reply-all, and branching

### 8.1 Selected-lane continuation

A selected continuation takes:

- `run_id`;
- stable `lane_id`;
- `expected_lane_revision`;
- a client idempotency key;
- the new user input and optional allowed tools.

It appends one new `turn_id` to that lane's mailbox. The lane's model, connection affinity, conversation mode, and provider conversation remain unchanged unless the caller explicitly creates a fork. A stale revision returns a conflict instead of racing another continuation.

### 8.2 Reply-all

A reply-all operation is local fan-out, matching the saved shared-composer shape:

1. take an immutable snapshot of eligible lane IDs and their revisions in `lane_ordinal` order;
2. create one `reply_group_id`;
3. atomically create one independent turn per lane;
4. enqueue those turns under the normal scheduler;
5. run one normal chat operation per admitted lane;
6. report a result for every snapshotted lane.

Reply-all does not share provider conversation IDs, parser state, tool state, or response buffers. It does not imply simultaneous provider dispatch. With a live active-concurrency policy of one, the same reply-all works by queueing lanes serially.

Preflight has two explicit policies:

- `strict` (default): if any selected lane is not eligible before side effects, enqueue none;
- `best_effort`: create a terminal preflight error for each ineligible lane and enqueue the rest.

After dispatch, lane failures are always represented individually. One ordinary lane failure does not cancel successful siblings. Only an explicit run cancel or an account-level safety breaker, such as auth/paywall/quota, stops other work. Even then, already dispatched work is drained and reported.

### 8.3 Branching and regenerate

Provider server-side history cannot be assumed to support rewind.

- A normal continuation always extends the latest committed lane turn.
- Editing or regenerating from an earlier turn creates a new `lane_id`, sets `parent_lane_id` and `fork_turn_id`, and starts a new provider conversation.
- A branch can be seeded from the local transcript only under a declared transport mode. It must not reuse the old provider conversation and pretend its later messages do not exist.

This is safer than copying the extension's delete/regenerate behavior before provider delete and rollback semantics are verified.

## 9. Persistence model

Use durable storage, not a process-local map.

| Record | Minimum fields |
|---|---|
| `multilane_run` | `run_id`, owner/tenant ref, opaque connection ref, client idempotency key, status, requested logical-lane count, policy snapshot/version, source/image version, created/updated timestamps. |
| `lane` | `lane_id`, `run_id`, ordinal, parent/fork refs, requested model, resolved outbound model, adapter-response model, actual provider-reported model if one exists, conversation mode, restricted provider conversation ID, last committed provider message ID, revision, status, queue position, timestamps. |
| `turn` | `turn_id`, `lane_id`, turn ordinal, reply-group ID, input content reference and keyed digest, expected revision, provider user/assistant/parent IDs where applicable, state, terminal class. |
| `attempt` | `attempt_id`, `turn_id`, attempt number, request-scoped provider conversation ID, actual provider response ID if exposed, normalized completion ID, endpoint phase, dispatch/first-byte/terminal times, byte counts, status/error class, retry lineage. |
| `tool_invocation` | lane/turn/attempt IDs, local tool-call ID, exact allowed tool name, argument/result restricted references and keyed digests, state, side-effect class, timestamps. |
| `lane_event` | append-only `emit_seq`, `lane_event_seq`, correlation IDs, event kind, restricted payload reference/digest, timestamp. |
| `provider_effect` | write-ahead intent and receipt for user append, chat dispatch, assistant append, metadata upsert, and any future reconciliation read. |
| `outbox` | client-visible events committed in the same transaction as state changes, with delivery/replay status. |

Raw conversation content needed by `request_replay` or recovery belongs in an encrypted, access-controlled content store with an explicit retention period. It does not belong in normal logs or the audit ledger. Use keyed digests for low-entropy content and account references; plain public hashes can leak equality.

Provider IDs are operationally sensitive even when they are not credentials. Keep them in restricted fields and redact them from ordinary client responses and logs.

## 10. Ordering and result contract

There are three different orders. Keep all three explicit.

1. **Lane order:** immutable `lane_ordinal`, used for display and final aggregate order.
2. **Turn order:** monotonic per-lane turn ordinal, enforced by the lane mailbox and revision.
3. **Arrival order:** append-only `emit_seq`, used to replay interleaved stream events exactly as observed.

Rules:

- final results are sorted by `lane_ordinal`, never completion time;
- stream events may interleave, but every event carries `lane_id` and `lane_event_seq`;
- a lane terminal event follows all answer/reasoning/tool events for that lane attempt;
- a run terminal event follows terminal/recoverable outcomes for all snapshotted lanes;
- duplicate event delivery is safe because `(attempt_id, lane_event_seq)` is unique;
- requested, resolved outbound, adapter-response, and actual provider-reported model IDs are stored separately. The last field stays `null` if the provider does not expose it. A real mismatch is a typed failure, not silently accepted;
- no cross-lane synthesis occurs unless a separately named synthesizer lane is submitted and audited as another ordinary lane.

Final2's reverse-completion test and input-order result mapping are useful evidence for these rules. Its fail-fast “one lane aborts all” behavior is a probe policy, not the product default.

## 11. Cancellation

Cancellation is hierarchical and durable:

```text
run cancel
  -> all queued and active lanes
lane cancel
  -> current and queued turns in one lane
turn cancel
  -> current attempt, stream reader, uploads, and local tools
```

Sequence:

1. persist `cancel_requested` and its scope;
2. remove queued work before it gets an admission slot;
3. signal the linked `AbortController` for active transport, response reader, uploads, and tools;
4. stop publishing late frames by checking the current `attempt_id`/epoch;
5. cancel or drain every response body;
6. release slots only after cleanup completes or is declared stuck;
7. persist the exact local outcome.

Local abort does not prove provider-side cancellation. If a request may have reached the provider, use `CANCELLED_UPSTREAM_UNKNOWN`, not a false “not run” state. If the user message was already appended in native mode, continuation remains blocked until reconciliation or an explicit fork decision.

Do not confuse:

- queue wait timeout;
- execution deadline;
- caller cancellation;
- provider stream failure;
- provider-side generation cancellation.

The recovered client can stop transport work per active conversation, while V8/final2 improve reader cancellation. The saved path uses a local `AbortController`; there is no recovered server cancel endpoint or live cancel trace, and static control flow can still reach post-send persistence after manual abort. An empty or partial remote assistant row is therefore a risk to reconcile, not a proved wire outcome. No provider guarantee that an HTTP abort stops generation or billing was recovered. The coordinator must make that uncertainty visible.

## 12. Restart and recovery

Every provider mutation uses write-ahead intent. Recovery never blindly repeats a non-idempotent or quota-consuming operation.

| Recovered phase | Safe action |
|---|---|
| `QUEUED`, no dispatch intent | Requeue with the same `lane_id`, `turn_id`, and attempt plan. |
| Admission granted, no provider-effect intent | Release stale lease and requeue. |
| User-append intent without receipt | `native_thread`: reconcile by the preallocated message ID if the read contract is enabled; otherwise mark `NEEDS_RECONCILIATION`. Do not allocate another message ID and resend. |
| User append confirmed, no chat-dispatch intent | Resume the chat step under a new lease, using the same turn and provider conversation. |
| Chat-dispatch intent, streaming, or transport loss | Mark `AMBIGUOUS_CHAT`. SSE has no recovered resume token. Do not automatically regenerate or charge again. An explicit retry creates a new attempt and records the possible duplicate. |
| Complete answer durably stored, assistant append not started | Continue the provider-sync step. |
| Assistant-append intent without receipt | Reconcile by the preallocated assistant message ID before any retry. |
| Assistant append confirmed, upsert incomplete | Retry metadata only if current fixtures establish safe upsert semantics; otherwise keep a sync warning. |
| Turn committed and outbox pending | Replay the stored outbox event. Do not contact the provider. |
| Canceled after any dispatch intent | Preserve `UPSTREAM_UNKNOWN` until reconciled. Do not silently requeue. |

The saved extension contains message lookup operations by conversation/message ID, so reconciliation is architecturally plausible (`EXT:beautified/extension__chunks__6GSZNDSL.js.pretty.js:40827-40894`). Their current authenticated behavior, consistency delay, limits, and safe use are not proved for OmniRoute. Native-thread release therefore requires fixture tests and a separately authorized validation of the reconciliation contract.

If reconciliation cannot prove the provider state, the safe choices are:

- keep the lane blocked for operator review;
- return the locally completed answer with `provider_sync_pending` and block continuation; or
- create an explicit fork with a new provider conversation and locally seeded history.

Never repair uncertainty by silently duplicating an append, chat, tool, or upload.

## 13. Admission and live concurrency policy

Logical capacity and live provider concurrency are separate settings.

### 13.1 Logical lanes

`max_logical_lanes_per_run` is an operator/product resource limit. It controls how many durable lane records and queued tasks can exist. It is configurable and has no value derived from a claimed MaxAI provider maximum.

Admission checks before records become runnable:

- lane count and total queued count;
- prompt/history/attachment bytes per lane and per run;
- expected provider transaction budget;
- tool cycles and side-effect class;
- storage and event-outbox budget;
- model allowlist and requested/resolved mapping;
- one selected connection/account for the run;
- feature gates for native history, tools, attachments, and spill.

### 13.2 Active concurrency

Use separate controls:

- `max_active_chat_requests_per_account`;
- `max_active_provider_operations_per_account` for bookkeeping/upload/chat combined;
- `max_active_chat_requests_global`;
- per-tenant weighted queue and fairness;
- per-lane active chat limit of one;
- queue-wait deadline and execution deadline;
- run/day transaction and byte budgets;
- account circuit breakers for auth, paywall, quota, 418, 429, and repeated 5xx.

A logical reply-all can contain many lanes while the active limit is one. This preserves the architecture without asserting provider concurrency.

**Current policy:** the multi-lane product feature is default-OFF, and parallel live provider calls remain prohibited. If a later pre-live stage permits queued multi-lane behavior without parallel dispatch, both its active-chat limit and its all-provider-operation limit are one per account. This prevents bookkeeping, upload, refresh, or chat work from overlapping accidentally. The final2 exact two-lane result is historical evidence, not permission or a durable limit. Any future active value greater than one requires a separate policy revision and live envelope. This is independent of the configured logical-lane count.

The recovered layouts through six do not prove six is a maximum. Separate seven/twelve aggregate host execution is recovered, while the exact 30/32 per-request episode remains missing. None of these numbers becomes an automatic scheduler setting.

### 13.3 Transaction budgeting

Count provider operations, not “lanes.” In native mode, one user turn can require:

- zero or one first-use conversation ensure/touch, depending on the fixture-proved flow;
- one user append;
- one or more normal chat requests because of tools;
- one assistant append;
- one metadata sync/upsert;
- bounded reconciliation reads after uncertainty.

Reserve the worst allowed transaction count before starting the turn. Do not begin a turn that cannot finish inside its budget. Retries consume new budget and are never called free.

## 14. Failure policy

Failures fall into three scopes.

- **Lane-local:** malformed output, model mismatch, one tool failure, one lane timeout. Record the lane error and allow siblings to finish.
- **Account safety:** auth failure, paywall, quota, 418/429, selected-route failure, or credential inconsistency. Open the account breaker, stop admitting new work, and cancel or drain active work according to policy.
- **Run-global:** explicit caller cancel, corrupt run state, violated total budget, or audit/persistence failure. Stop admission and settle every lane.

Provider errors must be typed. HTTP 200 is not sufficient. Empty-body, error-only, missing-terminal, malformed-frame, and size-limit outcomes cannot become successful empty answers.

Automatic retry is limited to operations proven replay-safe. No evidence proves that chat generation, user/assistant append, tool execution, or uploads are generally idempotent. Ambiguous operations require reconciliation or explicit user action.

## 15. Audit and privacy contract

The audit log is append-only and metadata-first. Each event records:

- run/lane/turn/attempt IDs and sequence numbers;
- operation phase and endpoint class, not secret URL parameters;
- conversation mode and restricted provider-ID references;
- requested, resolved outbound, adapter-response, and provider-reported model IDs, with absent provider fields kept null;
- opaque connection reference;
- admission policy version and granted resource weights;
- source commit/image digest and parser/tool contract version;
- start, first-byte, terminal, cancellation, and cleanup times;
- request/response byte counts and provider-operation counts;
- usage values plus `usage_source`, which is `local_estimate` unless a real provider field supplies it;
- reasoning presence and byte count, never an inference of hidden reasoning;
- tool name, authorization result, side-effect class, and restricted argument/result digests;
- terminal state, typed error class, retry/recovery lineage, and `Retry-After` metadata;
- cancellation certainty: before dispatch, locally aborted, or upstream unknown.

Normal logs, metrics, review-safe audit exports, and operator summaries must never contain:

- access/refresh tokens, cookies, signed headers, signing inputs, or auth fragments;
- raw account, user, or device identifiers;
- raw prompts, answers, provider-exposed reasoning, or tool arguments/results;
- raw provider error bodies;
- unrestricted provider conversation/message IDs.

The authenticated requester can receive its own answer, reasoning channel, and tool results through the result/event API under the normal content-access policy. Those payloads are not audit metadata and must not be copied into logs or summaries.

When content retention is explicitly enabled, store content encrypted in the restricted content store and place only a reference plus keyed digest in the audit event. Verify log redaction with automated secret/canary scans.

## 16. Reuse disposition

### 16.1 Reuse as the base or as a proven pattern

1. **Normal request shape and explicit model routing.** Reuse the current single-chat body builder and one-model request path, rebased onto the eventual current clean source. Do not create a multi-model provider body.
2. **One parser per request.** Reuse the current SSE decoder/text-frame/`<think>` core and V8/final2 cancellation, final-line, and response-bound patterns. First add complete terminal/error handling and pre-parse line bounds.
3. **Saved client topology.** Reuse the pattern of one independent conversation/model/action/stream per panel, shared-composer fan-out, panel-targeted operations, and per-conversation stop. Treat it as static architecture evidence, not capacity proof.
4. **Final2 lane isolation tests.** Reuse reverse completion, adapter model checks, separate histories, answer/reasoning/tool isolation, per-lane abort, request budgeting, reply-all, and selected-continuation scenarios. Do not mistake an adapter-echoed model field for independent provider model attestation.
5. **Final2 safe local-tool patterns.** Reuse private directories, no-follow path checks, byte bounds, unique IDs, and artifact digests as test inputs.
6. **V1 pool semantics.** Reuse bounded scheduling, per-lane error capture, and deterministic result ordering. Reuse the multi-tag parser as a test/design donor, not as evidence that every dialect remains current.
7. **V2 native-history builders and tests.** Reuse the conversation/message/parent data model, durable-turn filter, and golden request sequence as donors. Replace the process-local registry with durable storage and a recovery journal.
8. **Account and execution hardening from the audit.** Preserve current upstream credential/nonce/queue invariants and port refresh, selected-transport, cancellation, body-bound, and redaction concerns only after their named audit blockers are fixed.

### 16.2 Do not reuse unchanged or do not claim proved

1. Do not reuse final2's numeric lane index as identity.
2. Do not reuse final2's in-memory `hostResults` as persistence or recovery.
3. Do not treat its fresh request conversation UUID or fabricated `chatcmpl-*` ID as a stable provider lane/thread or provider response ID.
4. Do not reuse final2's probe-only product surface, fixed deployment assumptions, automatic context spill, or fail-fast sibling cancellation as the default product contract.
5. Do not reuse the current prompted-tool parser until exact nonce, exact name allowlist, schema, count, and byte checks are fixed.
6. Do not reuse the current stream parser until 200-level error/paywall/quota/terminal handling and null-body behavior are fixed.
7. Do not call historical v2 scaffold narration provider reasoning.
8. Do not call provider server-side recall unlimited. The recovered evidence is bounded and includes a selective-recall failure report.
9. Do not rely on provider append/chat/upsert idempotency, deletion, rollback, or cancellation. These remain unproved.
10. Do not infer a provider maximum from recovered layouts, old local constants, offline waves, database writers, or the two-lane live run.
11. Do not infer that more than six failed or is unsupported. It is owner-attested history with unrecovered evidence.
12. Do not merge proof counts across v1, v2, current upstream, V8, and final2. They are different source/runtime boundaries.

## 17. Exact proof gaps before release

The architecture can be implemented and tested offline, but these claims remain open:

1. A current-base `native_thread` implementation matches the current provider protocol.
2. Stable conversation plus message/parent chains work independently in more than one lane.
3. Duplicate message IDs are idempotent, or the read/reconcile path can safely distinguish applied from unapplied writes.
4. Conversation upsert can be retried safely after a crash.
5. Native-mode system/developer instructions and intra-turn prompted-tool context preserve current semantics.
6. Concurrent positive provider-exposed reasoning stays isolated. Final2's live run returned no reasoning.
7. Live selected-lane continuation and reply-all preserve the intended provider threads.
8. A canceled HTTP stream stops provider work, billing, and persistence. No such guarantee is recovered.
9. The full success/error/terminal SSE schema is captured and handled fail-closed.
10. The hardened prompted-tool protocol works end to end across supported model dialects without false positives.
11. Restart recovery works at every provider-effect boundary without duplicate generation or messages.
12. Same-account concurrent capacity, rate limits, terms, and safe pacing are known for any future active value above one.
13. Provider retention and safe deletion/rollback semantics are known.
14. A provider-authorized live or technical maximum remains unknown. Current evidence neither establishes six as the maximum nor recovers request-level proof for the owner's higher-lane history.
15. A clean current-base candidate with these changes has passed offline tests, build, packaging, rollback, and secret-log gates.

UC TTS and UC STT are not proof gaps for this slice. They are explicitly deferred/OFF and excluded; neither was live-tested here.

## 18. Offline validation contract

No live calls are needed for the implementation phase. A disposable current-source candidate must pass at least:

1. configurable logical-lane counts with active mock concurrency independently set to 1, 2, and other test values;
2. 30-or-more logical-lane stress as a local scheduler test only, with the mock active cap never exceeded. The test number is not a provider claim;
3. random and reverse completion with deterministic final order;
4. repeated models in different lanes, proving model is not the correlation key;
5. answer/reasoning/tool/conversation/message/parent/artifact isolation across lanes;
6. SSE tags split at every boundary, compact/expanded frames, multiple/unterminated tags, literal-tag prose/code false positives, no-reasoning, malformed data, 200-level errors, missing terminal, byte overflow, and final no-newline frame;
7. selected continuation, reply-all, strict/best-effort preflight, duplicate client idempotency keys, stale revisions, and forks;
8. crash/restart injection before and after every provider-effect intent/receipt;
9. no blind retry after ambiguous chat, append, tool, or upload;
10. lane/run cancellation while queued, before dispatch, during stream, during tool work, after local answer, and during provider sync;
11. account breaker behavior for auth/paywall/quota/418/429 and sibling drain;
12. exact tool nonce/name/schema/count/bytes checks, prompt-copy attacks, duplicate IDs, and non-idempotent side-effect reporting;
13. audit ordering, event replay, provider-ID restriction, raw-content separation, and secret/canary scan;
14. native-thread golden fixtures for user append → chat → assistant append → upsert and message-parent evolution;
15. request-replay fixtures proving each provider UUID is attempt-scoped and local continuation stays lane-private.

Any future live validation is a separate decision. It must name the immutable candidate, one exact account/connection, active-concurrency policy, endpoints and transaction budget, models, content class, stop rules, cancellation uncertainty, retention, audit output, and rollback. The current no-parallel live policy must be revised first.

## 19. Final architecture summary

The stable object is the **local lane**, not a panel index and not a provider response ID. A lane owns its model, account affinity, history mode, provider IDs, mailbox, parser, reasoning channel, tools, abort tree, and audit sequence.

The provider interaction remains ordinary single chat. The coordinator only repeats that operation across independently tracked lanes and schedules it under policy. Native provider conversations and message-parent chains are the target for panel-faithful continuation, while current request replay remains the proven bridge. The two modes are explicit and never mixed.

Logical lane count is configurable local capacity. The multi-lane feature is currently OFF; any later serial-only stage would set live active concurrency to one. Live active concurrency remains a separate account-scoped policy. Recovered layouts through six, an exact historical two-lane run, and owner-attested behavior above six are all preserved at their correct evidence strength. None is mislabeled as a recovered live maximum.
