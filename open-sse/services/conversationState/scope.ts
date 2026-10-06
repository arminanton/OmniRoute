import { createHash } from "node:crypto";
import type { ConversationScope } from "../../../src/lib/db/sharedConversationState.ts";
const TRUSTED_SCOPE_REGISTRY = Symbol.for("omniroute.conversation-state.trusted-scopes/v1");
const scopeGlobal = globalThis as typeof globalThis & {
  [TRUSTED_SCOPE_REGISTRY]?: WeakSet<object>;
};
const trusted = (scopeGlobal[TRUSTED_SCOPE_REGISTRY] ||= new WeakSet<object>());
export function isTrustedConversationScope(value: unknown): value is ConversationScope {
  return !!value && typeof value === "object" && trusted.has(value);
}
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Only trusted executor credentials and authenticated principal metadata mint state scopes. */
export function createConversationScope(
  provider: string,
  credentials: {
    connectionId?: unknown;
    accessToken?: unknown;
    apiKey?: unknown;
    providerSpecificData?: unknown;
    projectId?: unknown;
    workspaceId?: unknown;
    accountId?: unknown;
  },
  principal: unknown,
  conversation: unknown,
  model: unknown
): ConversationScope | null {
  const actor = text(principal),
    thread = text(conversation),
    account = text(credentials.connectionId),
    modelId = text(model);
  const credential = text(credentials.accessToken) ?? text(credentials.apiKey);
  if (!actor || !thread || !account || !modelId || !credential) return null;
  const data =
    credentials.providerSpecificData && typeof credentials.providerSpecificData === "object"
      ? (credentials.providerSpecificData as Record<string, unknown>)
      : {};
  const realm = [
    text(credentials.workspaceId) ?? text(data.workspaceId),
    text(credentials.accountId) ?? text(data.accountId),
    text(credentials.projectId) ?? text(data.projectId),
  ];
  const authGeneration = createHash("sha256")
    .update(realm.some(Boolean) ? JSON.stringify([credential, ...realm]) : credential)
    .digest("hex");
  const scope = {
    principal: actor,
    conversation: thread,
    provider,
    model: modelId,
    account,
    authGeneration,
  };
  trusted.add(scope);
  return Object.freeze(scope);
}
