# Gemini Web account-model fixture gate

`accountModels.ts` is offline-only. It does not select a model or prove served model identity.
The parser accepts bounded, length-framed `uqlm3e` responses with account status 1000.
Opaque IDs and display names are distinct. A label such as `Pro` does not identify a version.
No existing provider catalog, request route, or browser behavior changes here.

## Required sanitized fixtures before integration

Capture through an authorized browser session outside this offline task:

1. Account catalog: complete `uqlm3e` response envelope and decoded payload structure,
   including status at index 14, model records at index 15, and capability structure at
   index 16. Include ordinary available account and account with different entitlements.
   Preserve Unicode, frame lengths, nulls, arrays, numeric enums, and model ordering.
2. Selector binding: minimal DOM/accessibility snapshot before and after explicitly
   selecting an option. Preserve option's display name and any machine-readable model
   identifier. Record exact clicked option and whether UI persists selection. No whole
   page screenshot or conversation history. Label-only correspondence is insufficient.
3. Outbound selection: for each discovered option, capture only StreamGenerate pathname
   and `x-goog-ext-525001261-jspb` structure. Preserve index 4 (model ID) and index 12
   (capacity) correspondence. Replace trailing session identifier with a fixed marker.
   Record whether any request-body field changes with model selection; preserve only
   necessary structural differences, never prompt or conversation identifiers.
4. Result evidence: sanitized success/error frames for selected request, including
   1050/1052 if available. If response contains authoritative selected-model identity,
   preserve its field path and correlation. Without this, claim only requested ID sent,
   not served version verified. Use synthetic harmless prompts, not user content.
5. Provenance: capture date, browser version, UI language, anonymous account labels
   A/B and broad entitlement class, and fixture transformation notes. No emails or IDs.

## Redaction rules

Never save Cookie/Set-Cookie, Authorization, `at`/SNlM0e tokens, full HAR, browser
storage, URL query strings, `f.sid`, session/build bootstrap blobs, account identity,
conversation IDs, prompt/answer text, file URLs, signed URLs, or image data.
Use allowlisted fields above instead of logging then redacting an entire session.
Model IDs may be replaced consistently with synthetic IDs across catalog, DOM, and
request fixtures. Recalculate framing lengths after any substitutions. Preserve exact
array positions/types. Inspect fixture text manually before committing.

## Integration blocker

No sanitized browser fixture currently validates natural status-RPC availability,
selector-to-ID binding, or account capacity fields. Do not guess UI selectors/aliases,
construct selection headers from inferred tiers, or replace existing public catalogs.
Direct parser tests cannot establish browser behavior. AGPL study repository supplied
protocol observations only; helper and tests were independently authored.
