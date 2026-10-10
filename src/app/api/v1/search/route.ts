import { handleSearch } from "@omniroute/open-sse/handlers/search.ts";
import {
  getProviderCredentialsWithQuotaPreflight,
  extractApiKey,
  isValidApiKey,
} from "@/sse/services/auth";
import {
  getAllSearchProviders,
  getSearchProvider,
  resolveSearchProvider,
  selectProvider,
  supportsSearchType,
  isUnconfiguredLoopbackSearchProvider,
  SEARCH_PROVIDERS,
  getSearchCredentialFallbacks,
} from "@omniroute/open-sse/config/searchRegistry.ts";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import * as log from "@/sse/utils/logger";
import { toJsonErrorPayload } from "@/shared/utils/upstreamError";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { v1SearchSchema } from "@/shared/validation/schemas";
import {
  formatValidationMessage,
  isValidationFailure,
  validateBody,
} from "@/shared/validation/helpers";
import { recordCost } from "@/domain/costRules";
import {
  computeCacheKey,
  getOrCoalesce,
  SEARCH_CACHE_DEFAULT_TTL_MS,
} from "@omniroute/open-sse/services/searchCache.ts";
import {
  isAllRateLimitedCredentials,
  rateLimitedProviderResponse,
  type RateLimitedCredentials,
} from "@/app/api/v1/_shared/rateLimit";
import {
  acquireSearchCredentialSelection,
  releaseUnclaimedSearchCredentialReservation,
} from "@omniroute/open-sse/handlers/search/accountAdmission.ts";
import { getSettings } from "@/lib/db/settings";
import { isProviderBlockedByIdOrAlias } from "@/shared/utils/noAuthProviders";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

/**
 * GET /v1/search — list available search providers
 */
