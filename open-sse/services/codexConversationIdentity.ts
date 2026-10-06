import { createConversationScope, isTrustedConversationScope } from "./conversationState/scope.ts";
import {
  conversationScopeKey,
  type ConversationScope,
} from "../../src/lib/db/sharedConversationState.ts";
import { createHash } from "node:crypto";

type Credentials = {
  connectionId?: unknown;
  accessToken?: unknown;
  apiKey?: unknown;
  providerSpecificData?: unknown;
  projectId?: unknown;
  workspaceId?: unknown;
  accountId?: unknown;
  _codexConversationIdentity?: string;
  _codexTurnStateScope?: ConversationScope | null;
};

/** Request-local fallback for SDK clients that do not send native thread headers. */
export function withCodexConversationIdentity<T extends Credentials>(
  provider: string | null | undefined,
  credentials: T,
  principal: unknown,
  conversation: unknown,
  model?: unknown
): T {
  if (provider !== "codex" || typeof conversation !== "string" || !conversation.trim())
    return credentials;
  if (typeof credentials.connectionId !== "string" || !credentials.connectionId) return credentials;
  const scope = createConversationScope("codex", credentials, principal, conversation, model);
  return {
    ...credentials,
    ...(scope ? { _codexTurnStateScope: scope } : {}),
    _codexConversationIdentity: createHash("sha256")
      .update(
        JSON.stringify([
          credentials.connectionId,
          typeof principal === "string" ? principal : "anonymous",
          conversation.trim(),
        ])
      )
      .digest("hex"),
  };
}

/** Scope-shaped client/PSD objects are never trusted; cloned credentials may retain the issued scope reference. */
export function getCodexConversationOwner(
  credentials: Credentials | null | undefined,
  actualModel?: string
): ConversationScope | null {
  if (!credentials || !isTrustedConversationScope(credentials._codexTurnStateScope)) return null;
  const scope = credentials._codexTurnStateScope;
  return createConversationScope(
    "codex",
    credentials,
    scope.principal,
    scope.conversation,
    actualModel || scope.model
  );
}
export function getCodexConversationOwnerKey(
  credentials: Credentials | null | undefined,
  actualModel?: string
): string | null {
  const scope = getCodexConversationOwner(credentials, actualModel);
  return scope ? conversationScopeKey(scope) : null;
}
