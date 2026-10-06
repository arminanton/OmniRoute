/**
 * Shared audio/speech HTTP response helpers.
 *
 * Extracted from `open-sse/handlers/audioSpeech.ts` so that both the handler
 * and any provider-specific adapter modules extracted alongside it (e.g.
 * `open-sse/executors/awsPollyTts.ts`) can share the same response-shaping
 * logic without importing from the (frozen, file-size-ratcheted) handler
 * itself — which would create a circular import.
 */
import { CORS_HEADERS } from "./cors.ts";
import { sanitizeErrorMessage } from "./error.ts";

/**
 * Return safe human-readable text from a parsed upstream JSON error body.
 */
export function sanitizeUpstreamErrorMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const sanitized = sanitizeErrorMessage(message).trim();
  if (!sanitized || /[\r\n]|<\s*[!?/a-z][^>]*>/i.test(sanitized)) return null;
  return sanitized.slice(0, 500) || null;
}

export function normalizeUpstreamErrorStatus(status: unknown): number {
  const value =
    typeof status === "number" ? status : typeof status === "string" ? Number(status) : NaN;
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 502;
}

export function sanitizedUpstreamErrorResponse(
  statusValue: unknown,
  message: unknown,
  fallback: string
): Response {
  const status = normalizeUpstreamErrorStatus(statusValue);
  return Response.json(
    { error: { message: sanitizeUpstreamErrorMessage(message) || fallback, code: status } },
    { status, headers: { ...CORS_HEADERS } }
  );
}

function extractUpstreamErrorMessage(parsed) {
  const detail = parsed?.detail;
  const candidates = [
    parsed?.err_msg,
    parsed?.error?.message,
    typeof parsed?.error === "string" ? parsed.error : null,
    parsed?.message,
    typeof detail === "string" ? detail : detail?.message,
  ];

  const message = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
  return sanitizeUpstreamErrorMessage(message);
}

/**
 * Return a CORS error response from an upstream fetch failure.
 */
export function upstreamErrorResponse(res: Response, errText: string): Response {
  const status = normalizeUpstreamErrorStatus(res.status);
  let errorMessage: string | null = null;
  try {
    errorMessage = extractUpstreamErrorMessage(JSON.parse(errText));
  } catch {
    // Never echo unstructured upstream bodies.
  }

  return sanitizedUpstreamErrorResponse(status, errorMessage, `Upstream error (${status})`);
}

/**
 * Return a CORS audio stream response.
 */
export function audioStreamResponse(res: Response, defaultContentType = "audio/mpeg"): Response {
  const contentType = res.headers.get("content-type") || defaultContentType;
  return new Response(res.body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Transfer-Encoding": "chunked",
    },
  });
}
