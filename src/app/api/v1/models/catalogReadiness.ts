import { buildErrorBody } from "@omniroute/open-sse/utils/error";

/** Cold readiness has a retryable status; unexpected failures still pass through the sanitizer. */
export function catalogReadinessErrorResponse(error: unknown, headers: Record<string, string>) {
  const message = error instanceof Error ? error.message : String(error);
  const warming = message === "catalog_build_timeout";
  const status = warming ? 503 : 500;
  return Response.json(
    buildErrorBody(
      status,
      warming ? "Model catalog is warming up; retry shortly" : message,
      undefined,
      { type: "server_error", code: warming ? "service_unavailable" : "INTERNAL_PROXY_ERROR" }
    ),
    { status, headers: { ...headers, ...(warming ? { "Retry-After": "2" } : {}) } }
  );
}
