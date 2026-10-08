import { maskStoredApiKey } from "@/lib/apiKeyExposure";
import { sanitizeProviderSpecificDataForResponse } from "@/lib/providers/requestDefaults";

/**
 * Dashboard client widgets need provider identity, health, quota, and routing
 * metadata, not the credentials stored alongside those fields. Keep this
 * projection explicit because `/api/providers/client` is also available in
 * keyless local mode.
 */
export function projectProviderClientConnection(connection: Record<string, unknown>) {
  return {
    ...connection,
    apiKey: maskStoredApiKey(connection.apiKey) ?? undefined,
    accessToken: undefined,
    refreshToken: undefined,
    idToken: undefined,
    providerSpecificData: sanitizeProviderSpecificDataForResponse(connection.providerSpecificData),
  };
}
