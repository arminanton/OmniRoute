/** Inspect complete SSE frames without treating generated text as an error. */
export function inspectCodexSsePrefix(
  text: string,
  patterns: readonly string[]
): {
  ready: boolean;
  matched: string | null;
  message: string | null;
} {
  const frames = text.split(/\r?\n\r?\n/);
  // The last segment may still be a partial JSON frame.
  for (const frame of frames.slice(0, -1)) {
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    if (data === "[DONE]") return { ready: true, matched: null, message: null };
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      const type = typeof event.type === "string" ? event.type : "";
      const response = event.response as Record<string, unknown> | undefined;
      const error = event.error ?? response?.error;
      if (error && (type === "error" || type === "response.failed" || !type)) {
        const serialized = JSON.stringify(error).toLowerCase();
        const matched = patterns.find((pattern) => serialized.includes(pattern)) ?? null;
        const message =
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
            ? error.message
            : matched;
        return { ready: true, matched, message };
      }
      if (type.startsWith("response.")) return { ready: true, matched: null, message: null };
    } catch {
      // Non-JSON data is preserved for the downstream parser.
    }
  }
  return { ready: false, matched: null, message: null };
}
