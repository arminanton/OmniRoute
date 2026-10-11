import { NextResponse } from "next/server";

import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { getApiKeyRequestScope } from "@/app/api/v1/_helpers/apiKeyScope";
import { getLeasedDurableVideoTaskContentResponse } from "@/app/api/v1/_shared/durableVideoTaskContent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function error(status: number, message: string) {
  return NextResponse.json(
    { error: { message, type: "invalid_request_error" } },
    { status, headers: CORS_HEADERS }
  );
}

export async function OPTIONS() {
  return handleCorsOptions();
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await getApiKeyRequestScope(request, {
    requireAuthenticated: true,
    allowUrl: false,
    allowClientApiKeyHeader: true,
  });
  if (scope.rejection) return scope.rejection;
  if (!scope.apiKeyId) return error(401, "A registered API key is required");
  const { id } = await params;
  try {
    const service = await import("@/app/api/v1/_shared/durableAgnesVideoTasks");
    const task = await service.getDurableAgnesVideoTask({ taskId: id, apiKeyId: scope.apiKeyId });
    if (!task) return error(404, "Video task not found");
    if (task.state !== "succeeded" || !task.artifactFileId) {
      return error(409, "Video task result is not available");
    }
    if (typeof task.artifactExpiresAt !== "number" || task.artifactExpiresAt <= Date.now()) {
      return error(410, "Video task result has expired");
    }
    const response = await getLeasedDurableVideoTaskContentResponse(request, () =>
      service.getDurableTaskResult(task, scope.apiKeyId!)
    );
    if (!response) return error(404, "Video task result not found");
    return response;
  } catch {
    return error(503, "Durable async video task service is unavailable");
  }
}
