import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { revokeAccessToken } from "@/lib/db/accessTokens";

/**
 * DELETE /api/cli/tokens/:id — revoke an access token by id or unambiguous prefix.
 * A retry succeeds; unknown tokens return 404 and ambiguous prefixes return 409.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  const { id } = await params;
  const result = revokeAccessToken(id);
  if (result.ambiguous) {
    return NextResponse.json(
      { error: "Token prefix matches multiple live tokens" },
      { status: 409 }
    );
  }
  if (!result.revoked) {
    return NextResponse.json({ error: "Token not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, id, alreadyRevoked: result.alreadyRevoked });
}
