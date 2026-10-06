---
title: Bounded Antigravity diagnostic capture
description: Temporary payload logging controls, limits, and privacy boundaries for controlled troubleshooting.
---

# Bounded Antigravity diagnostic capture

This is a proposed temporary diagnostic profile, not authorization to change a running deployment. Use an isolated candidate with synthetic or explicitly approved requests first. A read-only observation on 2026-10-06 found live pipeline capture enabled, while the stream-chunk, pipeline-size, body, string, array, debug-file and app-level environment overrides were unset. That means the pipeline artifact budget is 512 KiB and persisted stream chunks are disabled; an oversized history can therefore replace the pipeline with a size-limit marker even though detailed logging is enabled.

## Enablement and temporary profile

Three independent controls must agree: the database setting `call_log_pipeline_enabled` must be true, the selected inference API key must have `noLog=false`, and `CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS=true` must be present to retain stream excerpts. The authenticated dashboard action `POST /api/logs/detail` with `{"enabled":true}` sets the database flag. `GET /api/logs/detail?limit=1` reports the flag without changing it. `ENABLE_REQUEST_LOGS` affects the legacy detailed-log getter; it does not replace the chatCore database gate.

For a controlled cohort of at most two concurrent requests, at most 100 new requests, and at most ten minutes, propose:

```dotenv
CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS=true
CALL_LOG_PIPELINE_MAX_SIZE_KB=8192
CHAT_LOG_MAX_BODY_KB=4096
CHAT_LOG_TEXT_LIMIT=262144
CHAT_LOG_ARRAY_TAIL_ITEMS=2048
CHAT_LOG_MAX_OBJECT_KEYS=80
CHAT_LOG_MAX_DEPTH=20
CHAT_DEBUG_FILE=false
APP_LOG_LEVEL=info
```

Apply these process environment values only through an approved candidate deployment. Preserve the prior values and database flag for restoration. Check available memory and reserve at least 800 MiB for 100 additional artifacts at the 8 MiB artifact cap, plus database, application logs and filesystem overhead. Stop capture when the cohort, time or storage budget is reached. Existing retention is unchanged: changing global entry-count or retention settings can delete unrelated historical logs and is a separate operator decision.

The database logging flag and environment controls are global. There is no existing provider-, correlation-ID-, or errors-only capture filter. A diagnostic key does not exclude traffic from other keys that also have `noLog=false`. Use isolation or an agreed quiet window; do not enable enlarged capture for 70–100 simultaneous agents and claim it is selectively scoped.

## What each bound means

| Layer                              | Default              | Proposed profile   | Limitation                                                                                                                                                                                                                                                                                          |
| ---------------------------------- | -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persisted artifact with a pipeline | 512 KiB              | 8 MiB              | Includes request, response, pipeline snapshots and metadata together. Oversize fallback removes chunks first, then oversized snapshots; a larger cap is not a full-history guarantee.                                                                                                               |
| Request/response summary boundary  | 1 MiB                | 4 MiB              | `truncateForLog` uses an early-exit size estimate. Larger objects become summaries; it is not an exact measurement of original JSON bytes.                                                                                                                                                          |
| Individual logged string           | 65,536 characters    | 262,144 characters | Both logger clones honor `CHAT_LOG_TEXT_LIMIT` in the corrected candidate. Previously the pipeline logger independently hardcapped strings at 64K. Character counts are not UTF-8 byte counts.                                                                                                      |
| History array                      | Last 1,000 items     | Last 2,048 items   | A sentinel records dropped history. The tool-definition array is exempt, so this is not a global object-count or memory limit.                                                                                                                                                                      |
| Object/depth bounds                | 80 keys / 20 levels  | Unchanged          | `CHAT_LOG_MAX_OBJECT_KEYS=0` removes the per-object key cap; avoid it for this bounded profile.                                                                                                                                                                                                     |
| Stream tracks                      | Disabled in chatCore | Enabled            | Provider, normalized OpenAI and client tracks each use the pipeline size value as their own capture counter, with at most 10,240 chunks per track. Those counters count JavaScript string characters, despite the historical bytes name. The final artifact cap uses actual serialized UTF-8 bytes. |

Three 8 MiB-character stream tracks can retain roughly 48 MiB of UTF-16 character storage per request before strings, arrays, copied histories, worker serialization and the original request are considered. The artifact worker queue has 128 job slots, not a byte-budget guarantee; under backlog it omits detail rather than making capture reliable. Small controlled concurrency is essential. The 8 MiB persisted cap does not bound peak process memory.

## Interpretation and privacy

A screenshot showing about 976K context tokens does not specify the serialized request size, number of history items or largest tool-result string. This profile can still summarize or truncate such a request. Inspect the retained size/truncation markers before claiming a complete transcript. Multiple translated snapshots consume the same artifact budget. Raising only `CHAT_LOG_MAX_BODY_KB` cannot overcome the artifact, string or array limits; missing historical payloads cannot be reconstructed.

Pipeline capture stores parsed request/response snapshots and bounded timestamped stream excerpts. It is not a lossless transport capture: raw upload bytes, framing, headers and every retry attempt are not preserved as a separate wire file. No existing optional errors-only raw-wire file feature exists. `CHAT_DEBUG_FILE=true`, or `APP_LOG_LEVEL=debug`, bypasses the final artifact size limit and pretty-prints the already bounded object; it neither restores earlier truncation nor scopes capture to errors. Keep both disabled for this profile.

API-key `noLog` and payload/video protection remain enforced. Header masking remains in place, but prompts, tool outputs, native signatures and stream excerpts may still contain private content. Artifacts are JSON files under `DATA_DIR/call_logs`, not the encrypted functional conversation-state store. Keep access and retention controlled. Error/telemetry fallback is the appropriate route for diagnosing large failed histories without promising full payload retention.

## Validation and closure

The configurable pipeline logger has regression coverage for larger and smaller string/key caps, unchanged defaults, zero-key semantics, tiny-cap marker bounds, idempotence, binary elision and secret-header masking. Before using this profile, validate a synthetic large-history failure against the exact compiled image: confirm bounded structured error and telemetry survive, inspect the truncation markers, and verify `noLog=true` still prevents payload persistence. Record the profile interval, request IDs, artifact sizes and restored values. Production activation requires explicit user approval.
