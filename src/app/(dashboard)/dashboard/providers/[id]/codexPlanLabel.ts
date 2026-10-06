/**
 * Codex subscription plan label, persisted in providerSpecificData at OAuth
 * import time. Returns "" when the connection is not Codex or no value exists.
 *
 * Kept in its own module (not providerPageHelpers.ts) because that file is
 * frozen at its file-size ratchet cap (config/quality/file-size-baseline.json)
 * and this helper is fully self-contained.
 */
export function getCodexPlanLabel(isCodex: boolean, providerSpecificData: unknown): string {
  if (!isCodex) return "";
  const record =
    providerSpecificData && typeof providerSpecificData === "object"
      ? (providerSpecificData as Record<string, unknown>)
      : {};
  const raw =
    typeof record.chatgptPlanType === "string" && record.chatgptPlanType.trim()
      ? record.chatgptPlanType
      : record.workspacePlanType;
  if (typeof raw !== "string") return "";
  return raw.trim();
}
