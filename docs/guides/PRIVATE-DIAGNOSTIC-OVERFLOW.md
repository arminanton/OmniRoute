---
title: "Private Diagnostic Overflow"
version: 3.8.51
lastUpdated: 2026-10-06
---

# Private diagnostic overflow inspection

Complete diagnostic payloads use a separate private gzip store. Normal call-log artifacts contain a bounded trace reference; they do not embed these files. Capture remains opt-in, and producer privacy settings determine whether a request can be captured.

The following management endpoints require authentication even when ordinary dashboard authentication is disabled. Scoped CLI access tokens require `admin`; management API keys and authenticated dashboard sessions retain their existing management permissions. Localhost alone grants no access. Tokens in query parameters do not authenticate these routes.

| GET endpoint                                                    | Result                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| `/api/usage/diagnostic-overflow?limit=50&before=<timestamp>`    | At most100 trace manifests; optional timestamp pagination |
| `/api/usage/diagnostic-overflow/<traceId>`                      | Trace metadata, attempts and capture completeness         |
| `/api/usage/diagnostic-overflow/<traceId>/<attemptId>/request`  | Exact provider request gzip attachment                    |
| `/api/usage/diagnostic-overflow/<traceId>/<attemptId>/response` | Exact provider response gzip attachment                   |
| `/api/usage/diagnostic-overflow/<traceId>/client-request`       | Original client request gzip attachment, when captured    |

Trace and attempt identifiers must be UUIDs. File kinds are fixed aliases; no endpoint accepts filesystem paths. Downloads use `application/gzip`, attachment disposition, `nosniff` and `private, no-store`. Authenticated HEAD requests return405 without opening payload files; inspect the manifest with GET for metadata.

An ongoing capture returns409 from its download endpoint while its manifest remains inspectible. Missing files return404; corrupt files return409. Sealed incomplete captures can be downloaded, but `X-Diagnostic-Capture-Complete: false` and manifest reasons explicitly identify missing bytes. A successful gzip download is not itself proof of a complete upstream payload. Client cancellation closes the owned download stream.

These files can contain original prompts, tool arguments and provider output. They remain private diagnostic data and are not added to public model catalogs or ordinary console output. Retention, per-file limits and aggregate storage limits are enforced by the private store; existing retained files remain inspectible when new capture is disabled.
