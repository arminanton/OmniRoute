/** Preserve upstream cache/reasoning accounting without deriving it from prompt size. */
export function normalizeAntigravityUsageMetadata(
  value: Record<string, unknown>
): Record<string, unknown> {
  const count = (input: unknown): number => {
    if (typeof input !== "number" && typeof input !== "string") return 0;
    const number = typeof input === "string" && input.trim() === "" ? NaN : Number(input);
    return Number.isSafeInteger(number) && number >= 0 ? number : 0;
  };
  const prompt = count(value.promptTokenCount ?? value.prompt_token_count);
  const candidates = count(value.candidatesTokenCount ?? value.candidates_token_count);
  const thoughts = count(value.thoughtsTokenCount ?? value.thoughts_token_count);
  const cached = value.cachedContentTokenCount ?? value.cached_content_token_count;
  const total = count(value.totalTokenCount ?? value.total_token_count);
  return {
    prompt_tokens: prompt,
    completion_tokens: candidates + thoughts,
    total_tokens: total || prompt + candidates + thoughts,
    ...(cached != null
      ? {
          prompt_tokens_details: { cached_tokens: count(cached) },
          cache_read_input_tokens: count(cached),
        }
      : {}),
    ...(thoughts > 0 ? { completion_tokens_details: { reasoning_tokens: thoughts } } : {}),
  };
}
