---
title: "Relay Backend Strategy"
version: 3.8.51
lastUpdated: 2026-10-08
---

# Relay Backend Strategy

## Summary

OmniRoute currently exposes two relay endpoints and three backend-selection modes:

- `POST /api/v1/relay/chat/completions` runs the TypeScript relay handler and can select the Bifrost hop for eligible providers.
- `POST /api/v1/relay/chat/completions/bifrost` is a separate sidecar route.
- `OMNIROUTE_RELAY_BACKEND=ts|bifrost|auto` controls the first route; it does not switch the main `/api/v1/chat/completions` handler to Bifrost.

No controlled benchmark in this repository establishes that Bifrost/Go is faster, smaller, or more reliable than the current TypeScript path or a Rust implementation. Treat vendor numbers and historical comments as hypotheses until measured under the same workload and limits.

## Mode behavior

- `ts`
  - Lowest operational complexity.
  - All routing and validation runs in Node.
  - No sidecar dependency for availability.
- `bifrost`
  - Force all requests through the sidecar gateway.
  - No automatic fallback.
  - Use only for an explicit comparison or workload where its behavior and capacity have been verified.
- `auto`
  - The TypeScript handler uses the sidecar only when configured, enabled, and eligible for the requested provider.
  - The handler can fall back to TypeScript after sidecar failures; inspect response headers and telemetry to confirm which path handled a request.

## 9router vs CLIPROXYAPI today

9router and CLIPROXYAPI are both integrations that historically exposed compatibility paths for upstream providers.

- 9router is an embedded path for upstream orchestration and compatibility behavior.
- CLIPROXYAPI is a proxy API bridge for CLI / SDK style traffic.
- Bifrost is the existing Go sidecar implementation and a useful comparator; its latency and memory impact must be measured locally.

If you are currently comparing 9router/CLIPROXYAPI:

- Keep request signing, allowlist checks, and DB policy gates in the API route before handoff.
- `OMNIROUTE_RELAY_BACKEND=bifrost` forces the current relay endpoint through the sidecar.
- `OMNIROUTE_RELAY_BACKEND=auto` uses the sidecar only for eligible providers and reports its fallback decision.

## Backend boundary contract

The stable product boundary is the OmniRoute relay API, not the dashboard implementation. The Next.js dashboard may install, configure, and supervise local services, but request routing should enter through the relay API and hand off behind that boundary.

Long-term architecture under evaluation:

- Keep the Next.js dashboard and control plane for provider credentials, model catalogs, policies, quotas, account routing, usage, conversations, and administration.
- Evaluate a separate Rust inference/data plane first. Its candidate responsibilities are request admission, cached policy/config snapshots, provider selection, protocol translation, streaming, cancellation, backpressure, and bounded usage events.
- Keep TypeScript as the current compatibility path until Rust passes endpoint, security, streaming, tool-call, cancellation, accounting, and fallback parity checks.
- Keep Bifrost/Go as a measured comparison, not the assumed performance winner. Compare it against Rust and the current Node path using identical builds, payloads, provider mocks, connection counts, CPU/memory limits, and warm/cold states.
- Keep 9router and CLIPROXYAPI as compatibility adapters where their provider or CLI behavior is required; do not place them in the default request path without measurements.
- Do not make the dashboard pass arbitrary service URLs into the hot path. Resolve registered, health-checked backends from server-side settings and versioned configuration snapshots.
- Keep UI/control-plane deployments logically separate from inference while retaining explicit configuration refresh, revocation, and cache-expiry rules. Each inference request should not require a synchronous dashboard call.

Do not make Bifrost the high-throughput default based on unverified claims. Select a production backend only after controlled benchmarks and parity tests show its actual trade-offs.

## High-throughput guidance

For the 70–100 concurrent-agent target, measure active streams and long-lived requests separately from requests per second. Include realistic large prompts, tool rounds, retries, account limits, and provider 429 behavior.

1. Compare current Node, Bun with Next/Turbopack, and a minimal Rust streaming proxy under the same request corpus.
2. Record p50/p95/p99 first-byte and completion latency, success rate, CPU, RSS, heap, external buffers, cgroup usage, bytes per active request, and cancellation cleanup.
3. Use a mock upstream first to isolate gateway overhead; test real providers separately because their quotas and queues dominate latency.
4. Keep authentication, allowlists, policy checks, and revocation behavior identical across candidates.
5. Exercise 1, 15, 30, 70, and 100 concurrent sessions and verify bounded queueing, clean backpressure, retry limits, and recovery after 429/5xx.

## Suggested baseline

Use the current `ts` path as the correctness baseline. Enable Bifrost only in isolated comparisons until a same-workload benchmark establishes its trade-offs. Preserve API-key checks, allowlists, sanitization, quotas, and request cancellation on every candidate path.

## Provider plugin contract

Sidecars should import provider metadata through the JSON-safe provider plugin
manifest instead of depending on TypeScript executor internals. See
[Provider Plugin Manifest](./PROVIDER_PLUGIN_MANIFEST.md) for the sidecar
eligibility contract and migration phases.
