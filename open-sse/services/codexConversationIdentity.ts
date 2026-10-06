import { createHash } from "node:crypto";

type Credentials = { connectionId?: unknown; _codexConversationIdentity?: string };

/** Request-local fallback for SDK clients that do not send native thread headers. */
export function withCodexConversationIdentity<T extends Credentials>(
  provider: string | null | undefined,
  credentials: T,
  principal: unknown,
  conversation: unknown
): T {
  if (provider !== "codex" || typeof conversation !== "string" || !conversation.trim())
    return credentials;
  if (typeof credentials.connectionId !== "string" || !credentials.connectionId) return credentials;
  return {
    ...credentials,
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
