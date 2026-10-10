/**
 * In-process marker for a response produced after local DNS/connect/proxy paths
 * were exhausted. It is deliberately not an HTTP header: callers must not be
 * able to forge it and internal routing state must not leak on the wire.
 */
const EXHAUSTED_NETWORK_RESPONSE = Symbol.for("omniroute.response.exhausted-local-network");
const acceptedTaskTimeoutResponses = new WeakSet<Response>();
const unsafeToReplayResponses = new WeakSet<Response>();

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

/** Mark an externally visible 504 whose accepted remote task reached its local deadline. */
export function markAcceptedTaskTimeoutResponse<T extends Response>(response: T): T {
  acceptedTaskTimeoutResponses.add(response);
  return response;
}

/** A direct Response input needs only a boolean result, avoiding false-branch narrowing to never. */
export function isAcceptedTaskTimeoutResponse(response: Response): boolean;
/** Narrow unknown values when checking a response at a heterogeneous dispatch boundary. */
export function isAcceptedTaskTimeoutResponse(response: unknown): response is Response;
/** True only for a locally marked timeout after a remote task was accepted. */
export function isAcceptedTaskTimeoutResponse(response: unknown): boolean {
  return response instanceof Response && acceptedTaskTimeoutResponses.has(response);
}

/** Mark a response after dispatch may have been accepted or local safety ended the attempt. */
export function markUnsafeToReplayResponse<T extends Response>(response: T): T {
  unsafeToReplayResponses.add(response);
  return response;
}

/** True only for an internally marked response that must not be automatically replayed. */
export function isUnsafeToReplayResponse(response: unknown): boolean {
  return response instanceof Response && unsafeToReplayResponses.has(response);
}
