"use strict";

import { types as utilTypes } from "node:util";

const exhaustedProxyTransportErrors = new WeakSet();
const PROXY_NETWORK_ERROR_CODES = new Set([
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
  "ERR_HTTP2_STREAM_ERROR",
]);

function nativeFetchTransportCode(source) {
  try {
    if (!utilTypes.isNativeError(source) || !(source instanceof TypeError)) return undefined;
    const sourceError = /** @type {{ message?: unknown; cause?: unknown }} */ (source);
    if (sourceError.message !== "fetch failed") return undefined;
    const cause = sourceError.cause;
    if (!utilTypes.isNativeError(cause) || !(cause instanceof Error)) return undefined;
    const code = /** @type {{ code?: unknown }} */ (cause).code;
    return typeof code === "string" && PROXY_NETWORK_ERROR_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Internal: called only by proxyFetch for its final sanitized transport error. */
export function markProxyFetchExhaustedTransportError(error, source) {
  try {
    if (!error || typeof error !== "object" || !utilTypes.isNativeError(error)) return error;
    const causeCode = nativeFetchTransportCode(source);
    const proxyError = /** @type {{ code?: unknown; causeCode?: unknown }} */ (error);
    if (
      causeCode &&
      proxyError.code === "PROXY_REQUEST_FAILED" &&
      proxyError.causeCode === causeCode
    ) {
      exhaustedProxyTransportErrors.add(error);
    }
  } catch {
    // Malformed error properties fail closed.
  }
  return error;
}

/** Read-only identity check for proxyFetch-owned transport provenance. */
export function isProxyFetchExhaustedTransportError(value) {
  return value !== null && typeof value === "object" && exhaustedProxyTransportErrors.has(value);
}
