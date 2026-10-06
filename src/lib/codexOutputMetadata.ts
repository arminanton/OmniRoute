/** Published output ceilings; preserve provider-discovered input/context budgets. */
// https://developers.openai.com/api/docs/models/gpt-6-astra (and Sol/Luna/6.1-Sol)
export function getCodexPublishedOutputLimit(
  provider: string | null,
  model: string | null
): number | null {
  if (provider !== "codex" && provider !== "cx") return null;
  if (!model) return null;
  return /^gpt-(?:6-(?:astra|sol|luna)|6\.1-sol)(?:-(?:none|low|medium|high|xhigh|max|ultra))?$/.test(
    model
  )
    ? 128000
    : null;
}
