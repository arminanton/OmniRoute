# UC Persona/Direct implementation handoff

Handoff time: `2026-09-20T14:24:13.679300+00:00`

Owner session:

- Session ID: `01a0bdc5-1711-75d2-85ee-3f495ecabce0`
- Session name: `omni-models`
- Worktree: `/home/ndsadmin/_/omnirouter/integration-codex-ready`
- Branch: `integrate/codex-ready`

Canonical audit:

- `UC-AUTH-MODEL-INTEGRATION-AUDIT.md`
- `UC-AUTH-MODEL-INTEGRATION-AUDIT.json`
- JSON SHA-256: `ffbc2f4f2b1beabc5e741264ae8a7e050ff9b73ff070d6c4bb63db4126a490c6`

Required implementation:

1. UC Persona email request/verify backend dispatch using existing `uc/emailLogin.ts`.
2. Dedicated Persona email-code UI instead of generic API-key modal.
3. Canonical/alias-aware web-session credential requirement.
4. Correct non-API-key connection creation semantics.
5. Transactional, idempotent migration of legacy `uc`/`apikey` row preserving Clerk credentials.
6. Static reviewed 19 Persona models usable in release.
7. Later observed 22/27/32 roster metadata quarantined; no automatic routing.
8. UC Direct explicit policy-disabled negative gates across onboarding, credentials, routing, fallback/auto-combo, and media.
9. Offline mocked tests; no provider calls.
10. Personal Codex/Gmail helper stays host-local.

This session made no source/runtime/database/provider change. Implementation, review, integration, and deployment ownership transferred to the target session.
