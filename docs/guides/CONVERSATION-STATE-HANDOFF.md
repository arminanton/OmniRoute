---
title: Scoped encrypted conversation state and handoff proof
---

The candidate introduces `omni-conversation-state/v1` tables on the same shared
POSIX coordination SQLite volume. Overlap state requires `OMNI_SHARED_ADMISSION`
and `OMNI_COORDINATION_DB`, plus configured field encryption. Encryption failure
never falls back to plaintext. Authenticated ciphertext binds record kind, key,
scope and expiry; copied ciphertext cannot be reassigned to another scope.
Records are bounded to 512 KiB, 5000 entries and at most 2 hours.

Codex request scopes bind the authenticated API principal, native child thread or
conversation, provider, model, selected connection and actual credential generation.
Trusted scopes are frozen objects tracked in a process-global WeakSet; JSON-shaped
credentials/provider metadata do not mint ownership. Owner getters rebind current
credentials, allowing deliberate account/auth/model changes to invalidate reuse.
The returned turn token is recorded only at final returned streaming headers,
using actual outbound authorization when available. Discarded nonstream attempts
no longer create delivery proof, and headers not forwarded are not invented.
Concurrent exact tokens coexist instead of overwriting a session's last account.
Unknown token echoes are stripped, and stale credential-carried echoes are cleared.

`getCodexConversationOwnerKey(credentials, actualModel?)` and
`getCodexConversationOwner(...)` expose private ownership for the native socket
pool. `rememberCodexResponseId(scope,id)` retains only receipt metadata;
`getCodexResponseIdOwnership(...)` distinguishes owned, foreign and unknown IDs.
Unknown legacy/external IDs are not asserted owned. The caller must choose an
explicit recovery/passthrough policy; the registry does not replay a request.

Gemini opaque signatures are encrypted at rest. In overlap mode, every read uses
the shared authority, so another process's overwrite/clear cannot be hidden by a
stale local cache. Shared keys require versioned principal/conversation/model/
account/auth-generation namespaces. Stable Antigravity session IDs remain separate
from changing signature namespaces. Legacy unbound opaque state is not claimed as
transferable proof. Non-overlap persistence also requires encryption; without a
key, the local request may use bounded RAM but no plaintext signature is written.

Ordinary Responses continuation history may migrate only from an already-published,
ready, authorized, untruncated log artifact. No larger original history is captured.
The bridge honors current noLog, video-redaction, retained source expiry and model
ownership. Canonical/preferred provider prefixes normalize to the same model route.
Opaque account-bound reasoning/signature items are rejected as plain transferable
history. Unsupported/noLog/truncated history requires the caller to resend full
history rather than silently retaining private payloads. Functional copies have a
short TTL and do not extend the source's configured time retention.

Pins have owner-checked claim/renew/release and expire; another process cannot steal
an active pin. `getConversationStatePins()` returns unknown when authority is
unavailable. Runtime integration must register actual ephemeral/nontransferable
state pins; a ready database alone does not make a socket baseline transferable.

Readiness exports:

- `getConversationStateReadiness()` returns ready, challengeId and an honest reason.
- `createConversationStateHandoffChallenge()` issues a short-lived synthetic probe.
- `completeConversationStateHandoffChallenge(id)` requires a distinct process to
  decrypt/read signatures, exact token receipts, retained tool-call history and
  affinity, then writes a witness. It cannot attest itself.
- `pinConversationState`, `releaseConversationStatePin`, and
  `getConversationStatePinOwner` expose retirement ownership.

The producer also checks a peer mutation through the actual main-DB affinity DAO;
a one-way copied snapshot cannot satisfy the roundtrip. Controllers must complete
fresh challenges before promotion. Existing code lacking this protocol, differing
keys/volumes, or untransferable state must remain unsupported until migration is
proven. Synthetic probes test functional storage, not vendor entitlements or live
provider success, and contain no user prompts or vendor-minted signatures.

Child-process regressions cover encrypted handoff, wrong keys, all ownership
boundaries, concurrent exact tokens, signature invalidation, response-ID receipts,
pin fencing, current noLog, opaque/truncated rejection and actual published-artifact
tool-turn reconstruction. Production readiness/counter/API and socket-pool wiring
are coordinated separately; this candidate does not deploy or change live state.

The paired readiness endpoint now accepts management-authenticated POST with
exactly `generation` and `peerChallengeId`. It completes real peer reads rather
than accepting supplied booleans or URLs. GET exposes nonsecret challenge/protocol,
expiry, peer generation and handoff freshness. The installed controller performs
both directions inside policy-bound immutable container namespaces before collecting
normal old/candidate proofs. Older generations without this API require approved
bootstrap; failure does not switch or fence traffic.

A successful witness can seal operational capability only for the current process,
shared-file identity, schema, encryption key and generation. Live functional reads
still run. Changing identity or losing data invalidates readiness. Fresh overlap
approval remains short-lived and is re-exchanged before cutover; retiring the peer
does not falsely make a healthy survivor depend on a dead process every minute.
The probe also verifies exact native response-ID ownership metadata.

Antigravity resolves the actual project before signature lookup and translation. Stored account
projects take precedence unless `OMNIROUTE_ALLOW_BODY_PROJECT_OVERRIDE=1` is enabled; an allowed
client override updates only cloned request credentials. Missing projects use the existing bounded
bootstrap and persist only its authenticated discovery. Signature namespaces include that resolved
project, while the stable conversation session ID is unchanged. The bootstrap manual-project sentinel
is never sent as a project ID. Parallel requests for different projects cannot retrieve each other's
cached signatures, and correctly supplied native signatures retain their existing validation behavior.

Authenticated routing constraints also apply inside Core account recovery. An explicit request
connection or operator combo pin stops inner Codex/Antigravity account rotation. Unpinned recovery
keeps the effective API-key/combo/quota allowlist and rejects an out-of-scope candidate. These are
internal dispatch inputs; request-body metadata cannot supply or broaden them.
