---
title: Bounded Antigravity diagnostic capture
description: Temporary payload logging controls, limits, and privacy boundaries for controlled troubleshooting.
---

# Bounded Antigravity diagnostic capture

This is a proposed temporary diagnostic profile, not authorization to change a running deployment. Use an isolated candidate with synthetic or explicitly approved requests first. A read-only observation on 2026-10-06 found live pipeline capture enabled, while the stream-chunk, pipeline-size, body, string, array, debug-file and app-level environment overrides were unset. That means the pipeline artifact budget is 512 KiB and persisted stream chunks are disabled; an oversized history can therefore replace the pipeline with a size-limit marker even though detailed logging is enabled.

## Enablement and temporary profile

Three independent controls must agree: the database setting `call_log_pipeline_enabled` must be true, the selected inference API key must have `noLog=false`, and `CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS=true` must be present to retain stream excerpts. The authenticated dashboard action `POST /api/logs/detail` with `{"enabled":true}` sets the database flag. `GET /api/logs/detail?limit=1` reports the flag without changing it. `ENABLE_REQUEST_LOGS` affects the legacy detailed-log getter; it does not replace the chatCore database gate.

For a controlled cohort of at most two concurrent requests, at most 100 newly written artifacts (including retry/account legs), and at most ten minutes, propose:

```dotenv
CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS=true
CALL_LOG_PIPELINE_MAX_SIZE_KB=10240
CHAT_LOG_MAX_BODY_KB=4096
CHAT_LOG_TEXT_LIMIT=262144
CHAT_LOG_ARRAY_TAIL_ITEMS=2048
CHAT_LOG_MAX_OBJECT_KEYS=80
CHAT_LOG_MAX_DEPTH=20
CHAT_DEBUG_FILE=false
APP_LOG_LEVEL=info
```

Apply these process environment values only through an approved candidate deployment. Preserve the prior values and database flag for restoration. Check available memory and reserve at least 1000 MiB for 100 additional artifacts at the 10 MiB artifact cap, plus database, application logs and filesystem overhead. Stop capture when the cohort, time or storage budget is reached. Count artifacts and retry/account legs rather than only logical client requests; one client request can produce several records. Existing retention is unchanged: changing global entry-count or retention settings can delete unrelated historical logs and is a separate operator decision.

The database logging flag and environment controls are global. There is no existing provider-, correlation-ID-, or errors-only capture filter. A diagnostic key does not exclude traffic from other keys that also have `noLog=false`. Use isolation or an agreed quiet window; do not enable enlarged capture for 70–100 simultaneous agents and claim it is selectively scoped.

## What each bound means

| Layer                              | Default              | Proposed profile   | Limitation                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persisted artifact with a pipeline | 512 KiB              | 10 MiB             | Includes request, response, pipeline snapshots and metadata together. Oversize fallback removes chunks first, then oversized snapshots; a larger cap is not a full-history guarantee.                                                                                                               |
| Request/response summary boundary  | 1 MiB                | 4 MiB              | `truncateForLog` uses an early-exit size estimate. Larger objects become summaries; it is not an exact measurement of original JSON bytes.                                                                                                                                                          |
| Individual logged string           | 65,536 characters    | 262,144 characters | Both logger clones honor `CHAT_LOG_TEXT_LIMIT` in the corrected candidate. Previously the pipeline logger independently hardcapped strings at 64K. Character counts are not UTF-8 byte counts.                                                                                                      |
| History array                      | Last 1,000 items     | Last 2,048 items   | A sentinel records dropped history. The tool-definition array is exempt, so this is not a global object-count or memory limit.                                                                                                                                                                      |
| Object/depth bounds                | 80 keys / 20 levels  | Unchanged          | `CHAT_LOG_MAX_OBJECT_KEYS=0` removes the per-object key cap; avoid it for this bounded profile.                                                                                                                                                                                                     |
| Stream tracks                      | Disabled in chatCore | Enabled            | Provider, normalized OpenAI and client tracks each use the pipeline size value as their own capture counter, with at most 10,240 chunks per track. Those counters count JavaScript string characters, despite the historical bytes name. The final artifact cap uses actual serialized UTF-8 bytes. |

Three 10 MiB-character stream tracks can retain roughly 410 MiB of UTF-16 character storage per request before strings, arrays, copied histories, worker serialization and the original request are considered. The artifact worker queue has 128 job slots, not a byte-budget guarantee; under backlog it omits detail rather than making capture reliable. Small controlled concurrency is essential. The 10 MiB persisted cap does not bound peak process memory.

