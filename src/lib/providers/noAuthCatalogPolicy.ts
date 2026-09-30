/** Providers with a public, volatile chat catalog. Static-only no-auth providers stay unchanged. */
export function usesNoAuthLiveCatalog(providerId: string): boolean {
  return ["aihorde", "opencode", "uncloseai", "duckduckgo-web"].includes(providerId);
}

/** Imported rows are not explicit user additions, but can still overlay a live same-ID row. */
export function retainNoAuthCustomModel(
  model: { id: string; source?: string },
  liveModels: readonly { id: string }[]
): boolean {
  const source = typeof model.source === "string" ? model.source.trim().toLowerCase() : "manual";
  const imported = ["imported", "api-sync", "auto-sync", "synced", "auto"].includes(source);
  return !imported || liveModels.some((live) => live.id === model.id);
}
