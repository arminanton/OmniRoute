/** An absent upstream usage measurement must not appear as 100% compression. */
export function getCompressionLogStats(
  savedTokens: number | null | undefined,
  inputTokens: number
): { from: number; to: number; percent: number } | null {
  if (
    !Number.isFinite(savedTokens) ||
    !Number.isFinite(inputTokens) ||
    !savedTokens ||
    savedTokens <= 0 ||
    inputTokens <= 0
  )
    return null;
  const from = savedTokens + inputTokens;
  return {
    from,
    to: inputTokens,
    percent: Math.max(0, Math.min(100, Math.round((savedTokens / from) * 100))),
  };
}
