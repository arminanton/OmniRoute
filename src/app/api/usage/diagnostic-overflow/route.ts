import { privateOverflowHead } from "@/lib/usage/diagnosticOverflowManagement";
import { listPrivateOverflow } from "@/lib/usage/diagnosticOverflowManagement";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const GET = listPrivateOverflow;

export const HEAD = privateOverflowHead;
