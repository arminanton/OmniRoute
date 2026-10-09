---
title: Bounded Antigravity diagnostic capture
description: Temporary payload logging controls, limits, and privacy boundaries for controlled troubleshooting.
---

# Bounded Antigravity diagnostic capture

This is a proposed temporary diagnostic profile, not authorization to change a running deployment. Use an isolated candidate with synthetic or explicitly approved requests first. A read-only observation on 2026-10-06 found live pipeline capture enabled, while the stream-chunk, pipeline-size, body, string, array, debug-file and app-level environment overrides were unset. That means the pipeline artifact budget is 512 KiB and persisted stream chunks are disabled; an oversized history can therefore replace the pipeline with a size-limit marker even though detailed logging is enabled.

## Enablement and temporary profile

Three independent controls must agree: the database setting `call_log_pipeline_enabled` must be true, the selected inference API key must have `noLog=false`, and `CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS=true` must be present to retain stream excerpts. The authenticated dashboard action `POST /api/logs/detail` with `{"enabled":true}` sets the database flag. `GET /api/logs/detail?limit=1` reports the flag without changing it. `ENABLE_REQUEST_LOGS` affects the legacy detailed-log getter; it does not replace the chatCore database gate.

These proposed capture controls are global and should be applied only through a reviewed deployment profile:

```dotenv
CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS=true
CALL_LOG_PIPELINE_MAX_SIZE_KB=10240
CALL_LOG_PIPELINE_STREAM_CHUNK_MAX_SIZE_KB=512
CHAT_DEBUG_FILE=false
APP_LOG_LEVEL=info
OMNI_DIAGNOSTIC_OVERFLOW_ENABLED=true
OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES=3000000
OMNI_DIAGNOSTIC_OVERFLOW_FILE_BYTES=67108864
OMNI_DIAGNOSTIC_OVERFLOW_TOTAL_BYTES=1610612736
OMNI_DIAGNOSTIC_OVERFLOW_RETENTION_MS=21600000
```

Leave the existing text, array, depth and body preview settings at their defaults unless a separate memory-reviewed profile requires changing them. Preserve the existing database flag and restore it only when capture is no longer needed. The 10 MiB artifact limit is independent of the 512 KiB aggregate in-memory stream excerpt budget. Private Antigravity overflow code defaults are 64 MiB per file, 2 GiB total and seven-day retention; this temporary profile uses a 1.5 GiB total and six-hour retention. It records an explicit incomplete state when any bound is reached.

The database logging flag and environment controls are global. There is no existing provider-, correlation-ID-, or errors-only capture filter. A diagnostic key does not exclude traffic from other keys that also have `noLog=false`; every eligible request is subject to these bounded captures.

## What each bound means

| Layer                              | Default              | Proposed profile   | Limitation                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------- | -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Persisted artifact with a pipeline | 512 KiB              | 10 MiB             | Includes request, response, pipeline snapshots and metadata together. Oversize fallback removes chunks first, then oversized snapshots; a larger cap is not a full-history guarantee.                                                                                                                                                |
| Request/response summary boundary  | 1 MiB                | Unchanged          | `truncateForLog` uses an early-exit size estimate. Larger objects become summaries; it is not an exact measurement of original JSON bytes.                                                                                                                                                                                           |
| Individual logged string           | 65,536 characters    | Unchanged          | Both logger clones honor `CHAT_LOG_TEXT_LIMIT`; character counts are not UTF-8 byte counts.                                                                                                                                       |
| History array                      | Last 1,000 items     | Unchanged          | A sentinel records dropped history. The tool-definition array is exempt, so this is not a global object-count or memory limit.                                                                                                                                                                                                       |
| Object/depth bounds                | 80 keys / 20 levels  | Unchanged          | `CHAT_LOG_MAX_OBJECT_KEYS=0` removes the per-object key cap; leave the default cap in place.                                                                                                                                                                                                                                      |
| Stream tracks                      | Disabled in chatCore | Enabled            | Provider, normalized OpenAI and client excerpts share one 512 KiB per-request memory budget (configurable up to 1 MiB), with at most1,024 items. The estimate includes UTF-16 backing, UTF-8 serialization and per-item overhead. The persisted artifact cap is independent. |

At the default, 100 active requests retain at most 50 MiB of aggregate stream excerpts by this estimate. The call-log worker also limits its active plus queued artifact footprint to128 MiB; requests that exceed that detail budget continue inference with the detail omitted. Request parsing, translated bodies and private overflow writes have separate bounded memory costs, so these figures are not a total process memory guarantee.

## Interpretation and privacy

A screenshot showing about 976K context tokens does not specify the serialized request size, number of history items or largest tool-result string. This profile can still summarize or truncate such a request. Inspect the retained size/truncation markers before claiming a complete transcript. Multiple translated snapshots consume the same artifact budget. Raising only `CHAT_LOG_MAX_BODY_KB` cannot overcome the artifact, string or array limits; missing historical payloads cannot be reconstructed.

Pipeline capture stores parsed request/response snapshots and bounded timestamped stream excerpts. It is not a lossless transport capture: raw upload bytes, framing, headers and every retry attempt are not preserved as a separate wire file. No existing optional errors-only raw-wire file feature exists. `CHAT_DEBUG_FILE=true`, or `APP_LOG_LEVEL=debug`, bypasses the final artifact size limit and pretty-prints the already bounded object; it neither restores earlier truncation nor scopes capture to errors. Keep both disabled for this profile.

