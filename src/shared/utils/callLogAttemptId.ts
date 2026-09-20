const CALL_LOG_ATTEMPT_SEPARATOR = "::attempt::";

/** Keep each physical attempt unique while retaining its logical request id as a lookup prefix. */
export function buildCallLogAttemptId(logicalRequestId: unknown, attemptId: unknown): string {
  return `${String(logicalRequestId)}${CALL_LOG_ATTEMPT_SEPARATOR}${String(attemptId)}`;
}

/** Escaped SQLite LIKE pattern used only when an exact logical-id lookup misses. */
export function buildCallLogAttemptLookupPattern(logicalRequestId: string): string {
  const escaped = logicalRequestId
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return `${escaped}${CALL_LOG_ATTEMPT_SEPARATOR}%`;
}
