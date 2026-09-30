/**
 * Local media failure values and response provenance only.
 * No URL/DNS/transport/DB/env/policy-loading calls. The imported domain
 * predicates are pure; they neither admit a destination nor grant authority.
 */
import { isRuntimePolicyError, isRuntimePolicyResponse } from "@/shared/runtimePolicy";
import { isExhaustedNetworkResponse } from "@omniroute/open-sse/services/exhaustedNetworkResponse.ts";

// Shared across HMR/duplicate module instances; JSON/provider errors cannot carry this symbol.
const REMOTE_MEDIA_FAILURE = Symbol.for("omniroute.remote-media-fetch-failure");

/** Local boundary failure, never an account/provider error or fallback invitation. */
export class RemoteMediaFetchError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    return (
      !!value &&
      typeof value === "object" &&
      (value as { [REMOTE_MEDIA_FAILURE]?: boolean })[REMOTE_MEDIA_FAILURE] === true
    );
  }
  readonly status: number;
  readonly retryable = false;
  constructor(cause: unknown, status?: number) {
    super(cause instanceof Error ? cause.message : "Remote media download failed", { cause });
    Object.defineProperty(this, REMOTE_MEDIA_FAILURE, { value: true });
    this.name = "RemoteMediaFetchError";
    const causeName = cause instanceof Error ? cause.name : "";
    this.status =
      status ?? (causeName === "AbortError" ? 499 : causeName === "TimeoutError" ? 504 : 400);
  }
}

// Keep terminal provenance through handler result conversion. JSON/provider
// responses cannot mint this symbol; public error text and status stay ordinary.
const REMOTE_MEDIA_RESULT_FAILURE = Symbol.for("omniroute.remote-media-result-failure");

export interface RemoteMediaFailureResult {
  success: false;
  status: number;
  error: string;
  retryable: false;
}

export function createRemoteMediaFailureResult(
  error: unknown,
  signal?: AbortSignal | null
): RemoteMediaFailureResult {
  if (!(error instanceof RemoteMediaFetchError) && !signal?.aborted) {
    throw new TypeError("Expected a local remote-media boundary failure");
  }
  const result: RemoteMediaFailureResult = {
    success: false,
    status: signal?.aborted ? 499 : (error as RemoteMediaFetchError).status,
    error: "Remote image could not be loaded",
    retryable: false,
  };
  Object.defineProperty(result, REMOTE_MEDIA_RESULT_FAILURE, { value: true });
  return result;
}

export function isRemoteMediaFailureResult(value: unknown): value is RemoteMediaFailureResult {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { [REMOTE_MEDIA_RESULT_FAILURE]?: boolean })[REMOTE_MEDIA_RESULT_FAILURE] === true
  );
}

// A local media failure is not a runtime-policy or exhausted-network response.
const REMOTE_MEDIA_RESPONSE_FAILURE = Symbol.for("omniroute.remote-media-response-failure");
const REMOTE_MEDIA_RESPONSE_DETAILS = Symbol.for("omniroute.remote-media-response-details");
const abortSignalAbortedGetter =
  typeof AbortSignal === "undefined"
    ? undefined
    : Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function isActuallyAborted(signal: unknown): boolean {
  if (!abortSignalAbortedGetter || signal == null) return false;
  try {
    return Reflect.apply(abortSignalAbortedGetter, signal, []) === true;
  } catch {
    return false;
  }
}

export interface RemoteMediaFailureResponseDetails {
  readonly status: number;
  readonly message: string;
  readonly code: string;
}

type MediaFailureResponse = Response & {
  readonly [REMOTE_MEDIA_RESPONSE_FAILURE]: true;
  readonly [REMOTE_MEDIA_RESPONSE_DETAILS]: Readonly<RemoteMediaFailureResponseDetails>;
};

function markMediaResponse<T extends Response>(
  response: T,
  details: Readonly<RemoteMediaFailureResponseDetails>
): T {
  Object.defineProperties(response, {
    [REMOTE_MEDIA_RESPONSE_FAILURE]: { value: true },
    [REMOTE_MEDIA_RESPONSE_DETAILS]: { value: details },
  });
  return response;
}

/**
 * Stamp an already sanitized, locally produced error response. UC supplies the
 * same sanitized message/code used in its JSON body. No response body is read,
 * cloned, buffered or replaced here; public status/text alone is not provenance.
 * Producers must preserve policy first. This repeats that identity guard so a
 * known, single media wrapper cannot hide an actual local policy error.
 */
export function createRemoteMediaFailureResponse<T extends Response>(
  response: T,
  error: unknown,
  signal?: AbortSignal | null,
  details?: Readonly<Pick<RemoteMediaFailureResponseDetails, "message" | "code">>
): T {
  if (isRuntimePolicyError(error)) throw error;
  if (error instanceof RemoteMediaFetchError && isRuntimePolicyError(error.cause)) {
    throw error.cause;
  }
  const cancelled = isActuallyAborted(signal);
  if (!(error instanceof RemoteMediaFetchError) && !cancelled) {
    throw new TypeError("Expected a local remote-media boundary failure");
  }
  if (
    !(response instanceof Response) ||
    response.status < 400 ||
    isRuntimePolicyResponse(response) ||
    isExhaustedNetworkResponse(response)
  ) {
    throw new TypeError("Expected an unclassified local media error response");
  }
  if (
    details !== undefined &&
    (typeof details?.message !== "string" || typeof details?.code !== "string")
  ) {
    throw new TypeError("Expected sanitized local media response details");
  }
  const stored = Object.freeze({
    status: response.status,
    message: details?.message ?? "Remote media request failed.",
    code: details?.code ?? "REMOTE_MEDIA_FETCH_FAILED",
  });
  return markMediaResponse(response, stored);
}

/** Only locally stamped Response objects have this non-wire carrier. */
export function isRemoteMediaFailureResponse(value: unknown): value is MediaFailureResponse {
  if (!(value instanceof Response)) return false;
  const response = value as Partial<MediaFailureResponse>;
  const details = response[REMOTE_MEDIA_RESPONSE_DETAILS];
  return (
    response[REMOTE_MEDIA_RESPONSE_FAILURE] === true &&
    !!details &&
    Object.isFrozen(details) &&
    details.status === value.status &&
    typeof details.message === "string" &&
    typeof details.code === "string"
  );
}

/** Internal projection only. Never infer these fields from provider JSON. */
export function getRemoteMediaFailureResponseDetails(
  response: Response
): Readonly<RemoteMediaFailureResponseDetails> {
  if (!isRemoteMediaFailureResponse(response)) {
    throw new TypeError("Expected a local media failure response");
  }
  return response[REMOTE_MEDIA_RESPONSE_DETAILS];
}

/**
 * Trusted header-only replacement. Reuse the same body stream; do not tee it.
 * Ordinary Response.clone()/JSON/spread do not transfer local provenance.
 */
export function cloneRemoteMediaFailureResponse(
  response: Response,
  headers: HeadersInit = response.headers
): Response {
  const details = getRemoteMediaFailureResponseDetails(response);
  const cloned = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  return markMediaResponse(cloned, details);
}
