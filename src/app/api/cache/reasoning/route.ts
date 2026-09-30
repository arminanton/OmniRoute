import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
export const dynamic = "force-dynamic";
import { isAuthenticated } from "@/shared/utils/apiAuth";
import {
  clearReasoningCacheAll,
  deleteReasoningCacheStorageEntryForAdmin,
  getReasoningCacheServiceEntries,
  getReasoningCacheServiceStats,
} from "@omniroute/open-sse/services/reasoningCache.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

const storageKeySchema = z.string().regex(/^rc2h:[a-f0-9]{64}$/);

function errorMessage(error: unknown): string {
  return sanitizeErrorMessage(error);
}

/**
 * GET /api/cache/reasoning
 *
 * Returns reasoning replay cache stats + paginated entries.
 * Query params: ?provider=deepseek&model=deepseek-reasoner&limit=50&offset=0
 */
export async function GET(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const provider = searchParams.get("provider") || undefined;
    const model = searchParams.get("model") || undefined;
    const limit = parseInt(searchParams.get("limit") || "50", 10);
    const offset = parseInt(searchParams.get("offset") || "0", 10);

    const stats = getReasoningCacheServiceStats();
    const entries = getReasoningCacheServiceEntries({
      limit: Math.min(Math.max(limit, 1), 200),
      offset: Math.max(offset, 0),
      provider,
      model,
    });

    return NextResponse.json({ stats, entries });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

/**
 * DELETE /api/cache/reasoning
 *
 * Clears reasoning cache entries.
 * toolCallId must be an opaque rc2h ID returned by GET, not a client tool ID.
 * Query params: ?toolCallId=rc2h:... (single entry), ?provider=deepseek, or no params.
 */
export async function DELETE(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const toolCallId = searchParams.get("toolCallId");
    const provider = searchParams.get("provider") || undefined;

    if (toolCallId !== null) {
      if (!storageKeySchema.safeParse(toolCallId).success) {
        return NextResponse.json({ error: "Invalid reasoning cache storage ID" }, { status: 400 });
      }
      const cleared = deleteReasoningCacheStorageEntryForAdmin(toolCallId);
      return NextResponse.json({
        ok: true,
        cleared,
        scope: "toolCallId",
        toolCallId,
      });
    }

    const cleared = clearReasoningCacheAll(provider);

    return NextResponse.json({
      ok: true,
      cleared,
      scope: provider ? "provider" : "all",
      ...(provider ? { provider } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}
