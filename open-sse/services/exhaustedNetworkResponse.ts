/**
 * In-process marker for a response produced after local DNS/connect/proxy paths
 * were exhausted. It is deliberately not an HTTP header: callers must not be
 * able to forge it and internal routing state must not leak on the wire.
 */
const EXHAUSTED_NETWORK_RESPONSE = Symbol.for("omniroute.response.exhausted-local-network");

type MarkedResponse = Response & {
  readonly [EXHAUSTED_NETWORK_RESPONSE]: true;
};

/** Mark the final JSON or SSE failure Response without reading or replacing its body. */
export function markExhaustedNetworkResponse<T extends Response>(response: T): T & MarkedResponse {
  Object.defineProperty(response, EXHAUSTED_NETWORK_RESPONSE, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return response as T & MarkedResponse;
}

/** True only for an internally marked exhausted-local-network Response. */
export function isExhaustedNetworkResponse(response: unknown): response is MarkedResponse {
  return (
    response instanceof Response &&
    (response as MarkedResponse)[EXHAUSTED_NETWORK_RESPONSE] === true
  );
}
