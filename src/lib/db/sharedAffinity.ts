import {
  getSharedConversationState,
  opaqueStateKey,
  conversationScopeKey,
  type ConversationScope,
} from "./sharedConversationState.ts";
export function rememberSharedConversationAffinity(
  scope: ConversationScope,
  connection: string,
  ttlMs = 300000
) {
  if (!connection || connection !== scope.account) return false;
  return (
    getSharedConversationState()?.put(
      "conversation_affinity",
      conversationScopeKey(scope),
      opaqueStateKey(
        JSON.stringify([
          scope.principal,
          scope.provider,
          scope.conversation,
          scope.model,
          scope.authGeneration,
        ])
      ),
      { connection },
      ttlMs
    ) ?? false
  );
}
export function resolveSharedConversationAffinity(scope: ConversationScope): string | null {
  const row = getSharedConversationState()?.get<{ connection: string }>(
    "conversation_affinity",
    conversationScopeKey(scope),
    opaqueStateKey(
      JSON.stringify([
        scope.principal,
        scope.provider,
        scope.conversation,
        scope.model,
        scope.authGeneration,
      ])
    )
  );
  return row?.connection === scope.account ? row.connection : null;
}
