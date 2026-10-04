import { NextResponse } from "next/server";
import {
  captureGeminiWebAccountModels,
  GeminiWebAccountCatalogError,
} from "@omniroute/open-sse/services/geminiWebAccountModels.ts";
import {
  getProviderConnectionById,
  persistGeminiWebCookieRotation,
} from "@/lib/db/providers";
import {
  GEMINI_WEB_COOKIE_ROTATION_KEY,
  type GeminiWebCookieRotation,
} from "@omniroute/open-sse/utils/geminiCookies.ts";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  const connectionId = new URL(request.url).searchParams.get("connectionId")?.trim();
  if (!connectionId || connectionId.length > 128)
    return NextResponse.json({ error: "Gemini Web connectionId is required" }, { status: 400 });

  const connection = await getProviderConnectionById(connectionId);
  if (!connection || connection.provider !== "gemini-web")
    return NextResponse.json({ error: "Gemini Web connection not found" }, { status: 404 });

  try {
    const catalog = await captureGeminiWebAccountModels({
      signal: request.signal,
      credentials: {
        apiKey: typeof connection.apiKey === "string" ? connection.apiKey : undefined,
        providerSpecificData: connection.providerSpecificData,
        connectionId,
      },
      onCredentialsRefreshed: async (patch) => {
        const rotation = patch[GEMINI_WEB_COOKIE_ROTATION_KEY] as GeminiWebCookieRotation | undefined;
        if (rotation) {
          persistGeminiWebCookieRotation(
            connectionId,
            rotation.baseCookie,
            rotation.rotatedCookie
          );
        }
      },
    });
    return NextResponse.json(catalog);
  } catch (error) {
    if (request.signal.aborted)
      return NextResponse.json(
        { error: "Gemini Web account model catalog capture aborted" },
        { status: 499 }
      );
    if (error instanceof GeminiWebAccountCatalogError) {
      const status =
        error.code === "capture_aborted"
          ? 499
          : error.code === "too_large"
            ? 413
            : error.code === "timeout"
              ? 504
              : 502;
      return NextResponse.json({ error: error.message }, { status });
    }
    if (error instanceof Error && error.message === "Missing Gemini cookies")
      return NextResponse.json({ error: "Gemini Web cookies are missing" }, { status: 400 });
    return NextResponse.json(
      { error: "Failed to capture Gemini Web account model catalog" },
      { status: 502 }
    );
  }
}
