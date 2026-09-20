# UC authentication and model integration audit

Generated: `2026-09-20T13:54:32.826362+00:00`  
JSON evidence: `UC-AUTH-MODEL-INTEGRATION-AUDIT.json`  
JSON SHA-256: `ffbc2f4f2b1beabc5e741264ae8a7e050ff9b73ff070d6c4bb63db4126a490c6`

## Verdict

The reconciled UC provider code **did reach** `local`, `next`, the running image, and the sibling integration candidate. Live source matches `next` for the audited UC registry, catalog, UI, and login files.

However, the usable portal/login integration is incomplete. This explains the observed API-key UI.

## What is correct now

- UC Persona registry is canonical `uc-persona`, aliases `uc` and `ucn`.
- UC Persona executor declares `authType: none` and never needs a Developer API key.
- The browserless Clerk email-code implementation exists in `open-sse/executors/uc/emailLogin.ts` and has offline unit tests.
- Live/static Persona catalog exposes 19 models.
- UC Direct is correctly separate and metered, using `X-API-Key`, and has no configured connection. However, it is still registered/routing-capable; policy-disabled/ineligible is not yet enforced by an explicit negative gate.
- Live contains the same relevant source as `next` and the pending sibling candidate.

## Blocking gaps

1. **No UC production login dispatch.** `POST /api/providers/[id]/login` has a MaxAI request/verify handler but no equivalent `uc-persona`/`uc` handler. `requestUcEmailCode` and `verifyUcEmailCode` are only used by tests.
2. **No UC email-code portal modal.** The provider page chooses OAuth only for OAuth/free groups. Every web-cookie provider is projected as `toggleAuthType: apikey`, so UC Persona falls into `AddApiKeyModal`.
3. **Canonical credential mapping mismatch.** `WEB_SESSION_CREDENTIAL_REQUIREMENTS` is keyed by legacy `uc`, not canonical `uc-persona`.
4. **Generic connection creation hardcodes `authType: apikey`.** The current persisted UC row therefore reports API-key auth even though its providerSpecificData contains correct Clerk credentials.
5. **Personal Gmail helper is retrieval-only.** `~/_/omnirouter/bin/auto-email-login.py` can ask Codex/Gmail for an OTP, but it does not request the email, call a UC verify route, persist the credentials, or integrate into the portal.
6. **UC Direct policy needs enforcement.** Zero configured UC Direct connections is not enough; onboarding, credentials, routing, fallback, and media dispatch must fail closed by policy.
7. **Existing row needs migration.** The active database row is provider `uc`, auth type `apikey`, with required Clerk fields present. It needs an idempotent transactional migration to canonical Persona identity/auth semantics.

## Model state

Live, `local`, `next`, `reconcile/uc-maxai-20260910`, and `integrate/codex-ready` carry the same 19 static Persona IDs. This is usable as the reviewed static core after auth wiring. Historical web evidence observed the upstream Persona roster grow 22 → 27 → 32, including GLM 5.2, GPT 5.6 Sol Pro, Grok 4.5, Fable, Gemini 3.6/3.7 Flash, and Kimi K3 variants. Those later IDs are not in the static 19 and are not capability-proven. Optional metadata-only discovery/quarantine remains future work; do not auto-route discovered models.

## Required next-release slice

- Add an offline-tested `UcPersonaEmailLoginModal` with `request` and `verify` steps.
- Dispatch `uc-persona`, `uc`, and `ucn` in `/api/providers/[id]/login` to `requestUcEmailCode` / `verifyUcEmailCode` and persist `clientCookie`, `sid`, `uid`, and cookie jar.
- Add canonical `uc-persona` web-session requirement or make requirement lookup alias-aware.
- Create Persona connections with correct non-API-key semantics.
- Migrate the existing legacy row transactionally and idempotently.
- Keep UC Direct unchanged as API-key only and policy-disabled/ineligible unless explicitly enabled later.
- Keep all tests offline with mocked Clerk/Gmail; no authenticated provider is required.
- Personal Codex/Gmail automation stays host-local in `local-overrides`, not upstream product code. It should automate OTP retrieval only after the portal/backend flow exists.

## Coordination

Session `01a0bdc5-1711-75d2-85ee-3f495ecabce0` (`omni-models`) reports no UC changes yet and no deployment planned. It was asked to incorporate this exact slice before its candidate deploy.
