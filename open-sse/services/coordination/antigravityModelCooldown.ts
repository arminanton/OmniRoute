import { createHash } from "node:crypto";
import { resolveProviderId } from "@/shared/constants/providers";

/** Short bridge while the route records the authoritative provider cooldown. */
export const ANTIGRAVITY_MODEL_COOLDOWN_BRIDGE_MS = 5_000;

export type AntigravityModelCooldownKeyKind = "pending" | "active";

/**
 * Cross-worker key for one Antigravity connection/model pair. Hashing keeps account IDs and
 * model strings out of the coordination database while ensuring aliases share one key.
 */
export function buildAntigravityModelCooldownKey(
  connectionId: string | null | undefined,
  model: string | null | undefined,
  kind: AntigravityModelCooldownKeyKind
): string | null {
  const account = typeof connectionId === "string" ? connectionId.trim() : "";
  const canonicalModel = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (!account || !canonicalModel) return null;
  const canonicalProvider = resolveProviderId("antigravity");
  const digest = createHash("sha256")
    .update(JSON.stringify([canonicalProvider, account, canonicalModel]))
    .digest("hex");
  return `cooldown:${kind}:v1:${digest}`;
}
