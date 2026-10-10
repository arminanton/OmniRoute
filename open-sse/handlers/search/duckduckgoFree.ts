import { freeWebSearch } from "../../services/freeWebSearch.ts";
import { saveCallLog } from "@/lib/usageDb";
import { sanitizeErrorMessage } from "../../utils/error.ts";
import type { SearchProviderConfig } from "../../config/searchRegistry.ts";
import type { SearchResult } from "../search.ts";

type SearchResultInput = {
  title?: string;
  url?: string;
  snippet?: string;
  score?: number;
  published_at?: string;
  favicon_url?: string;
  author?: string;
  source_type?: string;
  image_url?: string;
  full_text?: string;
  text_format?: string;
};

type MakeSearchResult = (
  providerId: string,
  item: SearchResultInput,
  idx: number,
  now: string
) => SearchResult;

type SearchRequestParams = { query: string; searchType: string; maxResults: number };
type SearchHandlerResult = {
  success: boolean;
  status?: number;
  error?: string;
  data?: {
    provider: string;
    query: string;
    results: SearchResult[];
    answer: null;
    usage: { queries_used: number; search_cost_usd: number };
    metrics: {
      response_time_ms: number;
      upstream_latency_ms: number;
      total_results_available: number | null;
    };
    errors: [];
  };
};

/** No-key DuckDuckGo fallback has no selected account to reserve or admit. */
export async function tryDuckDuckGoFreeProvider(options: {
  config: SearchProviderConfig;
  params: SearchRequestParams;
  startTime: number;
  globalStartTime: number;
  globalTimeoutMs: number;
  signal?: AbortSignal;
  log?: {
    info?: (tag: string, message: string) => void;
    error?: (tag: string, message: string) => void;
  } | null;
  makeResult: MakeSearchResult;
}): Promise<SearchHandlerResult> {
  const { config, params, startTime, globalStartTime, globalTimeoutMs, signal, log, makeResult } =
    options;
  const { query, searchType, maxResults } = params;
  const remainingGlobal = globalTimeoutMs - (Date.now() - globalStartTime);
  const timeout = Math.min(config.timeoutMs, Math.max(remainingGlobal, 1000));

  log?.info?.("SEARCH", `${config.id} | query: "${query.slice(0, 80)}" | type: ${searchType}`);
  const requestBody = {
    query: query.slice(0, 200),
    search_type: searchType,
    max_results: maxResults,
  };

  try {
    const freeResults = await freeWebSearch(query, maxResults, timeout, signal);
    const now = new Date().toISOString();
    const results = freeResults
      .slice(0, maxResults)
      .map((item, index) => makeResult(config.id, item, index, now));
    const duration = Date.now() - startTime;
    saveCallLog({
      method: config.method,
      path: "/v1/search",
      status: 200,
      model: config.id,
      provider: config.id,
      duration,
      requestType: "search",
      tokens: { prompt_tokens: 0, completion_tokens: 0 },
      requestBody,
      responseBody: { results_count: results.length, cached: false },
    }).catch(() => {});

    return {
      success: true,
      data: {
        provider: config.id,
        query,
        results,
        answer: null,
        usage: { queries_used: 1, search_cost_usd: 0 },
        metrics: {
          response_time_ms: duration,
          upstream_latency_ms: duration,
          total_results_available: results.length,
        },
        errors: [],
      },
    };
  } catch (error) {
    if (signal?.aborted) {
      if (signal.reason !== undefined) throw signal.reason;
      throw new DOMException("The operation was aborted", "AbortError");
    }
    const duration = Date.now() - startTime;
    const message = sanitizeErrorMessage(error);
    log?.error?.("SEARCH", `${config.id} error: ${message}`);
    saveCallLog({
      method: config.method,
      path: "/v1/search",
      status: 502,
      model: config.id,
      provider: config.id,
      duration,
      requestType: "search",
      error: message.slice(0, 500),
      requestBody,
    }).catch(() => {});
    return { success: false, status: 502, error: `DuckDuckGo free search failed: ${message}` };
  }
}
