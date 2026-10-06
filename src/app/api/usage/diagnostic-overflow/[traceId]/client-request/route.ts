import { privateOverflowHead } from "@/lib/usage/diagnosticOverflowManagement";
import { downloadPrivateOverflow } from "@/lib/usage/diagnosticOverflowManagement";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  return downloadPrivateOverflow(request, traceId, traceId, "client-request");
}

export const HEAD = privateOverflowHead;
