import { NextResponse } from "next/server";

import { CORS_HEADERS } from "@/shared/utils/cors";
import { getApiKeyMetadata, validateApiKey } from "@/lib/db/apiKeys";
import { extractApiKey } from "@/sse/services/auth";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";

export interface ApiKeyRequestScope {
  apiKey: string | null;
  apiKeyId: string | null;
  apiKeyMetadata: Awaited<ReturnType<typeof getApiKeyMetadata>>;
  rejection: Response | null;
  isSessionAuth: boolean;
}

function authenticationRequired(): Response {
  return NextResponse.json(
    { error: { message: "Authentication required", type: "invalid_request_error" } },
    { status: 401, headers: CORS_HEADERS }
  );
}

function authenticationUnavailable(): Response {
  return NextResponse.json(
    { error: { message: "Authentication service unavailable", type: "server_error" } },
    { status: 503, headers: CORS_HEADERS }
  );
}

/**
 * Whether a request scope may read or mutate a resource owned by `ownerId`.
 * Dashboard sessions are administrative; API keys are restricted to their own
 * resources, with unowned records remaining visible to authenticated API keys.
 */
export function isApiKeyResourceAccessible(
  scope: Pick<ApiKeyRequestScope, "apiKeyId" | "isSessionAuth">,
  ownerId: string | null | undefined
): boolean {
  if (scope.isSessionAuth) return true;
  if (!scope.apiKeyId) return false;
  return ownerId == null || ownerId === scope.apiKeyId;
}

export async function getApiKeyRequestScope(
  request: Request,
  options: { requireAuthenticated?: boolean } = {}
): Promise<ApiKeyRequestScope> {
  const isSessionAuth = await isDashboardSessionAuthenticated(request);
  let apiKey = extractApiKey(request);
  let apiKeyMetadata: ApiKeyRequestScope["apiKeyMetadata"] = null;

  if (options.requireAuthenticated && !isSessionAuth) {
    if (!apiKey) {
      return {
        apiKey: null,
        apiKeyId: null,
        apiKeyMetadata: null,
        rejection: authenticationRequired(),
        isSessionAuth,
      };
    }

    try {
      if (!(await validateApiKey(apiKey))) {
        return {
          apiKey: null,
          apiKeyId: null,
          apiKeyMetadata: null,
          rejection: authenticationRequired(),
          isSessionAuth,
        };
      }
      apiKeyMetadata = await getApiKeyMetadata(apiKey);
    } catch {
      return {
        apiKey: null,
        apiKeyId: null,
        apiKeyMetadata: null,
        rejection: authenticationUnavailable(),
        isSessionAuth,
      };
    }

    if (!apiKeyMetadata?.id) {
      return {
        apiKey: null,
        apiKeyId: null,
        apiKeyMetadata: null,
        rejection: authenticationRequired(),
        isSessionAuth,
      };
    }
  } else if (apiKey) {
    apiKeyMetadata = await getApiKeyMetadata(apiKey);
  }

  return {
    apiKey: options.requireAuthenticated ? (apiKeyMetadata ? apiKey : null) : apiKey,
    apiKeyId: apiKeyMetadata?.id || null,
    apiKeyMetadata,
    rejection: null,
    isSessionAuth,
  };
}
