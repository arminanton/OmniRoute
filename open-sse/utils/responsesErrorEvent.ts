import { randomUUID } from "node:crypto";

/** Normalize an already-sanitized HTTP error for the Responses SSE protocol. */
export function responsesErrorEvent(text: string, retryAfter: string | null, status = 502): string {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      payload = parsed as Record<string, unknown>;
  } catch {
    /* A raw HTML/text failure is not a Responses event. */
  }
  const nested = payload.error;
  const error =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : {};
  const message =
    typeof error.message === "string"
      ? error.message
      : typeof payload.message === "string"
        ? payload.message
        : "Upstream stream failed before completion.";
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  const deadline = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN;
  const retrySeconds = Number.isFinite(seconds)
    ? Math.ceil(seconds)
    : Number.isFinite(deadline)
      ? Math.ceil((deadline - Date.now()) / 1000)
      : 0;
  return JSON.stringify({
    ...payload,
    type: "response.failed",
    response: {
      id: `resp_${randomUUID().replaceAll("-", "")}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      completed_at: null,
      status: "failed",
      error: {
        code:
          status === 429
            ? "rate_limit_exceeded"
            : typeof error.code === "string"
              ? error.code
              : "server_error",
        message,
      },
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model: "unknown",
      output: [],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: null,
      text: { format: { type: "text" } },
      tool_choice: "auto",
      tools: [],
      top_p: null,
      truncation: "disabled",
      usage: null,
      user: null,
      metadata: {},
    },
    code: typeof error.code === "string" ? error.code : null,
    message,
    param: typeof error.param === "string" ? error.param : null,
    sequence_number: 0,
    ...(retrySeconds > 0 ? { retry_after_seconds: retrySeconds } : {}),
    error: { ...error, message },
  });
}
