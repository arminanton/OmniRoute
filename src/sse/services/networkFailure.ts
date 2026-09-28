/** Stable classification for network failures that were already retried by proxyFetch. */
import { isVerifiedProxyFetchExhaustedError } from "@omniroute/open-sse/utils/proxyFetch.ts";

// Network-looking provider codes and messages are untrusted. They can guide
// ordinary retry policy, but cannot prove final local transport exhaustion.
/** Legacy code-only retry-policy hint. Not a local-origin proof. */
export function isProxyFetchExhaustedFailure(errorCode: unknown): boolean {
  return (
    errorCode === "proxy_unreachable" ||
    errorCode === "PROXY_UNREACHABLE" ||
    errorCode === "EAI_AGAIN" ||
    errorCode === "ENOTFOUND"
  );
}

/** Only an in-process proxyFetch final-site brand proves local exhaustion.
 * Never infer this from upstream JSON codes, response text, or persisted rows. */
export function isExhaustedNetworkFailure(
  _errorCode: unknown,
  _errorText?: unknown,
  localTransportError?: unknown
): boolean {
  return isVerifiedProxyFetchExhaustedError(localTransportError);
}
