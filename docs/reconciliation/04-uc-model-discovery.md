# UC Persona model discovery

Full evidence: `../workers/uc-model-discovery.md`

## Current state

OmniRoute does not dynamically discover UC Persona models today.

Every inspected Persona implementation exposes the same 19 historically selected IDs. The live container exposes none because UC code is absent.

The retained UC web application uses a hybrid roster:

- server-delivered model IDs from authenticated `POST /get_backend_variables`
- bundled metadata for known IDs
- bundled fallback entries when the server omits them

Observed server roster growth:

| Observation | Persona IDs |
|---|---:|
| June | 22 |
| July | 27 |
| August | 32 |

Later additions included GLM 5.2, GPT 5.6 Sol Pro, Grok 4.5, Fable variants, Gemini 3.6/3.7 Flash, and Kimi K3 variants. Presence in the roster or analytics does not prove entitlement, WebSocket acceptance, context, vision, tools, or quality.

## Do not mix the three catalogs

| Surface | Catalog | IDs | Auth | Normal OmniRoute use |
|---|---|---|---|---|
| Persona / Emotional | `POST /get_backend_variables` | Persona wire IDs | Captured client application bearer | Manual Persona route |
| Subscription Web Direct | `/api/direct-models` | Full provider-prefixed IDs | Clerk JWT | Not the `uc-direct` provider and not a Persona allowlist |
| Developer `uc-direct` | Public `/api/v1/models` | REST short IDs; latest retained static set 82 | Catalog public; generation API key | Disabled/ineligible |

Neither Direct catalog may automatically broaden Persona.

## Historical Persona selection

The initial Persona scrape contained 21 candidate IDs. Empirical testing removed or remapped failures and added a separately cured model, producing the 19-ID static set that remains in OmniRoute.

That set is a historically selected fallback. It is not a current authoritative roster.

## Safe dynamic discovery design

Dynamic discovery is a recommended optional, non-gating follow-on. If selected, it should detect drift without automatically enabling models.

### Refresh contract

1. Explicit operator action or low-frequency metadata-only schedule; default automatic refresh off initially.
2. Exact allowlisted host and `/get_backend_variables` path.
3. Selected residential connector attested before dispatch.
4. Application bearer loaded from secret storage and never logged.
5. One bounded request; no inference WebSocket and no generation quota use.
6. Strict status, content type, response-byte, model-count, ID-length, and schema limits.
7. Redirect denial and no alternate-host fallback.
8. Last-known-good cache retained on any error or empty/suspicious response.

### Drift states

Every discovered ID is classified as:

- `known_enabled`
- `known_disabled`
- `new_quarantined`
- `missing_upstream`
- `metadata_changed`

New or changed IDs produce a review record. They do not become routable.

### Promotion requirements

Before a new Persona ID is enabled:

1. Preserve its exact wire ID; do not guess normalization.
2. Map display name and underlying model only from captured metadata.
3. Establish context/output limits without borrowing Direct values blindly.
4. Determine vision, tools, reasoning, attachments, and quota behavior.
5. Add offline fixtures.
6. Obtain explicit live-canary approval for one human-authored request if a provider call is necessary.
7. Promote through a reviewed allowlist change.

### Cache and rollback

- Separate Persona cache from both Direct caches.
- Persist raw response hash, normalized candidate hash, fetch time, connector attestation, and diff.
- Keep a static 19-ID fallback.
- Never replace a nonempty last-known-good cache with empty data.
- Allow immediate rollback to the previous approved allowlist.

## Optional G3-D implementation if selected

- Persona discovery client and bounded schema
- Secret-safe application-bearer injection
- Separate cache and drift table
- Quarantine/review workflow
- Multi-alias compatibility for `uc-persona`, `uc`, and `ucn`
- Catalog/readiness UI that distinguishes discovered from approved/routable
- Negative tests proving Direct IDs cannot leak into Persona
- Network-denied fixtures for every refresh result

## Operational recommendation

Do not poll the Persona roster on every request or startup. Use manual refresh first, then a conservative scheduled metadata refresh only after the connector, secret, caching, and drift controls are proven. A catalog change must never trigger automatic model probes.
