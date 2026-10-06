import { createConversationScope } from "./scope.ts";
import { conversationScopeKey } from "../../../src/lib/db/sharedConversationState.ts";

export function withProviderSignatureScope<
  T extends {
    connectionId?: unknown;
    accessToken?: unknown;
    apiKey?: unknown;
    _signatureNamespace?: unknown;
  },
>(provider: string, credentials: T, principal: unknown, conversation: unknown, model: unknown): T {
  const scope = createConversationScope(provider, credentials, principal, conversation, model);
  return scope
    ? { ...credentials, _signatureNamespace: "gs2:" + conversationScopeKey(scope) }
    : credentials;
}
