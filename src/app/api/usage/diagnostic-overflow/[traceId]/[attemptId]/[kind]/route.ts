import { privateOverflowHead } from "@/lib/usage/diagnosticOverflowManagement";
import { downloadPrivateOverflow } from "@/lib/usage/diagnosticOverflowManagement";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ traceId: string; attemptId: string; kind: string }> }
) {
  const { traceId, attemptId, kind } = await params;
  return downloadPrivateOverflow(request, traceId, attemptId, kind);
}

export const HEAD = privateOverflowHead;
