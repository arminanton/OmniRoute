import { getSharedConversationState, opaqueStateKey } from "./sharedConversationState.ts";
export interface RetainedContinuation {
  input: unknown[];
  output: unknown[];
}
export interface ContinuationRetentionPermission {
  loggingEnabled: boolean;
  noLog: boolean;
  videoRedacted: boolean;
  sourceReady: boolean;
  sourceTruncated: boolean;
  sourceExpiresAt?: number;
}
const scope = (principal: string, model: string) =>
  opaqueStateKey(JSON.stringify(["retained-plain-history", principal, model]));

/** Never migrate account-bound opaque reasoning or signatures as ordinary transferable history. */
function containsOpaqueOrTruncated(value: unknown, depth = 0): boolean {
  if (depth > 30) return true;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsOpaqueOrTruncated(item, depth + 1));
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        "encrypted_content",
        "thoughtSignature",
        "thought_signature",
        "signature",
        "_omniroute_truncated",
        "_omniroute_truncated_array",
        "_truncated",
      ].includes(key) &&
      item
    )
      return true;
    if (containsOpaqueOrTruncated(item, depth + 1)) return true;
  }
  return false;
}
export function retainSharedResponseContinuation(
  responseId: string,
  principal: string,
  logicalModel: string,
  state: RetainedContinuation,
  permission: ContinuationRetentionPermission
): boolean {
  if (
    !responseId ||
    !principal ||
    !logicalModel ||
    permission.loggingEnabled !== true ||
    permission.noLog !== false ||
    permission.videoRedacted !== false ||
    permission.sourceReady !== true ||
    permission.sourceTruncated !== false ||
    !Array.isArray(state.input) ||
    !Array.isArray(state.output) ||
    !state.output.length ||
    containsOpaqueOrTruncated(state)
  )
    return false;
  const shared = getSharedConversationState();
  if (!shared) return false;
  const ttl =
    permission.sourceExpiresAt === undefined
      ? 3600000
      : Math.min(3600000, permission.sourceExpiresAt - Date.now());
  if (!Number.isFinite(ttl) || ttl <= 0) return false;
  return shared.put(
    "retained_continuation",
    responseId,
    scope(principal, logicalModel),
    state,
    ttl
  );
}
export function resolveSharedResponseContinuation(
  responseId: string,
  principal: string,
  logicalModel: string
): RetainedContinuation | null {
  if (!responseId || !principal || !logicalModel) return null;
  return (
    getSharedConversationState()?.get<RetainedContinuation>(
      "retained_continuation",
      responseId,
      scope(principal, logicalModel)
    ) ?? null
  );
}
