import { getSyncedAvailableModelsForConnection } from "@/lib/db/models";
import { CODEX_EFFORT_ORDER, type CodexEffortLevel } from "../../config/codexReasoningSuffix.ts";

/** Account-specific discovered limits outrank static fallback assumptions. */
export async function getDeclaredCodexMaxEffort(
  connectionId: unknown,
  model: string
): Promise<CodexEffortLevel | null> {
  if (typeof connectionId !== "string" || !connectionId) return null;
  try {
    const rows = await getSyncedAvailableModelsForConnection("codex", connectionId);
    const declared = rows.find((row) => row.id === model)?.supportedThinkingEfforts;
    if (!Array.isArray(declared) || declared.length === 0) return null;
    return [...CODEX_EFFORT_ORDER].reverse().find((effort) => declared.includes(effort)) ?? null;
  } catch {
    return null;
  }
}
