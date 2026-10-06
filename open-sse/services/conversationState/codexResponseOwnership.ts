import {
  conversationScopeKey,
  getSharedConversationState,
  opaqueStateKey,
  type ConversationScope,
} from "../../../src/lib/db/sharedConversationState.ts";
const receipts = new Map<string, { scope: string; expires: number }[]>();

/** Functional metadata only: no input, output, prompts or reasoning are persisted. */
export function rememberCodexResponseId(
  scope: ConversationScope,
  responseId: string,
  now = Date.now()
): boolean {
  if (!responseId || responseId.length > 512) return false;
  const owner = conversationScopeKey(scope);
  const id = opaqueStateKey(responseId);
  const entries = (receipts.get(id) || []).filter(
    (row) => row.expires > now && row.scope !== owner
  );
  entries.push({ scope: owner, expires: now + 3600000 });
  receipts.set(id, entries);
  while (receipts.size > 5000) receipts.delete(receipts.keys().next().value!);
  try {
    const shared = getSharedConversationState();
    return shared
      ? shared.put("codex_response_id", responseId, owner, { delivered: true }, 3600000)
      : true;
  } catch {
    return false;
  }
}
export function getCodexResponseIdOwnership(
  scope: ConversationScope | null | undefined,
  responseId: string,
  now = Date.now()
): "owned" | "foreign" | "unknown" {
  if (!scope || !responseId || responseId.length > 512) return "unknown";
  const owner = conversationScopeKey(scope);
  try {
    const shared = getSharedConversationState();
    if (shared) {
      if (shared.get<{ delivered: boolean }>("codex_response_id", responseId, owner)?.delivered)
        return "owned";
      return shared.knownScopes("codex_response_id", responseId).length ? "foreign" : "unknown";
    }
  } catch {
    return "unknown";
  }
  const entries = (receipts.get(opaqueStateKey(responseId)) || []).filter(
    (row) => row.expires > now
  );
  return entries.some((row) => row.scope === owner)
    ? "owned"
    : entries.length
      ? "foreign"
      : "unknown";
}
