/** Official CLI 1.2.13 / IDE 2.5.5 Cloud Code adaptive-Claude contract.
 * LOW/MEDIUM/HIGH are ThinkingConfig.ThinkingLevel enum names, not token budgets.
 * Eligibility must come from the selected account's authenticated ModelDetails.
 */
export const ANTIGRAVITY_CLAUDE_EFFORTS = ["low", "medium", "high"] as const;
export type AntigravityClaudeEffort = (typeof ANTIGRAVITY_CLAUDE_EFFORTS)[number];
const SELECTED_BASES = new Set(["claude-sonnet-4-6", "claude-opus-4-6-thinking"]);

export function splitAntigravityClaudeEffort(model: string): {
  baseModel: string; effort: AntigravityClaudeEffort | null;
} {
  const id = model.replace(/^(?:antigravity|agy)\//, "");
  for (const effort of ANTIGRAVITY_CLAUDE_EFFORTS) {
    const baseModel = id.endsWith(`-${effort}`) ? id.slice(0, -effort.length - 1) : "";
    if (SELECTED_BASES.has(baseModel)) return { baseModel, effort };
  }
  return { baseModel: id, effort: null };
}

export function isSelectedAntigravityClaudeModel(model: string): boolean {
  return SELECTED_BASES.has(splitAntigravityClaudeEffort(model).baseModel);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Caller effort (including unsupported explicit values) takes precedence over aliases. */
export function getAntigravityClaudeThinkingLevel(model: string, body: unknown): string | null {
  if (!isSelectedAntigravityClaudeModel(model)) return null;
  const root = record(body);
  const request = record(root.request);
  const config = record(request.generationConfig ?? root.generationConfig);
  const native = record(config.thinkingConfig).thinkingLevel;
  const explicit = root.reasoning_effort ?? record(root.reasoning).effort ??
    record(root.output_config).effort ?? native;
  const value = explicit ?? splitAntigravityClaudeEffort(model).effort;
  const effort = typeof value === "string" ? value.toLowerCase() : "";
  return ANTIGRAVITY_CLAUDE_EFFORTS.includes(effort as AntigravityClaudeEffort)
    ? effort.toUpperCase() : null;
}

export function expandAntigravityClaudeEffortModels<T extends {
  id: string; name: string; supportsAdaptiveThinking?: boolean;
}>(models: T[]): Array<T & { supportedThinkingEfforts?: string[] }> {
  const result = new Map<string, T & { supportedThinkingEfforts?: string[] }>();
  for (const model of models) {
    // Never seed from an alias or infer capability from generic reasoning support.
    const split = splitAntigravityClaudeEffort(model.id);
    if (split.effort) continue;
    result.set(model.id, model);
    if (!SELECTED_BASES.has(model.id) || model.supportsAdaptiveThinking !== true) continue;
    result.set(model.id, { ...model, supportedThinkingEfforts: [...ANTIGRAVITY_CLAUDE_EFFORTS] });
    for (const effort of ANTIGRAVITY_CLAUDE_EFFORTS) {
      const id = `${model.id}-${effort}`;
      result.set(id, { ...model, id, name: `${model.name} (${effort})`, supportedThinkingEfforts: [...ANTIGRAVITY_CLAUDE_EFFORTS] });
    }
  }
  return [...result.values()];
}
