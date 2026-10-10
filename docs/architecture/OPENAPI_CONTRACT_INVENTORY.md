---
title: "OpenAPI Response and Security Declaration Inventory"
version: 3.8.51
---

# OpenAPI response and security declaration inventory

Generated from `docs/openapi.yaml` by `npm run report:openapi-contract-inventory`. This is a static declaration inventory; it does not prove runtime behavior or schema semantic completeness.

- Paths: 705
- Operations: 1029
- Body-bearing success-response candidates: 979
- Candidates with a schema on every declared non-204 2xx response: 979 (100.00%)
- Candidates with at least one missing/untyped non-204 2xx response: 0
- Bodyless 204-only operations: 18
- HEAD operations: 8 (2 declare success statuses; 6 have no declared 2xx)
- Operations with no declared 2xx response: 30

The candidate denominator excludes HEAD/OPTIONS, operations whose only success is 204, and operations with no declared 2xx. Each candidate must describe a schema for every declared non-204 2xx status. Local component response `$ref`s are resolved; a content entry without a `schema` is counted as untyped. The full operation/status gap list is available from `node scripts/check/openapi-contract-inventory.mjs --json`.

## Classified non-candidate responses

| Classification                  | Operations |
| ------------------------------- | ---------: |
| 204-only                        |         18 |
| catch-all-error-response        |         10 |
| cors-options                    |          0 |
| error-only-or-no-success-status |          5 |
| head-no-success-status          |          6 |
| head-success-bodyless           |          2 |
| not-modified-only               |          0 |
| redirect-only                   |          8 |
| websocket-upgrade               |          1 |

## Response-content gap states

| Missing response-content state | Status occurrences |
| ------------------------------ | -----------------: |
| content-without-schema         |                  0 |
| no-content                     |                  0 |
| unresolved-response            |                  0 |

## Security declarations

- Operation-level declarations: 960
- Inherited declarations: path=0, root=0
- Missing effective declarations: 69
- Invalid declarations: 0
- Explicitly public (security: []): 17
- Nonempty declarations requiring a named scheme: 156
- Nonempty declarations including an anonymous empty-object alternative: 787
- Conditional-auth language detected in operation text: 430
- Conditional-auth language with an effective security declaration: 430
- Conditional-auth language with no effective security declaration: 0

A missing security declaration is reported as undocumented, not presumed public. The conditional-auth detector is a review aid based on operation text, not an authorization evaluator. Complete missing-declaration candidates are included in the command's `--json` output.

### Conditional-auth text with no effective security declaration

| Method | Path | operationId |
| ------ | ---- | ----------- |
| (none) |      |             |
