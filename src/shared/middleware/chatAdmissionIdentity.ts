import {
  isTrustedReasoningCacheContext,
  type ReasoningCacheContext,
} from "@omniroute/open-sse/services/reasoningCacheContext.ts";
import {
  SELF_HOP_HEADER,
  isOwnListenerSelfHop,
  isOwnListenerApiUrl,
  ownListenerSelfHopToken,
} from "@omniroute/open-sse/utils/selfHop.ts";

export const ADMISSION_BYPASS_HEADER = "x-omniroute-admission-bypass";

/** Only a server-validated credential gets a distinct fairness lane. */
export function resolveAuthenticatedAdmissionLane(principal: unknown): string {
  return isTrustedReasoningCacheContext(principal) && principal.kind === "key"
    ? `key_${principal.fingerprint}`
    : "anonymous";
}

/** Pre-auth body admission shares one lane. Client headers never shard fairness. */
export function resolveSessionId(
  _request: Request,
  principal?: ReasoningCacheContext | null
): string {
  return resolveAuthenticatedAdmissionLane(principal);
}

/** Legacy bearer interface for trusted in-process callers, never normal API auth. */
export function resolveSelfLoopBearer(): string {
  return ownListenerSelfHopToken();
}

export function isInternalAdmissionBypass(request: Request): boolean {
  if (!isOwnListenerApiUrl(request.url)) return false;
  if (isOwnListenerSelfHop(request.headers.get(SELF_HOP_HEADER))) return true;
  if (request.headers.get(ADMISSION_BYPASS_HEADER)?.trim().toLowerCase() !== "internal") {
    return false;
  }
  const match = /^bearer\s+(\S+)$/i.exec((request.headers.get("authorization") || "").trim());
  return !!match && isOwnListenerSelfHop(match[1]);
}
