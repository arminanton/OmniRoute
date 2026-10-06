---
title: Catalog and paired Prime ledger implementation evidence
---

## Candidate behavior

This candidate is based on live commit `67503e560a`. It changes no installed
Prime extension, live container, service or deployment configuration, and does
not touch the separate local-next checkout.

Catalog cold-build timeout is a retryable HTTP 503 with `Retry-After: 2` instead
of an internal HTTP 500. Unexpected errors retain sanitized HTTP 500 behavior.
Cold concurrent callers still share a build, failed builds release admission
without unhandled rejection, and transient error responses are not cached.
Last-good fallback is invalidated with settings/entitlement state; an old-generation
completion cannot populate it. These are verified defects and regressions, not
proof that every observed production warm-up 500 had the same cause.

Generated Claude effort aliases inherit their verified base billing row only
when dispatch normalizes that alias. Exact operator variant rates take precedence,
including zero. Arbitrary suffix names do not inherit guessed prices. No duplicate
canonical routes are introduced by enrichment.

Copilot's authenticated discovery parser previously discarded native limits and
billing fields. The candidate retains validated limits, tool/vision/reasoning
flags, declared efforts, endpoint formats and numeric request multipliers through
normalization, persistence and the alias-only API. Native request multipliers are
not converted to dollar token prices. No global vendor price is copied to an
unproven provider billing route.

## Primary-source evidence and unresolved ceilings

| Route                      | Evidence                                                                                                                                              | Candidate treatment                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| AG Gemini 3.1 Flash Image  | [Gemini API model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image) publishes 32768 output for the Gemini API.               | Does not assert the Cloud Code wrapper has the same ceiling. Missing native wrapper ceiling remains explicit.                     |
| Gemini Web Flash-Lite      | [Gemini API model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite) publishes 65536 output for the Gemini API.                | Cookie/web generation is a different surface; no guessed web ceiling.                                                             |
| Codex Spark                | [Codex models](https://learn.chatgpt.com/docs/models) states ChatGPT retirement on 2026-09-14. The inspected account discovery has no output ceiling. | Public lifecycle notice is exposed, without blocking account-discovered or explicitly configured routes. No guessed output limit. |
| Codex Auto Review          | Inspected authenticated account discovery exposes no output ceiling.                                                                                  | Unknown remains unknown.                                                                                                          |
| UncloseAI Qwen3.8-27B-exl3 | No trustworthy deployment-specific output limit obtained. Quantization/serving names are not universal model limits.                                  | Unknown remains unknown.                                                                                                          |

The existing verified 872000 context budgets are preserved. Neither the CLI
fallback nor public API family information overwrites an account's established
larger context window. New Copilot data reflects the authenticated native catalog.

## Billing basis

[Current Codex pricing](https://learn.chatgpt.com/docs/pricing) distinguishes
included allowance from purchased credits. The candidate exposes separate
`billing_metadata` with standard credit rates and Fast metering of 2.5x included
allowance versus 2x purchased credits; Astra Ultrafast is 8x versus 6x. These are
billing multipliers, not speed promises or entitlement grants. Existing dollar
rows remain token-value estimates, not subscription invoices. No cache-write
credit charge is inferred, and no legacy agreement is converted without evidence.

Exact invoices, long-context adjustments and legacy account contracts still need
actual account/response evidence. Static combo pricing cannot represent the model
selected by a particular turn. The staged Prime artifact marks dynamic/unknown
costs visibly and exposes `/omni-billing`; it cannot change the numeric-cost
requirement of Prime's compiled SDK or invent an actual routed invoice.

## Verification and application gate

Focused regression coverage includes coalesced cold failure/retry, no cached error,
entitlement invalidation, alias inheritance/override, account lifecycle notices,
credit unit separation, native Copilot parsing and persisted authenticated API,
and both Prime endpoints with response-body timeout, failed startup, refresh
replacement, unknown/dynamic labels and single-flight refresh. Core typecheck passed.

The paired artifact lives in `integrations/prime-agent/omni/`. Host generation only
writes review artifacts and hashes. Installation/reload must be coordinated on
both Maria and devvm after approval, preserving active sessions. Fixture session
notifications are not a claim that all canonical-ID resumption and daemon reuse
races have been tested against the compiled Prime core.
