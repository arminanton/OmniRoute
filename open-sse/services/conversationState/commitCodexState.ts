import { createConversationScope } from "./scope.ts";
import { rememberCodexStateToken } from "./codexTokenProvenance.ts";
import { readCodexTurnStateHeader } from "../../config/codexTurnState.ts";

/** Call only on the final response headers actually returned, never on a discarded attempt. */
export function commitCodexStateDelivery(
  provider: unknown,
  headers: Headers | Record<string, unknown>,
  credentials: {
    connectionId?: unknown;
    accessToken?: unknown;
    apiKey?: unknown;
  },
  principal: unknown,
  conversation: unknown,
  model: unknown,
  outboundHeaders?: Record<string, unknown>
): boolean {
  if (provider !== "codex") return false;
  const token = readCodexTurnStateHeader(headers);
  let effective = credentials;
  if (outboundHeaders) {
    const auth = Object.entries(outboundHeaders).find(
      ([name, value]) => name.toLowerCase() === "authorization" && typeof value === "string"
    )?.[1];
    if (typeof auth !== "string" || !/^Bearer\s+\S/.test(auth)) return false;
    effective = { ...credentials, accessToken: auth.replace(/^Bearer\s+/, "") };
  }
  const scope = createConversationScope("codex", effective, principal, conversation, model);
  return !!token && !!scope && rememberCodexStateToken(scope, token);
}
