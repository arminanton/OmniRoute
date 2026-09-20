/** Stable classification for network failures that were already retried by proxyFetch. */

const NETWORK_FAILURE_CODES = new Set([
  "proxy_unreachable",
  "PROXY_UNREACHABLE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const NETWORK_FAILURE_TEXT =
  /proxy_unreachable|PROXY_UNREACHABLE|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET/i;

/** True when proxyFetch has attached its stable exhausted-path classification. */
export function isProxyFetchExhaustedFailure(errorCode: unknown): boolean {
  return (
    errorCode === "proxy_unreachable" ||
    errorCode === "PROXY_UNREACHABLE" ||
    errorCode === "EAI_AGAIN" ||
    errorCode === "ENOTFOUND"
  );
}

/**
 * Return true only for transport failures that never reached the provider.
 * proxyFetch has already retried these on a fresh dispatcher and native fallback,
 * so a chat-layer retry would repeat parsing and compression without adding a new path.
 */
export function isExhaustedNetworkFailure(errorCode: unknown, errorText?: unknown): boolean {
  if (typeof errorCode === "string" && NETWORK_FAILURE_CODES.has(errorCode)) return true;
  return typeof errorText === "string" && NETWORK_FAILURE_TEXT.test(errorText);
}
