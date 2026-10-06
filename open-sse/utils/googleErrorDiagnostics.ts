import { containsSensitiveErrorCredential, sanitizeErrorMessage } from "./errorSanitization.ts";

const TYPES = "type.googleapis.com/google.rpc.";
const STATUSES = new Set([
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
]);
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown, max = 128): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > max ||
    containsSensitiveErrorCredential(value) ||
    !/^[A-Za-z0-9_.:/ -]+$/.test(value)
  )
    return undefined;
  return value;
}
function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = text(source[key]);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** Bounded Google RPC evidence, never caller payloads, consumer/project identity or arbitrary Any data. */
export function projectGoogleError(value: unknown): Record<string, unknown> | undefined {
  const source = record(value);
  if (
    !source ||
    typeof source.status !== "string" ||
    !STATUSES.has(source.status) ||
    !Number.isInteger(source.code) ||
    typeof source.code !== "number" ||
    source.code < 0 ||
    source.code > 599
  )
    return undefined;
  const result: Record<string, unknown> = { code: source.code, status: source.status };
  if (typeof source.message === "string")
    result.message = sanitizeErrorMessage(source.message.slice(0, 4096)).slice(0, 768);
  const details: Record<string, unknown>[] = [],
    seen = new Set<string>();
  const entries = Array.isArray(source.details) ? source.details : [];
  for (const entry of entries.slice(0, 16)) {
    const item = record(entry);
    if (!item || typeof item["@type"] !== "string") continue;
    const type = item["@type"];
    if (seen.has(type)) continue;
    const projected: Record<string, unknown> = { "@type": type };
    if (type === `${TYPES}RetryInfo`) {
      if (typeof item.retryDelay === "string" && /^\d{1,10}(?:\.\d{1,9})?s$/.test(item.retryDelay))
        projected.retryDelay = item.retryDelay;
    } else if (type === `${TYPES}ErrorInfo`) {
      Object.assign(projected, pick(item, ["reason"]));
      if (
        typeof item.domain === "string" &&
        /^(?:[a-z0-9-]+\.)*googleapis\.com$/.test(item.domain) &&
        item.domain.length <= 128
      )
        projected.domain = item.domain;
      projected.metadata = pick(record(item.metadata) ?? {}, [
        "service",
        "quota_metric",
        "quota_limit",
        "quota_id",
        "quota_limit_value",
        "quota_value",
        "quota_location",
        "quota_unit",
        "model",
        "location",
      ]);
    } else if (type === `${TYPES}QuotaFailure`) {
      const violations = Array.isArray(item.violations) ? item.violations : [];
      projected.violations = violations.slice(0, 3).map((value) => {
        const violation = record(value) ?? {};
        const safe: Record<string, unknown> = pick(violation, [
          "apiService",
          "quotaMetric",
          "quotaId",
          "quotaValue",
          "futureQuotaValue",
        ]);
        if (typeof violation.description === "string")
          safe.description = sanitizeErrorMessage(violation.description.slice(0, 1024)).slice(
            0,
            256
          );
        safe.quotaDimensions = pick(record(violation.quotaDimensions) ?? {}, [
          "model",
          "location",
          "region",
        ]);
        return safe;
      });
      const priorOmitted =
        typeof item.omittedViolations === "number" &&
        Number.isSafeInteger(item.omittedViolations) &&
        item.omittedViolations >= 0
          ? item.omittedViolations
          : 0;
      if (violations.length > 3 || priorOmitted)
        projected.omittedViolations = Math.max(0, violations.length - 3) + priorOmitted;
    } else continue;
    seen.add(type);
    details.push(projected);
  }
  if (details.length) result.details = details;
  const priorOmitted =
    typeof source.omittedDetails === "number" &&
    Number.isSafeInteger(source.omittedDetails) &&
    source.omittedDetails >= 0
      ? source.omittedDetails
      : 0;
  if (entries.length > details.length || priorOmitted)
    result.omittedDetails = entries.length - details.length + priorOmitted;
  // Prefer losing excess violations over losing the quota category entirely.
  const quota = details.find((detail) => detail["@type"] === `${TYPES}QuotaFailure`);
  const violations = quota?.violations as Record<string, unknown>[] | undefined;
  while (Buffer.byteLength(JSON.stringify(result)) > 4096 && violations && violations.length > 1) {
    violations.pop();
    if (quota) quota.omittedViolations = Number(quota.omittedViolations ?? 0) + 1;
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 4096) {
    if (typeof result.message === "string") result.message = result.message.slice(0, 192);
    for (const violation of violations ?? []) {
      if (typeof violation.description === "string")
        violation.description = violation.description.slice(0, 64);
    }
  }
  // Defense in depth: every retained value is bounded, but never exceed the cap.
  while (Buffer.byteLength(JSON.stringify(result)) > 4096 && details.length) {
    details.pop();
    result.omittedDetails = entries.length - details.length + priorOmitted;
  }
  return result;
}

/** Error response headers only: no credentials, cookies, body metadata or arbitrary vendor headers. */
export function projectErrorHeaders(
  source: Headers | Record<string, unknown>
): Record<string, string> {
  const entries = source instanceof Headers ? [...source.entries()] : Object.entries(source);
  const allowed = new Set([
    "retry-after",
    "x-request-id",
    "x-goog-request-id",
    "x-google-request-id",
    "x-google-gfe-request-trace",
    "x-cloud-trace-context",
    "traceparent",
    "x-guploader-uploadid",
    "x-codex-primary-used-percent",
    "x-codex-secondary-used-percent",
    "x-codex-primary-reset-after-seconds",
    "x-codex-secondary-reset-after-seconds",
  ]);
  const result: Record<string, string> = {};
  for (const [name, value] of entries) {
    const lower = name.toLowerCase();
    if (
      allowed.has(lower) &&
      typeof value === "string" &&
      value.length <= 256 &&
      !/[\r\n\x00-\x1f]/.test(value) &&
      !containsSensitiveErrorCredential(value)
    )
      result[lower] = sanitizeErrorMessage(value).slice(0, 256);
  }
  return result;
}
