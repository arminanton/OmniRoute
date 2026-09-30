/** Classify inference actions, not Model Garden UI/access-management actions. */
export function getGoogleModelEndpoints(model: Record<string, unknown>, id: string): string[] {
  const methods = Array.isArray(model.supportedGenerationMethods)
    ? model.supportedGenerationMethods
    : Array.isArray(model.supportedActions)
      ? model.supportedActions
      : model.supportedActions && typeof model.supportedActions === "object"
        ? Object.keys(model.supportedActions)
        : [];
  const lower = id.toLowerCase();
  // Non-chat families take precedence over generic predict/generate actions.
  if (/(?:^|[-_/])(rerank|reranker)(?:[-_/@]|$)/.test(lower)) return ["rerank"];
  if (/(?:embedding|embed|text-embedding)/.test(lower)) return ["embeddings"];
  if (/(?:^|[-_/])(veo|video)(?:[-_/@]|$)/.test(lower)) return ["videos"];
  if (/(?:^|[-_/])(imagen|imagegeneration)(?:[-_/@]|$)/.test(lower)) return ["images"];
  const endpoints = new Set<string>();
  const map: Record<string, string> = {
    generateContent: "chat", generateAnswer: "chat", streamGenerateContent: "chat",
    rawPredict: "chat", streamRawPredict: "chat", chatCompletions: "chat",
    embedContent: "embeddings", batchEmbedContents: "embeddings",
    rerank: "rerank", predict: "images", predictLongRunning: "videos",
  };
  for (const method of methods) {
    if (typeof method === "string" && map[method]) endpoints.add(map[method]);
  }
  const modalities = [model.outputModalities, model.output_modalities]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.toLowerCase());
  if (modalities.includes("video")) return ["videos"];
  if (modalities.includes("image") && !modalities.includes("text")) return ["images"];
  if (modalities.includes("audio") && !modalities.includes("text")) return ["audio"];
  if (endpoints.size) return [...endpoints];
  // UI actions (viewRestApi, requestAccess) alone do not prove chat support.
  // Older Google/Claude listings omit inference methods, so retain known chat families.
  if (methods.length === 0 || methods.every((method) =>
    ["viewRestApi", "openGenerationAiStudio", "openGenie", "requestAccess"].includes(String(method)))) {
    if (/^(?:gemini-|gemma-|claude-)/.test(lower)) return ["chat"];
  }
  return [];
}
