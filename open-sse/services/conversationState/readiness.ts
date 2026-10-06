import {
  upsertSessionAccountAffinity,
  getSessionAccountAffinity,
} from "../../../src/lib/db/sessionAccountAffinity.ts";
import { randomUUID } from "node:crypto";
import {
  getSharedConversationState,
  conversationScopeKey,
  opaqueStateKey,
  type ConversationScope,
} from "../../../src/lib/db/sharedConversationState.ts";
import {
  storeGeminiThoughtSignature,
  getGeminiThoughtSignature,
} from "../geminiThoughtSignatureStore.ts";
import {
  rememberCodexStateToken,
  canEchoCodexStateToken,
  getUnsharedCodexStatePinCount,
} from "./codexTokenProvenance.ts";
import {
  retainSharedResponseContinuation,
  resolveSharedResponseContinuation,
} from "../../../src/lib/db/sharedResponseContinuation.ts";
import {
  rememberSharedConversationAffinity,
  resolveSharedConversationAffinity,
} from "../../../src/lib/db/sharedAffinity.ts";
interface Challenge {
  producer: string;
  scope: ConversationScope;
  token: string;
  signature: string;
  signatureKey: string;
  responseId: string;
  nonce: string;
}
let issued: { id: string; expires: number } | null = null;

/** Export for an authenticated peer/controller. This never probes or calls a vendor. */
export function createConversationStateHandoffChallenge(): string | null {
  const shared = getSharedConversationState();
  if (!shared) return null;
  if (issued && issued.expires > Date.now()) return issued.id;
  const id = randomUUID();
  const scope: ConversationScope = {
    principal: `canary:${id}`,
    conversation: id,
    provider: "codex",
    model: "synthetic-proof-only",
    account: "canary",
    authGeneration: opaqueStateKey(id),
  };
  const data: Challenge = {
    producer: shared.instance,
    scope,
    token: randomUUID(),
    signature: `synthetic-not-vendor-signature:${randomUUID()}`,
    signatureKey: `gs2:${conversationScopeKey({ ...scope, provider: "antigravity" })}:tool-proof`,
    responseId: `resp_probe_${id}`,
    nonce: randomUUID(),
  };
  storeGeminiThoughtSignature(data.signatureKey, data.signature);
  upsertSessionAccountAffinity(
    "canary:" + id,
    "codex",
    "producer:" + shared.instance,
    Date.now(),
    60000
  );
  if (
    !rememberCodexStateToken(scope, data.token) ||
    !rememberSharedConversationAffinity(scope, scope.account)
  )
    return null;
  if (
    !retainSharedResponseContinuation(
      data.responseId,
      scope.principal,
      scope.model,
      {
        input: [{ role: "user", content: "synthetic readiness fixture" }],
        output: [{ type: "function_call", call_id: "proof-tool", name: "proof", arguments: "{}" }],
      },
      {
        loggingEnabled: true,
        noLog: false,
        videoRedacted: false,
        sourceReady: true,
        sourceTruncated: false,
      }
    )
  )
    return null;
  if (!shared.put("handoff_challenge", id, opaqueStateKey(id), data, 60000)) return null;
  issued = { id, expires: Date.now() + 60000 };
  return id;
}

/** Peer must independently decrypt/read all functional stores; producer cannot attest itself. */
export function completeConversationStateHandoffChallenge(id: string): boolean {
  const shared = getSharedConversationState();
  if (!shared) return false;
  const data = shared.get<Challenge>("handoff_challenge", id, opaqueStateKey(id));
  if (!data || data.producer === shared.instance) return false;
  if (
    getSessionAccountAffinity("canary:" + id, "codex", 60000)?.connectionId !==
    "producer:" + data.producer
  )
    return false;
  const continuation = resolveSharedResponseContinuation(
    data.responseId,
    data.scope.principal,
    data.scope.model
  );
  if (
    getGeminiThoughtSignature(data.signatureKey) !== data.signature ||
    !canEchoCodexStateToken(data.scope, data.token) ||
    resolveSharedConversationAffinity(data.scope) !== data.scope.account ||
    continuation?.output[0] === undefined
  )
    return false;
  upsertSessionAccountAffinity(
    "canary:" + id,
    "codex",
    "consumer:" + shared.instance,
    Date.now(),
    60000
  );
  return shared.put(
    "handoff_witness",
    id,
    opaqueStateKey(id),
    {
      producer: data.producer,
      consumer: shared.instance,
      nonce: data.nonce,
      signatures: true,
      exactTokens: true,
      retainedContinuations: true,
      scopedAffinity: true,
    },
    60000
  );
}
export function getConversationStateReadiness(): {
  ready: boolean;
  challengeId: string | null;
  reason?: string;
} {
  try {
    const shared = getSharedConversationState();
    if (!shared) return { ready: false, challengeId: null, reason: "shared_state_not_configured" };
    const id = createConversationStateHandoffChallenge();
    if (!id) return { ready: false, challengeId: null, reason: "functional_store_probe_failed" };
    const original = shared.get<Challenge>("handoff_challenge", id, opaqueStateKey(id));
    const proof = shared.get<{
      producer: string;
      consumer: string;
      nonce: string;
      signatures: boolean;
      exactTokens: boolean;
      retainedContinuations: boolean;
      scopedAffinity: boolean;
    }>("handoff_witness", id, opaqueStateKey(id));
    const ready =
      !!original &&
      !!proof &&
      proof.producer === shared.instance &&
      proof.consumer !== shared.instance &&
      proof.nonce === original.nonce &&
      proof.signatures &&
      proof.exactTokens &&
      proof.retainedContinuations &&
      proof.scopedAffinity &&
      getSessionAccountAffinity("canary:" + id, "codex", 60000)?.connectionId ===
        "consumer:" + proof.consumer &&
      getUnsharedCodexStatePinCount() === 0;
    return {
      ready,
      challengeId: id,
      ...(ready ? {} : { reason: "distinct_process_handoff_witness_required" }),
    };
  } catch {
    return { ready: false, challengeId: null, reason: "shared_state_unavailable_or_unencrypted" };
  }
}

export function getConversationStatePins(): number | null {
  try {
    const shared = getSharedConversationState();
    return shared ? shared.activePins() + getUnsharedCodexStatePinCount() : null;
  } catch {
    return null;
  }
}
export function pinConversationState(scopeKey: string, ttlMs?: number): boolean {
  const shared = getSharedConversationState();
  if (!shared) return false;
  return shared.pin(scopeKey, ttlMs);
}
export function releaseConversationStatePin(scopeKey: string) {
  getSharedConversationState()?.unpin(scopeKey);
}
export function getConversationStatePinOwner(scopeKey: string): string | null {
  return getSharedConversationState()?.pinOwner(scopeKey) ?? null;
}
