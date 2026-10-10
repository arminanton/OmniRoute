import { extractApiKey } from "@/sse/services/auth.ts";
import { extractGoogApiKeyHeader } from "@/sse/services/googApiKeyAuth.ts";

/**
 * Select the credential accepted by the CLIENT_API auth policy.
 *
 * Keep this shared by central authorization and request handlers that need the
 * authenticated key's policy (for example, model-catalog filtering). The
 * general `extractApiKey()` intentionally keeps its Anthropic-specific
 * `x-api-key` behavior for other call sites.
 *
 * Precedence matches the historical clientApiPolicy behavior:
 * Bearer, x-api-key, x-goog-api-key, then a path-scoped VS Code token.
 */
export function extractClientApiCredential(request: Request): string | null {
  const rawAuthorization = request.headers.get("authorization");
  if (rawAuthorization) {
    const trimmed = rawAuthorization.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
      const token = trimmed.slice(7).trim();
      if (token) return token;
    }
    // Non-Bearer client credentials (including an empty Bearer value) fall
    // through to the explicitly supported API-key headers and URL token.
  }

  const xApiKey = request.headers.get("x-api-key");
  if (xApiKey) return xApiKey.trim() || null;

  const xGoogApiKey = extractGoogApiKeyHeader(request.headers);
  if (xGoogApiKey) return xGoogApiKey;

  // Retain the established path-token parser and its URL-safety restrictions.
  // At this point no accepted explicit credential was present.
  return extractApiKey(request);
}
