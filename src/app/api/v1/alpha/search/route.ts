import { z } from "zod";
import { POST as searchPost } from "../../search/route";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

const RESPONSE_LENGTH_MAX_RESULTS = { short: 3, medium: 5, long: 10 } as const;
const MAX_ALPHA_SEARCH_QUERIES = 10;
const UNSUPPORTED_OPERATIONS = ["open", "click", "find", "screenshot"] as const;

const alphaSearchBodySchema = z
  .object({
    commands: z
      .object({
        search_query: z
          .array(
            z.object({
              q: z.string().trim().min(1).max(500),
              recency: z.coerce.number().int().positive().optional(),
              domains: z.array(z.string().trim().min(1).max(253)).max(20).optional(),
            })
          )
          .max(MAX_ALPHA_SEARCH_QUERIES, "commands.search_query must contain at most 10 queries")
          .optional(),
        open: z.unknown().optional(),
        click: z.unknown().optional(),
        find: z.unknown().optional(),
        screenshot: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
    response_length: z.enum(["short", "medium", "long"]).optional(),
  })
  .passthrough();

function jsonError(status: number, message: string) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function recencyToTimeRange(recency?: number): string | undefined {
  if (recency === undefined) return undefined;
  if (recency <= 1) return "day";
  if (recency <= 7) return "week";
  if (recency <= 31) return "month";
  return "year";
}

export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const parsed = alphaSearchBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return jsonError(400, parsed.error.issues[0]?.message || "Invalid request body");
  }

  const commands = parsed.data.commands || {};
  for (const operation of UNSUPPORTED_OPERATIONS) {
    if (Object.prototype.hasOwnProperty.call(commands, operation)) {
      return jsonError(400, `Unsupported operation for /v1/alpha/search: ${operation}`);
    }
  }

  const queries = commands.search_query;
  if (!queries?.length) {
    return jsonError(400, "commands.search_query must contain at least one query");
  }

  const maxResults = RESPONSE_LENGTH_MAX_RESULTS[parsed.data.response_length || "medium"];
  const results: { title: string; url: string; snippet: string }[] = [];
  let queriesUsed = 0;
  let searchCostUsd = 0;

  for (const item of queries) {
    const timeRange = recencyToTimeRange(item.recency);
    const headers = new Headers(request.headers);
    headers.set("Content-Type", "application/json");
    headers.delete("Content-Length");
    const response = await searchPost(
      new Request(request.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: item.q,
          max_results: maxResults,
          search_type: "web",
          ...(timeRange ? { time_range: timeRange } : {}),
          ...(item.domains?.length ? { filters: { include_domains: item.domains } } : {}),
        }),
      })
    );
    if (!response.ok) return response;

    let searchResult: {
      results?: { title: string; url: string; snippet: string }[];
      usage?: { queries_used?: number; search_cost_usd?: number };
    };
    try {
      searchResult = await response.json();
    } catch {
      return jsonError(502, "Invalid search provider response");
    }
    if (!Array.isArray(searchResult.results)) {
      return jsonError(502, "Invalid search provider response");
    }

    results.push(
      ...searchResult.results.map(({ title, url, snippet }) => ({ title, url, snippet }))
    );
    if (typeof searchResult.usage?.queries_used === "number") {
      queriesUsed += searchResult.usage.queries_used;
    }
    if (typeof searchResult.usage?.search_cost_usd === "number") {
      searchCostUsd += searchResult.usage.search_cost_usd;
    }
  }

  const output = results
    .map((result) => `${result.title} — ${result.url} — ${result.snippet}`)
    .join("\n");
  return new Response(
    JSON.stringify({
      encrypted_output: null,
      output,
      results,
      usage: { queries_used: queriesUsed, search_cost_usd: searchCostUsd },
    }),
    { status: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
  );
}
