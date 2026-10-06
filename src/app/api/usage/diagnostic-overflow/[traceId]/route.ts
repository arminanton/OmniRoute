import { privateOverflowHead } from "@/lib/usage/diagnosticOverflowManagement";
import { inspectPrivateOverflow } from "@/lib/usage/diagnosticOverflowManagement";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ traceId: string }> }) {
  return inspectPrivateOverflow(request, (await params).traceId);
}

export const HEAD = privateOverflowHead;
