import { classifyUpstreamPolicyRejection } from "@omniroute/open-sse/services/upstreamPolicyRejection.ts";
import { isExhaustedNetworkFailure, isProxyFetchExhaustedFailure } from "./networkFailure";
import {
  getGenerationDispatchPhase,
  isUncertainGenerationAcceptance,
} from "@omniroute/open-sse/services/generationDispatchEvidence.ts";

/**
 * One same-account retry is permitted only with positive local evidence that the
 * generation failed in the transport queue before request start. Provider5xx,
 * upstream text, and accepted-stream EOF never establish safe replay.
 */

export const SAME_ACCOUNT_TRANSPORT_RETRY_MAX = 1;
export const SAME_ACCOUNT_TRANSPORT_RETRY_MIN_DELAY_MS = 2000;
export const SAME_ACCOUNT_TRANSPORT_RETRY_JITTER_MS = 1000;

const RETRYABLE_TRANSPORT_STATUSES = new Set([502, 503, 504, 507]);

const NON_RETRYABLE_ERROR_TYPES = new Set([
  "lease_error",
  "account_semaphore_capacity",
  "logical_retry_budget",
  "upstream_acceptance_uncertain",
  "local_stream_buffer_limit",
]);

export function isRetryableTransportStatus(status: unknown): boolean {
  const numeric = Number(status);
  return Number.isFinite(numeric) && RETRYABLE_TRANSPORT_STATUSES.has(numeric);
}

export function isRetryablePreOutputTransportError(
  status: unknown,
  errorText: string | null | undefined,
  errorCode?: string | null,
  errorType?: string | null,
  localTransportError?: unknown
): boolean {
  if (errorType && NON_RETRYABLE_ERROR_TYPES.has(errorType)) return false;
  if (errorCode && String(errorCode).startsWith("LEASE_")) return false;
  // proxyFetch already exhausted its fresh-dispatcher and native fallback paths.
  // Repeating the whole chat pipeline would only redo parsing and compression.
  if (
    isProxyFetchExhaustedFailure(errorCode) ||
    isExhaustedNetworkFailure(errorCode, errorText, localTransportError) ||
    isUncertainGenerationAcceptance(localTransportError)
  )
    return false;

  const text = String(errorText || "");
  if (classifyUpstreamPolicyRejection({ message: text, code: errorCode, type: errorType }))
    return false;
  const numericStatus = Number(status);
  if (numericStatus === 429 || numericStatus === 401 || numericStatus === 400) return false;
  if (/quota (threshold|exhausted)|credits exhausted/i.test(text)) return false;
  if (/invalid_request|prompt is too long|context.?length|unsupported model/i.test(text)) {
    return false;
  }

  const dispatch = getGenerationDispatchPhase(localTransportError);
  return (
    isRetryableTransportStatus(status) &&
    dispatch?.phase === "transport_queue" &&
    dispatch.requestStarted === false
  );
}

export function sameAccountTransportRetryDelayMs(random: () => number = Math.random): number {
  const draw = random();
  const unit = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0;
  return Math.round(
    SAME_ACCOUNT_TRANSPORT_RETRY_MIN_DELAY_MS + SAME_ACCOUNT_TRANSPORT_RETRY_JITTER_MS * unit
  );
}

export function shouldRetrySameAccountTransport(options: {
  status: unknown;
  errorText?: string | null;
  errorCode?: string | null;
  errorType?: string | null;
  attempt: number;
  hasForcedConnection?: boolean;
  hasEmittedOutput?: boolean;
  originalError?: unknown;
}): boolean {
  if (options.hasForcedConnection) return false;
  if (options.hasEmittedOutput) return false;
  if (options.attempt >= SAME_ACCOUNT_TRANSPORT_RETRY_MAX) return false;
  return isRetryablePreOutputTransportError(
    options.status,
    options.errorText,
    options.errorCode,
    options.errorType,
    options.originalError
  );
}

export function isTransportCooldownErrorCode(errorCode: unknown): boolean {
  return isRetryableTransportStatus(errorCode);
}

export function buildMixedAvailabilityError(options: {
  provider: string;
  quotaFilteredCount: number;
  transportUnavailableCount: number;
  transportStatus?: number | null;
}): { status: number; lastError: string; lastErrorCode: number } {
  const quota = Math.max(0, options.quotaFilteredCount);
  const transport = Math.max(0, options.transportUnavailableCount);
  const upstreamStatus = options.transportStatus || 503;
  return {
    status: 503,
    lastErrorCode: 503,
    lastError: `No ${options.provider} accounts currently available: ${quota} quota-filtered, ${transport} temporarily unavailable after upstream ${upstreamStatus}`,
  };
}
