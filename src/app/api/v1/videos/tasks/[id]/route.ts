import { NextResponse } from "next/server";

import { CORS_HEADERS, handleCorsOptions } from "@/shared/utils/cors";
import { getApiKeyRequestScope } from "@/app/api/v1/_helpers/apiKeyScope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type DurableAgnesTaskService = typeof import("@/app/api/v1/_shared/durableAgnesVideoTasks");
type DurableAgnesTask = NonNullable<
  Awaited<ReturnType<DurableAgnesTaskService["getDurableAgnesVideoTask"]>>
>;

function apiKeyRequired() {
  return NextResponse.json(
    { error: { message: "A registered API key is required", type: "invalid_request_error" } },
    { status: 401, headers: CORS_HEADERS }
  );
}

function taskResponse(service: DurableAgnesTaskService, task: DurableAgnesTask) {
  const status = service.durableAgnesTaskHttpStatus(task);
  const url = `/api/v1/videos/tasks/${encodeURIComponent(task.id)}`;
  return NextResponse.json(service.toDurableAgnesTaskResponse(task), {
    status,
    headers: {
      ...CORS_HEADERS,
      Location: url,
      ...(status === 202
        ? { "Retry-After": String(service.durableAgnesTaskRetryAfterSeconds(task)) }
        : {}),
    },
  });
}

function notFound() {
  return NextResponse.json(
    { error: { message: "Video task not found", type: "invalid_request_error" } },
    { status: 404, headers: CORS_HEADERS }
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
  if (!scope.apiKeyId) return apiKeyRequired();
  const { id } = await params;
  try {
    const service = await import("@/app/api/v1/_shared/durableAgnesVideoTasks");
    const task = await service.getDurableAgnesVideoTask({
      taskId: id,
      apiKeyId: scope.apiKeyId,
    });
    return task ? taskResponse(service, task) : notFound();
  } catch {
    return NextResponse.json(
      {
        error: { message: "Durable async video task service is unavailable", type: "server_error" },
      },
      { status: 503, headers: CORS_HEADERS }
    );
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const scope = await getApiKeyRequestScope(request, {
    requireAuthenticated: true,
    allowUrl: false,
    allowClientApiKeyHeader: true,
  });
  if (scope.rejection) return scope.rejection;
  if (!scope.apiKeyId) return apiKeyRequired();
  const { id } = await params;
  try {
    const service = await import("@/app/api/v1/_shared/durableAgnesVideoTasks");
    const task = await service.requestDurableAgnesVideoTaskCancellation({
      taskId: id,
      apiKeyId: scope.apiKeyId,
    });
    if (!task) return notFound();
    if (task.state === "submitting" || task.state === "submission_unknown") {
      return NextResponse.json(
        {
          error: {
            message:
              "Cancellation cannot be confirmed while the provider submission outcome is unknown",
            type: "conflict_error",
          },
          task: service.toDurableAgnesTaskResponse(task),
        },
        { status: 409, headers: CORS_HEADERS }
      );
    }
    return taskResponse(service, task);
  } catch {
    return NextResponse.json(
      {
        error: { message: "Durable async video task service is unavailable", type: "server_error" },
      },
      { status: 503, headers: CORS_HEADERS }
    );
  }
}
