import {
  conversationScopeKey,
  getSharedConversationState,
  opaqueStateKey,
  type ConversationScope,
} from "../../../src/lib/db/sharedConversationState.ts";
const local = new Map<string, { expires: number }>();
const localPins = new Map<string, number>();
const key = (scope: ConversationScope, token: string) =>
  `${conversationScopeKey(scope)}:${opaqueStateKey(token)}`;

/** Record exact delivered bytes, never merely the latest account for a thread. */
export function rememberCodexStateToken(
  scope: ConversationScope,
  token: string,
  now = Date.now()
): boolean {
  if (!token || token.length > 32768) return false;
  const scopeKey = conversationScopeKey(scope);
  local.set(key(scope, token), { expires: now + 2 * 3600000 });
  for (const [name, entry] of local) if (entry.expires <= now) local.delete(name);
  while (local.size > 5000) local.delete(local.keys().next().value!);
  try {
    const store = getSharedConversationState();
    if (store && !store.put("codex_token", token, scopeKey, { delivered: true }, 2 * 3600000))
      throw new Error("Scoped token not retained");
    localPins.delete(scopeKey);
    return true;
  } catch {
    localPins.set(scopeKey, now + 2 * 3600000);
    return false;
  }
}

export function canEchoCodexStateToken(
  scope: ConversationScope | null | undefined,
  token: string,
  now = Date.now()
): boolean {
  if (!scope || !token || token.length > 32768) return false;
  try {
    const store = getSharedConversationState();
    if (store)
      return (
        store.get<{ delivered: boolean }>("codex_token", token, conversationScopeKey(scope))
          ?.delivered === true
      );
  } catch {
    return false;
  }
  const entry = local.get(key(scope, token));
  if (!entry || entry.expires <= now) return false;
  return true;
}
export function getUnsharedCodexStatePinCount(now = Date.now()): number {
  for (const [scope, expires] of localPins) if (expires <= now) localPins.delete(scope);
  return localPins.size;
}
export function resetScopedCodexStateForTests() {
  local.clear();
  localPins.clear();
}
