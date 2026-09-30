const CALL_LOG_ATTEMPT_SEPARATOR = "::attempt::";

/** Stable per-dispatch lookup alias; each save receives a separate physical row ID. */
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

/** Recover the local pending/group ID from a dispatch alias, not from a physical save ID. */
export function getCallLogLogicalRequestId(lookupId: string): string {
  const separator = lookupId.indexOf(CALL_LOG_ATTEMPT_SEPARATOR);
  return separator < 0 ? lookupId : lookupId.slice(0, separator);
}