## Interpretation and privacy

A screenshot showing about 976K context tokens does not specify the serialized request size, number of history items or largest tool-result string. This profile can still summarize or truncate such a request. Inspect the retained size/truncation markers before claiming a complete transcript. Multiple translated snapshots consume the same artifact budget. Raising only `CHAT_LOG_MAX_BODY_KB` cannot overcome the artifact, string or array limits; missing historical payloads cannot be reconstructed.

Pipeline capture stores parsed request/response snapshots and bounded timestamped stream excerpts. It is not a lossless transport capture: raw upload bytes, framing, headers and every retry attempt are not preserved as a separate wire file. No existing optional errors-only raw-wire file feature exists. `CHAT_DEBUG_FILE=true`, or `APP_LOG_LEVEL=debug`, bypasses the final artifact size limit and pretty-prints the already bounded object; it neither restores earlier truncation nor scopes capture to errors. Keep both disabled for this profile.

API-key `noLog` and payload/video protection remain enforced. Header masking remains in place, but prompts, tool outputs, native signatures and stream excerpts may still contain private content. Artifacts are JSON files under `DATA_DIR/call_logs`, not the encrypted functional conversation-state store. Keep access and retention controlled. Error/telemetry fallback is the appropriate route for diagnosing large failed histories without promising full payload retention.

## Validation and closure

The configurable pipeline logger has regression coverage for larger and smaller string/key caps, unchanged defaults, zero-key semantics, tiny-cap marker bounds, idempotence, binary elision and secret-header masking. Before using this profile, validate a synthetic large-history failure against the exact compiled image: confirm bounded structured error and telemetry survive, inspect the truncation markers, and verify `noLog=true` still prevents payload persistence. Record the profile interval, request IDs, artifact sizes and restored values. Production activation requires explicit user approval.

## Private Antigravity overflow

An independent, default-off private capture can preserve approved payloads beyond the 10 MiB dashboard artifact. Its candidate-only profile is:

```dotenv
OMNI_DIAGNOSTIC_OVERFLOW_ENABLED=true
OMNI_DIAGNOSTIC_OVERFLOW_FILE_BYTES=67108864
OMNI_DIAGNOSTIC_OVERFLOW_TOTAL_BYTES=2147483648
OMNI_DIAGNOSTIC_OVERFLOW_RETENTION_MS=604800000
```

It requires enabled pipeline logging, an inference key without `noLog`, and no video-retention redaction. Original client data is **parsed JSON reserialized before translation**, not original HTTP framing or whitespace. Each Antigravity generation send, including regional, credits and project-header403 retries, receives a separate file for the exact serialized outgoing body and the bytes read from its transport response. OAuth enrollment/refresh exchanges are not captured, and secret authorization/cookie headers are discarded. Approved payload contents can still contain private data. Full private payloads never enter console logs or enumerable request properties.

Files are private gzip records with byte counts and integrity hashes. The limit is 64 MiB raw per file and 2 GiB of coordinated storage, with seven-day retention. This budget is separate from primary artifacts, which need another 1000 MiB for100 artifacts at their cap. Actual retries can create several files and artifacts per logical request. Existing full strings and serialization still consume heap; this is not permission for an unlimited capture cohort.

A file is complete only after actual read EOF and gzip flush/durability. Cancellation, timeout, remaining logical deadline, read/write failure, unsupported consumers and exhausted file/storage budgets seal an explicit incomplete prefix. The small primary artifact retains only a validated trace-ID reference, including after size-limit compaction; manager-authenticated inspection resolves the current private manifest. Capture completion means byte retention completed, not that an HTTP400/403/429 generation succeeded.

Opted-in error disposal drains the existing owned reader under caller cancellation, the remaining logical budget and at most30 seconds, stopping when capture cannot accept more bytes. The parser still retains only its original256 KiB prefix; no second reader or logging tee is added, and no extra upstream request occurs. Default-off behavior is unchanged. Successful streams are read only as requested by their consumer; early terminal cancellation is incomplete rather than a claim that wire EOF was seen. Capture I/O has its own retirement ownership, so a generation cannot be retired while gzip/fsync work remains.

The observed body-reader path and `text`, `json` and `arrayBuffer` use one captured reader. Caller-requested `clone`, `blob` or `formData` retain their ordinary behavior but mark capture unsupported/incomplete; they are not silently presented as full retention. Ordinary dashboard string/array/depth bounds remain independent preview limits. Private capture does not promise payloads beyond its explicit limits, reconstruct missing older logs, or constitute TLS/HTTP packet capture.
