import { getCliproxyAccountHealth } from "@/lib/services/cliproxyAccountHealth";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  return Response.json(await getCliproxyAccountHealth(), {
    headers: { "Cache-Control": "no-store" },
  });
}
