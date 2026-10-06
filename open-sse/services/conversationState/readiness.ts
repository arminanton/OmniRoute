import { statSync } from "node:fs";
import { SQLITE_FILE, getDbInstance } from "../../../src/lib/db/core.ts";
import { rememberCodexResponseId, getCodexResponseIdOwnership } from "./codexResponseOwnership.ts";
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
  producerGeneration: string;
  scope: ConversationScope;
  token: string;
  signature: string;
  signatureKey: string;
  responseId: string;
  nonce: string;
  expiresAt: number;
}
let sealed: { identity: string; peerGeneration: string } | null = null;
function storeIdentity() {
  const shared = getSharedConversationState();
  if (!shared || !SQLITE_FILE) return null;
  const st = statSync(SQLITE_FILE, { bigint: true });
  return opaqueStateKey(
    JSON.stringify([
      shared.readinessIdentity(),
      String(st.dev),
      String(st.ino),
      getDbInstance().prepare("PRAGMA schema_version").get(),
    ])
  );
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
    producerGeneration: process.env.OMNIROUTE_APP_GENERATION || "",
    scope,
    token: randomUUID(),
    signature: `synthetic-not-vendor-signature:${randomUUID()}`,
    signatureKey: `gs2:${conversationScopeKey({ ...scope, provider: "antigravity" })}:tool-proof`,
    responseId: `resp_probe_${id}`,
    nonce: randomUUID(),
    expiresAt: Date.now() + 60000,
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
    !rememberCodexResponseId(scope, data.responseId) ||
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
    getCodexResponseIdOwnership(data.scope, data.responseId) !== "owned" ||
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
      producerGeneration: data.producerGeneration,
      consumerGeneration: process.env.OMNIROUTE_APP_GENERATION || "",
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
  peerGeneration?: string;
  handoffFresh?: boolean;
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
      producerGeneration: string;
      consumerGeneration: string;
      nonce: string;
      signatures: boolean;
      exactTokens: boolean;
      retainedContinuations: boolean;
      scopedAffinity: boolean;
    }>("handoff_witness", id, opaqueStateKey(id));
    const handoffFresh =
      !!original &&
      !!proof &&
      proof.producer === shared.instance &&
      proof.consumer !== shared.instance &&
      proof.producerGeneration === (process.env.OMNIROUTE_APP_GENERATION || "") &&
      !!proof.consumerGeneration &&
      proof.consumerGeneration !== proof.producerGeneration &&
      proof.nonce === original.nonce &&
      proof.signatures &&
      proof.exactTokens &&
      proof.retainedContinuations &&
      proof.scopedAffinity &&
      getSessionAccountAffinity("canary:" + id, "codex", 60000)?.connectionId ===
        "consumer:" + proof.consumer &&
      getUnsharedCodexStatePinCount() === 0;
    const identity = storeIdentity();
    if (handoffFresh && identity) sealed = { identity, peerGeneration: proof!.consumerGeneration };
    const functional =
      !!original &&
      getGeminiThoughtSignature(original.signatureKey) === original.signature &&
      canEchoCodexStateToken(original.scope, original.token) &&
      getCodexResponseIdOwnership(original.scope, original.responseId) === "owned" &&
      resolveSharedResponseContinuation(
        original.responseId,
        original.scope.principal,
        original.scope.model
      )?.output.length === 1 &&
      resolveSharedConversationAffinity(original.scope) === original.scope.account;
    const ready =
      !!sealed &&
      sealed.identity === identity &&
      functional &&
      getUnsharedCodexStatePinCount() === 0;
    return {
      ready,
      challengeId: id,
      handoffFresh,
      ...(ready ? { peerGeneration: sealed!.peerGeneration } : {}),
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

/** Nonsecret binding for the authenticated immutable-generation controller. */
export function getConversationStateChallengeBinding(
  id: string
): { producerGeneration: string; expiresAt: number } | null {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  const data = getSharedConversationState()?.get<Challenge>(
    "handoff_challenge",
    id,
    opaqueStateKey(id)
  );
  if (!data || !data.producerGeneration || data.expiresAt <= Date.now()) return null;
  return { producerGeneration: data.producerGeneration, expiresAt: data.expiresAt };
}
