import { createErrorResponse } from "@/lib/api/errorResponse";
import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getCanaryReadiness } from "@/lib/canaryReadiness";
import { setDeploymentDraining } from "@/lib/canaryLifecycle";
export async function POST(request: Request) {
  const auth = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (auth) return auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return createErrorResponse({ status: 400, message: "Invalid control request" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return createErrorResponse({ status: 400, message: "Invalid control request" });
  const row = body as Record<string, unknown>;
  if (
    Object.keys(row).some((k) => !["generation", "draining"].includes(k)) ||
    typeof row.generation !== "string" ||
    typeof row.draining !== "boolean"
  )
    return createErrorResponse({ status: 400, message: "Invalid control request" });
  try {
    setDeploymentDraining(row.generation, row.draining);
  } catch {
    return createErrorResponse({ status: 409, message: "Generation conflict" });
  }
  const data = await getCanaryReadiness();
  return NextResponse.json(data, {
    headers: { "Cache-Control": "no-store", "X-Omni-App-Generation": data.generation },
  });
}
