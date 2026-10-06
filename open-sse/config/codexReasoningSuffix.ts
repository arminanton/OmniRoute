export const CODEX_EFFORT_ORDER = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type CodexEffortLevel = (typeof CODEX_EFFORT_ORDER)[number];
export const GPT_5_6_MAX_ALIAS_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
]);
export const GPT_5_6_ULTRA_ALIAS_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
]);

export function splitCodexReasoningSuffix(model: unknown): {
  baseModel: string;
  effort: CodexEffortLevel | null;
} {
  const modelId = typeof model === "string" ? model : "";
  // New frontier families retain model identity while max/ultra select effort.
  // Intrinsic ids such as gpt-5.1-codex-max are deliberately not matched.
  const modern =
    /^(gpt-(?:[6-9]\d*|[1-9]\d+)(?:\.\d+)?-(?:sol|astra|luna|terra))(?:-(max|ultra)|\((max|ultra)\))$/.exec(
      modelId
    );
  if (modern) return { baseModel: modern[1], effort: (modern[2] ?? modern[3]) as CodexEffortLevel };

  const gpt56Match =
    /^(gpt-5\.6-(?:sol|terra|luna)|gpt-6-astra)(?:-(max|ultra)|\((max|ultra)\))$/.exec(modelId);
  if (gpt56Match) {
    const [, baseModel, hyphenEffort, parenthesizedEffort] = gpt56Match;
    const effort = hyphenEffort ?? parenthesizedEffort;
    const supportedModels = parenthesizedEffort
      ? GPT_5_6_MAX_ALIAS_MODELS
      : effort === "ultra"
        ? GPT_5_6_ULTRA_ALIAS_MODELS
        : GPT_5_6_MAX_ALIAS_MODELS;
    if (supportedModels.has(baseModel)) {
      return { baseModel, effort: effort as CodexEffortLevel };
    }
  }

  for (const effort of ["none", "low", "medium", "high", "xhigh"] as const) {
    if (modelId.endsWith(`-${effort}`)) {
      return { baseModel: modelId.slice(0, -`-${effort}`.length), effort };
    }
  }
  return { baseModel: modelId, effort: null };
}
