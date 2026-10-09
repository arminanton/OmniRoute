import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getApiKeys } from "@/lib/db/apiKeys";
import { maskStoredApiKey } from "@/lib/apiKeyExposure";

// GET /api/cli-tools/keys - List API keys with raw values for authenticated CLI tools UI only
export async function GET(request: Request) {
  // This route returns each stored API key in `rawKey`; it must stay protected
  // even when the operator has disabled the global login requirement.
  const authError = await requireManagementAuth(request, { alwaysRequireAuth: true });
  if (authError) return authError;

  try {
    const keys = await getApiKeys();
    const cliToolKeys = keys.map((key) => ({
      ...key,
      rawKey: key.key,
      key: maskStoredApiKey(key.key),
    }));
    return NextResponse.json({ keys: cliToolKeys, total: cliToolKeys.length });
  } catch (error) {
    console.log("Error fetching CLI tool keys:", error);
    return NextResponse.json({ error: "Failed to fetch CLI tool keys" }, { status: 500 });
  }
}