export async function GET() {
  const settings = await getSettings().catch(() => ({}) as any);
  const blockedProviders = settings?.blockedProviders || [];
  const providers = getAllSearchProviders(blockedProviders);
  const timestamp = Math.floor(Date.now() / 1000);

  const data = providers.map((p) => ({
    id: p.id,
    object: "search_provider",
    created: timestamp,
    name: p.name,
    search_types: p.searchTypes,
  }));

  return new Response(JSON.stringify({ object: "list", data }), {
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

type SearchCredentials = Record<string, any>;
type SearchCredentialLookup = SearchCredentials | RateLimitedCredentials | null;

async function resolveSearchCredentials(
  providerId: string,
  reserveSelectedAccount = false
): Promise<SearchCredentialLookup> {
  const selectionOptions = reserveSelectedAccount ? { reserveAccountRequest: true } : undefined;
  const credentials = await getProviderCredentialsWithQuotaPreflight(
    providerId,
    null,
    null,
    null,
    selectionOptions
  ).catch(() => null);
  if (credentials && !isAllRateLimitedCredentials(credentials)) return credentials;

  for (const fallbackId of getSearchCredentialFallbacks(providerId)) {
    const fallbackCredentials = await getProviderCredentialsWithQuotaPreflight(
      fallbackId,
      null,
      null,
      null,
      selectionOptions
    ).catch(() => null);
    if (fallbackCredentials && !isAllRateLimitedCredentials(fallbackCredentials)) {
      return fallbackCredentials;
    }
    if (fallbackCredentials) return fallbackCredentials;
  }

  return credentials;
}

async function resolveSearchExecutionCredentials(
  providerConfig: {
    id: string;
    authType: string;
  },
  reserveSelectedAccount = false
): Promise<SearchCredentialLookup> {
  const credentials = await resolveSearchCredentials(providerConfig.id, reserveSelectedAccount);
  if (credentials) return credentials;
  return providerConfig.authType === "none" ? {} : null;
}

// Helper: build domain filter array from filters object
function buildDomainFilter(filters?: {
  include_domains?: string[];
  exclude_domains?: string[];
}): string[] | undefined {
  if (!filters) return undefined;
  const parts: string[] = [];
  if (filters.include_domains?.length) parts.push(...filters.include_domains);
  if (filters.exclude_domains?.length) parts.push(...filters.exclude_domains.map((d) => `-${d}`));
  return parts.length > 0 ? parts : undefined;
}

/**
 * POST /v1/search — execute a web search
 */
async function postHandler(request: Request, context: unknown) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    if (request.signal.aborted) {
      return errorResponse(499, "Search request cancelled");
    }
    log.warn("SEARCH", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  const validation = validateBody(v1SearchSchema, rawBody);
  if (isValidationFailure(validation)) {
    return errorResponse(HTTP_STATUS.BAD_REQUEST, formatValidationMessage(validation.error));
  }
  const body = validation.data;
  if (body.provider === "x_search") body.provider = "x-search";
  if (body.provider === "x-search") body.search_type = "x";

  // Enforce API key policies — use "search" as model identifier for consistent policy config
  const policy = await enforceApiKeyPolicy(request, "search");
  if (policy.rejection) return policy.rejection;

  const settings = await getSettings().catch(() => ({}) as any);
  const blockedProviders = settings?.blockedProviders || [];

  // Resolve provider and credentials
  if (body.provider) {
    if (isProviderBlockedByIdOrAlias(body.provider, blockedProviders)) {
      return errorResponse(
        HTTP_STATUS.FORBIDDEN,
        `Search provider ${body.provider} is blocked by security policy`
      );
    }
    const explicitProvider = resolveSearchProvider(body.provider);
    if (!explicitProvider) {
      return errorResponse(HTTP_STATUS.BAD_REQUEST, `Unknown search provider: ${body.provider}`);
    }
    if (!supportsSearchType(explicitProvider, body.search_type)) {
      return errorResponse(
        HTTP_STATUS.BAD_REQUEST,
        `Search provider ${body.provider} does not support search_type: ${body.search_type}`
      );
    }
  }

  let providerConfig = selectProvider(body.provider, body.search_type);
  if (
    providerConfig &&
    !body.provider &&
    isProviderBlockedByIdOrAlias(providerConfig.id, blockedProviders)
  ) {
    const unblockedCandidate = Object.values(SEARCH_PROVIDERS)
      .filter(
        (p) =>
          !p.fallbackOnly &&
          supportsSearchType(p, body.search_type) &&
          !isProviderBlockedByIdOrAlias(p.id, blockedProviders)
      )
      .sort((a, b) => a.costPerQuery - b.costPerQuery)[0];
    providerConfig = unblockedCandidate || null;
  }
  if (!providerConfig) {
    return errorResponse(
      HTTP_STATUS.BAD_REQUEST,
      body.provider ? `Unknown search provider: ${body.provider}` : "No search providers available"
    );
  }

  const initialProviderConfig = providerConfig;
  const selectionKey = computeCacheKey(
    body.query,
    initialProviderConfig.id,
    body.search_type,
    Math.min(body.max_results, initialProviderConfig.maxMaxResults),
    body.country,
    body.language,
    {
      filters: body.filters,
      offset: body.offset,
      time_range: body.time_range,
      content: body.content,
      provider_options: body.provider_options,
      strict_filters: body.strict_filters,
      requested_provider: body.provider ?? null,
      blocked_providers: Array.isArray(blockedProviders)
        ? [...blockedProviders].map(String).sort()
        : [],
    },
    { apiKeyId: policy.apiKeyInfo?.id ?? null }
  );

  let credentials: Record<string, any> | null = null;
  let alternateProviderIds: string[] = [];
  let releaseSelection: (() => void) | undefined;

  try {
    const selection = await acquireSearchCredentialSelection(
      selectionKey,
      async () => {
        let selectedProviderConfig = initialProviderConfig;
        let selectedCredentials: Record<string, any> | null = null;
        let selectedAlternateProviderIds: string[] = [];
        let firstRateLimitedCredentials: {
          providerId: string;
          credentials: RateLimitedCredentials;
        } | null = null;

        try {
          if (body.provider) {
            const explicitCredentials = await resolveSearchExecutionCredentials(
              selectedProviderConfig,
              true
            );
            if (isAllRateLimitedCredentials(explicitCredentials)) {
              return {
                kind: "response" as const,
                response: rateLimitedProviderResponse(
                  selectedProviderConfig.id,
                  explicitCredentials
                ),
              };
            }
            selectedCredentials = explicitCredentials;
            if (!selectedCredentials) {
              return {
                kind: "response" as const,
                response: errorResponse(
                  HTTP_STATUS.BAD_REQUEST,
                  `No credentials configured for search provider: ${selectedProviderConfig.id}. Add an API key for "${selectedProviderConfig.id}" in the dashboard.`
                ),
              };
            }
          } else {
            // Auto-select — try the resolved provider first, then iterate others by cost.
            const initialCredentials = await resolveSearchExecutionCredentials(
              selectedProviderConfig,
              true
            );
            if (isAllRateLimitedCredentials(initialCredentials)) {
              firstRateLimitedCredentials = {
                providerId: selectedProviderConfig.id,
                credentials: initialCredentials,
              };
            } else {
              selectedCredentials = initialCredentials;
            }

            if (!selectedCredentials) {
              const sortedIds = Object.values(SEARCH_PROVIDERS)
                .filter(
                  (provider) =>
                    !provider.fallbackOnly &&
                    supportsSearchType(provider, body.search_type) &&
                    !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
                )
                .sort((a, b) => a.costPerQuery - b.costPerQuery)
                .map((provider) => provider.id);

              for (const providerId of sortedIds) {
                if (providerId === selectedProviderConfig.id) continue;
                const alternateConfig = getSearchProvider(providerId);
                const alternate = alternateConfig
                  ? await resolveSearchExecutionCredentials(alternateConfig, true)
                  : null;
                if (isAllRateLimitedCredentials(alternate)) {
                  firstRateLimitedCredentials ??= { providerId, credentials: alternate };
                  continue;
                }
                if (alternateConfig && alternate) {
                  selectedProviderConfig = alternateConfig;
                  selectedCredentials = alternate;
                  break;
                }
              }
            }

            // Last resort: promote a fallback-only free provider when no configured
            // credentialed provider is available.
            if (!selectedCredentials) {
              const fallbackProviders = Object.values(SEARCH_PROVIDERS)
                .filter(
                  (provider) =>
                    provider.fallbackOnly &&
                    supportsSearchType(provider, body.search_type) &&
                    !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
                )
                .sort((a, b) => a.costPerQuery - b.costPerQuery);

              for (const fallbackProvider of fallbackProviders) {
                selectedProviderConfig = fallbackProvider;
                if (fallbackProvider.id === "duckduckgo-free") {
                  selectedCredentials = {};
                  break;
                }
                const fallback = await resolveSearchCredentials(fallbackProvider.id, true);
                if (isAllRateLimitedCredentials(fallback)) continue;
                if (fallback) {
                  selectedCredentials = fallback;
                  break;
                }
              }
            }

            if (!selectedCredentials) {
              const response = firstRateLimitedCredentials
                ? rateLimitedProviderResponse(
                    firstRateLimitedCredentials.providerId,
                    firstRateLimitedCredentials.credentials
                  )
                : errorResponse(
                    HTTP_STATUS.BAD_REQUEST,
                    `No credentials configured for any search provider. Add an API key for a search provider (${Object.keys(SEARCH_PROVIDERS).join(", ")}) in the dashboard.`
                  );
              return { kind: "response" as const, response };
            }

            // Keep only the provider order in the plan. Resolve and reserve its
            // account only after the primary fails, so unused backups do not
            // consume account capacity and concurrent fallback requests see
            // each other's reservations.
            const otherIds = Object.values(SEARCH_PROVIDERS)
              .filter(
                (provider) =>
                  !provider.fallbackOnly &&
                  supportsSearchType(provider, body.search_type) &&
                  !isProviderBlockedByIdOrAlias(provider.id, blockedProviders)
              )
              .sort((a, b) => a.costPerQuery - b.costPerQuery)
              .map((provider) => provider.id)
              .filter((providerId) => providerId !== selectedProviderConfig.id);
            const fallbackOnlyIds = Object.values(SEARCH_PROVIDERS)
              .filter(
                (provider) =>
                  provider.fallbackOnly &&
                  provider.id !== selectedProviderConfig.id &&
                  supportsSearchType(provider, body.search_type) &&
                  !isProviderBlockedByIdOrAlias(provider.id, blockedProviders) &&
                  !isUnconfiguredLoopbackSearchProvider(provider)
              )
              .sort((a, b) => a.costPerQuery - b.costPerQuery)
              .map((provider) => provider.id);
            selectedAlternateProviderIds = [...otherIds, ...fallbackOnlyIds];
          }

          return {
            kind: "execution" as const,
            providerConfig: selectedProviderConfig,
            credentials: selectedCredentials!,
            alternateProviderIds: selectedAlternateProviderIds,
          };
        } catch (error) {
          selectedCredentials?.releaseAccountRequest?.();
          throw error;
        }
      },
      (plan) => {
        if (plan.kind === "execution") {
          releaseUnclaimedSearchCredentialReservation(plan.credentials);
        }
      }
    );
    releaseSelection = selection.release;
    if (selection.value.kind === "response") return selection.value.response.clone();

    providerConfig = selection.value.providerConfig;
    credentials = selection.value.credentials;
    alternateProviderIds = selection.value.alternateProviderIds;

    const runCachedProvider = async (
      stageConfig: SearchProviderConfig,
      stageCredentials: Record<string, any>
    ) => {
      const clampedMaxResults = Math.min(body.max_results, stageConfig.maxMaxResults);
      const cacheKey = computeCacheKey(
        body.query,
        stageConfig.id,
        body.search_type,
        clampedMaxResults,
        body.country,
        body.language,
        {
          filters: body.filters,
          offset: body.offset,
          time_range: body.time_range,
          content: body.content,
          provider_options: body.provider_options,
          strict_filters: body.strict_filters,
        },
        {
          apiKeyId: policy.apiKeyInfo?.id ?? null,
          connectionId: stageCredentials.connectionId ?? null,
        }
      );
      const stageStartedAt = Date.now();
      return getOrCoalesce(
        cacheKey,
        stageConfig.cacheTTLMs ?? SEARCH_CACHE_DEFAULT_TTL_MS,
        async (producerSignal) => {
          const result = await handleSearch({
            query: body.query,
            provider: stageConfig.id,
            maxResults: clampedMaxResults,
            searchType: body.search_type,
            country: body.country,
            language: body.language,
            timeRange: body.time_range,
            offset: body.offset,
            domainFilter: buildDomainFilter(body.filters),
            contentOptions: body.content,
            strictFilters: body.strict_filters,
            providerOptions: body.provider_options,
            credentials: stageCredentials,
            log,
            connectionId: stageCredentials.connectionId || undefined,
            apiKeyId: policy.apiKeyInfo?.id || undefined,
            signal: producerSignal,
          });

          if (!result.success) {
            const statusCode = result.status || 502;
            const fallbackEligible =
              !result.terminal &&
              ![400, 401, 403, 404].includes(statusCode) &&
              Date.now() - stageStartedAt < 15_000;
            throw new SearchError(
              result.error || "Search failed",
              statusCode,
              result.terminal === true,
              fallbackEligible
            );
          }

          return result.data!;
        },
        { signal: request.signal }
      );
    };

    let stage: Awaited<ReturnType<typeof runCachedProvider>>;
    try {
      stage = await runCachedProvider(providerConfig, credentials);
    } catch (primaryError) {
      if (
        body.provider ||
        alternateProviderIds.length === 0 ||
        !(primaryError instanceof SearchError) ||
        !primaryError.fallbackEligible
      ) {
        throw primaryError;
      }

      // A primary failure is only converted into SearchError inside the cache
      // producer; successful primary results remain cached solely against the
      // selected primary connection.
      log.warn(
        "SEARCH",
        `${providerConfig.id} failed (${primaryError.statusCode}), resolving fallback account after primary failure`
      );

      let fallbackStage: Awaited<ReturnType<typeof runCachedProvider>> | undefined;
      let fallbackFailure: SearchError | undefined;

      for (const fallbackProviderId of alternateProviderIds) {
        const fallbackConfig = getSearchProvider(fallbackProviderId);
        if (!fallbackConfig) continue;

        const fallbackSelection = await acquireSearchCredentialSelection(
          `${selectionKey}:fallback:${fallbackProviderId}`,
          async () => {
            const selected = await resolveSearchExecutionCredentials(fallbackConfig, true);
            if (!selected) return { kind: "missing" as const };
            if (isAllRateLimitedCredentials(selected)) {
              return { kind: "rate-limited" as const };
            }
            return { kind: "credentials" as const, credentials: selected };
          },
          (selected) => {
            if (selected.kind === "credentials") {
              releaseUnclaimedSearchCredentialReservation(selected.credentials);
            }
          }
        );

        try {
          if (fallbackSelection.value.kind !== "credentials") continue;
          try {
            fallbackStage = await runCachedProvider(
              fallbackConfig,
              fallbackSelection.value.credentials
            );
          } catch (error) {
            if (request.signal.aborted) throw error;
            if (error instanceof SearchError && error.terminal) {
              fallbackFailure = error;
            } else {
              // Match the existing fallback contract: a non-terminal
              // fallback error leaves the primary error visible to callers.
              fallbackFailure = primaryError;
            }
          }
          break;
        } finally {
          fallbackSelection.release();
        }
      }

      if (fallbackStage) {
        stage = fallbackStage;
      } else {
        throw fallbackFailure || primaryError;
      }
    }

    const { data: searchResult, cached } = stage;

    // Record cost for budget tracking (skip cache hits — no provider cost)
    if (!cached && policy.apiKeyInfo?.id && searchResult.usage?.search_cost_usd > 0) {
      try {
        recordCost(policy.apiKeyInfo.id, searchResult.usage.search_cost_usd);
      } catch (e: any) {
        log.warn("SEARCH", `Cost recording failed: ${e?.message}`);
      }
    }

    const response = {
      id: `search-${crypto.randomUUID()}`,
      ...searchResult,
      cached,
      usage: cached ? { queries_used: 0, search_cost_usd: 0 } : searchResult.usage,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } catch (err: any) {
    if (request.signal.aborted) {
      return errorResponse(499, "Search request cancelled");
    }

    if (err instanceof SearchError) {
      const errorPayload = toJsonErrorPayload(err.message, "Search provider error");
      return new Response(JSON.stringify(errorPayload), {
        status: err.statusCode,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    log.error("SEARCH", `Unexpected error: ${err.message}`);
    const errorPayload = toJsonErrorPayload(err.message, "Internal search error");
    return new Response(JSON.stringify(errorPayload), {
      status: 500,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  } finally {
    // Selection-owned cleanup releases unclaimed reservations only after every
    // identical request has left this shared plan.
    releaseSelection?.();
  }
}

class SearchError extends Error {
  statusCode: number;
  terminal: boolean;
  fallbackEligible: boolean;
  constructor(message: string, statusCode: number, terminal = false, fallbackEligible = false) {
    super(message);
    this.statusCode = statusCode;
    this.terminal = terminal;
    this.fallbackEligible = fallbackEligible;
  }
}

export const POST = withInjectionGuard(postHandler);
