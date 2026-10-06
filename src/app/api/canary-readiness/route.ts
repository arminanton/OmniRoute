import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getCanaryReadiness } from "@/lib/canaryReadiness";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (auth) return auth;
  const data = await getCanaryReadiness();
  return NextResponse.json(data, {
    status: data.ready ? 200 : 503,
    headers: { "Cache-Control": "no-store", "X-Omni-App-Generation": data.generation },
  });
}
