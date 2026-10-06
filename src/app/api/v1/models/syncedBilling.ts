/** Native request billing is separate from estimated USD-per-token prices. */
export function buildSyncedBilling(sm: { premiumRequestMultiplier?: number }) {
  const multiplier = sm.premiumRequestMultiplier;
  if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier < 0) return {};
  return {
    billing_metadata: {
      unit: "premium_requests",
      multiplier,
      source: "authenticated_provider_catalog",
      notes:
        "Request multiplier is not a USD/token rate or a promise of free usage; plan/initiator billing rules apply.",
    },
  };
}