API-key `noLog` and payload/video protection remain enforced. Header masking remains in place, but prompts, tool outputs, native signatures and stream excerpts may still contain private content. Artifacts are JSON files under `DATA_DIR/call_logs`, not the encrypted functional conversation-state store. Keep access and retention controlled. Error/telemetry fallback is the appropriate route for diagnosing large failed histories without promising full payload retention.

## Validation and closure

The configurable pipeline logger has regression coverage for larger and smaller string/key caps, unchanged defaults, zero-key semantics, tiny-cap marker bounds, idempotence, binary elision and secret-header masking. Before using this profile, validate a synthetic large-history failure against the exact compiled image: confirm bounded structured error and telemetry survive, inspect the truncation markers, and verify `noLog=true` still prevents payload persistence. Record the profile interval, request IDs, artifact sizes and restored values. Production activation requires explicit user approval.

## Private Antigravity overflow

An independent, default-off private capture can preserve eligible request payloads beyond the 10 MiB dashboard artifact. Its candidate-only profile is:

```dotenv
OMNI_DIAGNOSTIC_OVERFLOW_ENABLED=true
OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES=3000000
OMNI_DIAGNOSTIC_OVERFLOW_FILE_BYTES=67108864
OMNI_DIAGNOSTIC_OVERFLOW_TOTAL_BYTES=1610612736
OMNI_DIAGNOSTIC_OVERFLOW_RETENTION_MS=21600000
```

It requires enabled pipeline logging, an inference key without `noLog`, and no video-retention redaction. Original client data is **parsed JSON reserialized before translation**, not original HTTP framing or whitespace. Each Antigravity generation send, including regional, credits and project-header403 retries, receives a separate file for the exact serialized outgoing body and the bytes read from its transport response. OAuth enrollment/refresh exchanges are not captured, and secret authorization/cookie headers are discarded. Approved payload contents can still contain private data. Full private payloads never enter console logs or enumerable request properties.

Files are private gzip records with byte counts and integrity hashes. The limit is 64 MiB raw per file. This temporary profile allows 1.5 GiB of coordinated storage and six-hour retention; the code defaults remain 2 GiB and seven days. This budget is separate from primary artifacts. Actual retries can create several files and artifacts per logical request; both stores enforce their own bounds. The original client JSON snapshot and provider serialization briefly occupy memory only for requests above `OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES` (default 4 MiB; this profile sets 3,000,000 bytes), so the request admission budget and container memory limit remain authoritative. Below that estimate, bounded call-log artifacts remain the capture path and no private overflow files are written. Set the threshold to `0` only when every eligible request needs private overflow capture.

For a 3.05 MiB incident-shaped request, 70–100 simultaneous client bodies represent about 214–305 MiB of input. A conservative in-flight estimate using four payload-sized stages (client, translated provider request, response and call-log detail) with the current 8× amplification assumption is about 6.7–9.5 GiB; this is a sizing envelope, not a measured 70/100-request load result. Private raw-byte budget is about 235–336 MiB for client-request files alone, or 671–959 MiB when provider request and response files are similarly sized. These are pre-gzip reservation estimates; compressed files can be smaller. Each physical retry adds another provider request/response pair. The code sets the 4 MiB default at `open-sse/utils/diagnosticCaptureContext.ts:20-27`, creates request/response writers per send at `open-sse/executors/antigravity/diagnosticAttempt.ts:166-180`, and records raw-byte reservations in `src/lib/usage/diagnosticOverflowCoordinator.ts:162-181,191-205`. The four payload stages follow the client/request/response logging path in `open-sse/handlers/chatCore.ts:1354-1356,5774-5780` and `open-sse/handlers/chatCore/attemptLogging.ts:479-529`.

A file is complete only after actual read EOF and gzip flush/durability. Cancellation, timeout, remaining logical deadline, read/write failure, unsupported consumers and exhausted file/storage budgets seal an explicit incomplete prefix. The small primary artifact retains only a validated trace-ID reference, including after size-limit compaction; manager-authenticated inspection resolves the current private manifest. Capture completion means byte retention completed, not that an HTTP400/403/429 generation succeeded.

Opted-in error disposal drains the existing owned reader under caller cancellation, the remaining logical budget and at most30 seconds, stopping when capture cannot accept more bytes. The parser still retains only its original256 KiB prefix; no second reader or logging tee is added, and no extra upstream request occurs. Default-off behavior is unchanged. Successful streams are read only as requested by their consumer; early terminal cancellation is incomplete rather than a claim that wire EOF was seen. Capture I/O has its own retirement ownership, so a generation cannot be retired while gzip/fsync work remains.

The observed body-reader path and `text`, `json` and `arrayBuffer` use one captured reader. Caller-requested `clone`, `blob` or `formData` retain their ordinary behavior but mark capture unsupported/incomplete; they are not silently presented as full retention. Ordinary dashboard string/array/depth bounds remain independent preview limits. Private capture does not promise payloads beyond its explicit limits, reconstruct missing older logs, or constitute TLS/HTTP packet capture.
