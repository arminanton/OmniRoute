import { Readable } from "node:stream";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEADERS = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });
const error = (category: string, status: number) => json({ error: { category } }, status);
async function authenticate(request: Request) {
  return requireManagementAuth(request, { alwaysRequireAuth: true, invalidApiKeyStatus: 401 });
}

export async function listPrivateOverflow(request: Request): Promise<Response> {
  const denied = await authenticate(request);
  if (denied) return denied;
  const query = new URL(request.url).searchParams;
  const limit = Number(query.get("limit") ?? 50),
    before = query.has("before") ? Number(query.get("before")) : undefined;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (before !== undefined && (!Number.isSafeInteger(before) || before < 0))
  )
    return error("invalid_pagination", 400);
  try {
    const { listDiagnosticOverflowTraces } = await import("./diagnosticOverflow");
    return json({ traces: await listDiagnosticOverflowTraces({ limit, before }) });
  } catch {
    return error("overflow_unavailable", 503);
  }
}

export async function inspectPrivateOverflow(request: Request, traceId: string): Promise<Response> {
  const denied = await authenticate(request);
  if (denied) return denied;
  if (!UUID.test(traceId)) return error("invalid_trace", 400);
  try {
    const { readDiagnosticOverflowManifest } = await import("./diagnosticOverflow");
    const manifest = await readDiagnosticOverflowManifest(traceId);
    return manifest ? json(manifest) : error("trace_not_found", 404);
  } catch {
    return error("overflow_unavailable", 503);
  }
}

export async function downloadPrivateOverflow(
  request: Request,
  traceId: string,
  attemptId: string,
  kind: string
): Promise<Response> {
  const denied = await authenticate(request);
  if (denied) return denied;
  if (
    !UUID.test(traceId) ||
    !UUID.test(attemptId) ||
    (kind !== "request" && kind !== "response" && kind !== "client-request")
  )
    return error("invalid_file_alias", 400);
  if (kind === "client-request" && attemptId !== traceId) return error("invalid_file_alias", 400);
  try {
    const { openDiagnosticOverflowFile } = await import("./diagnosticOverflow");
    const file = await openDiagnosticOverflowFile(traceId, attemptId, kind);
    if (file.state !== "ready")
      return json(
        { state: file.state, ...(file.metadata ? { metadata: file.metadata } : {}) },
        file.state === "missing" ? 404 : 409
      );
    const cancel = () => file.stream.destroy();
    request.signal.addEventListener("abort", cancel, { once: true });
    file.stream.once("close", () => request.signal.removeEventListener("abort", cancel));
    if (request.signal.aborted) cancel();
    return new Response(
      Readable.toWeb(file.stream, {
        strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
      }) as ReadableStream<Uint8Array>,
      {
        headers: {
          ...HEADERS,
          "X-Diagnostic-Capture-State": file.metadata.state,
          "X-Diagnostic-Capture-Complete": String(file.metadata.complete),
          "Content-Type": "application/gzip",
          "Content-Disposition": `attachment; filename="${traceId}-${attemptId}-${kind}.gz"`,
        },
      }
    );
  } catch {
    return error("overflow_unavailable", 503);
  }
}

/** Do not open a private payload stream for Next's implicit HEAD fallback. */
export async function privateOverflowHead(request: Request): Promise<Response> {
  const denied = await authenticate(request);
  if (denied) return denied;
  return new Response(null, { status: 405, headers: { ...HEADERS, Allow: "GET" } });
}
