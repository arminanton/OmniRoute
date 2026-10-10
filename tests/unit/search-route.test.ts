import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-search-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const searchRoute = await import("../../src/app/api/v1/search/route.ts");
const { getCacheStats } = await import("../../open-sse/services/searchCache.ts");
const { getAccountRequestInFlightCount, _clearAccountRequestOccupancyForTest } =
  await import("../../open-sse/services/accountRequestOccupancy.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const { waitForCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function resetStorage() {
  await waitForCallLogSaves(5000);
  flushProxyLogsSync();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(
  provider: string,
  overrides: {
    apiKey?: string | null;
    authType?: string;
    maxConcurrent?: number | null;
    providerSpecificData?: Record<string, unknown>;
  } = {}
) {
  return providersDb.createProviderConnection({
    provider,
    authType: overrides.authType || "apikey",
    name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey: overrides.apiKey ?? "test-key",
    isActive: true,
    testStatus: "active",
    ...(overrides.maxConcurrent === undefined ? {} : { maxConcurrent: overrides.maxConcurrent }),
    providerSpecificData: overrides.providerSpecificData || {},
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(async () => {
  await waitForCallLogSaves(5000);
  flushProxyLogsSync();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("v1 search GET lists all search providers", async () => {
  const response = await searchRoute.GET();
  const body = (await response.json()) as any;
  const ids = body.data.map((item: { id: string }) => item.id);

  assert.equal(response.status, 200);
  assert.equal(body.object, "list");
  assert.equal(body.data.length, 20);
  assert.deepEqual(ids, [
    "serper-search",
    "brave-search",
    "perplexity-search",
    "exa-search",
    "tavily-search",
    "nimble-search",
    "firecrawl",
    "google-pse-search",
    "linkup-search",
    "searchapi-search",
    "youcom-search",
    "searxng-search",
    "ollama-search",
    "zai-search",
    "jina-search",
    "context7",
    "duckduckgo-free",
    "x-search",
    "xquik-search",
    "anysearch-search",
  ]);
});

test("v1 search POST uses stored Linkup credentials and returns normalized results", async () => {
  await seedConnection("linkup-search", { apiKey: "linkup-key" });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (url, init = {}) => {
    capturedUrl = String(url);
    capturedInit = init;

    return new Response(
      JSON.stringify({
        results: [
          {
            name: "Linkup result",
            url: "https://example.com/article",
            content: "Linkup snippet",
            type: "web",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "omniroute linkup",
          provider: "linkup-search",
          max_results: 1,
          search_type: "web",
        }),
      })
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, "https://api.linkup.so/v1/search");
    assert.equal(
      (capturedInit?.headers as Record<string, string>).Authorization,
      "Bearer linkup-key"
    );
    assert.equal(body.provider, "linkup-search");
    assert.equal(body.query, "omniroute linkup");
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].title, "Linkup result");
    assert.equal(body.results[0].snippet, "Linkup snippet");
    assert.equal(body.results[0].citation.provider, "linkup-search");
    assert.equal(body.cached, false);
    assert.equal(body.usage.queries_used, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v1 search POST uses firecrawl credentials for unified firecrawl search", async () => {
  await seedConnection("firecrawl", { apiKey: "fc-route-key" });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (url, init = {}) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          web: [
            {
              title: "Firecrawl route hit",
              url: "https://example.com/fc",
              description: "From firecrawl via /v1/search",
            },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "omniroute firecrawl",
          provider: "firecrawl",
          max_results: 3,
          search_type: "web",
        }),
      })
    );
    const body = (await response.json()) as {
      provider: string;
      results: Array<{ title: string; snippet: string }>;
      usage: { queries_used: number };
    };

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, "https://api.firecrawl.dev/v2/search");
    assert.equal(
      (capturedInit?.headers as Record<string, string>).Authorization,
      "Bearer fc-route-key"
    );
    const requestBody = JSON.parse(String(capturedInit?.body || "{}"));
    assert.equal(requestBody.query, "omniroute firecrawl");
    assert.equal(requestBody.limit, 3);
    assert.deepEqual(requestBody.sources, ["web"]);
    assert.equal(body.provider, "firecrawl");
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].title, "Firecrawl route hit");
    assert.equal(body.results[0].snippet, "From firecrawl via /v1/search");
    assert.equal(body.usage.queries_used, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v1 search POST uses stored You.com credentials and returns unified news results", async () => {
  await seedConnection("youcom-search", { apiKey: "you-key" });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;

  globalThis.fetch = async (url, init = {}) => {
    capturedUrl = String(url);
    capturedInit = init;

    return new Response(
      JSON.stringify({
        results: {
          web: [],
          news: [
            {
              title: "You.com news result",
              description: "Breaking update",
              page_age: "2026-04-23T12:00:00Z",
              url: "https://news.example.com/you",
              thumbnail_url: "https://news.example.com/thumb.png",
            },
          ],
        },
        metadata: { search_uuid: "uuid-1", latency: 0.42 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "latest ai regulation",
          provider: "youcom-search",
          max_results: 1,
          search_type: "news",
          time_range: "week",
          content: { full_page: true, format: "markdown" },
        }),
      })
    );
    const body = (await response.json()) as any;
    const url = new URL(capturedUrl);

    assert.equal(response.status, 200);
    assert.equal(url.origin + url.pathname, "https://ydc-index.io/v1/search");
    assert.equal(url.searchParams.get("query"), "latest ai regulation");
    assert.equal(url.searchParams.get("count"), "1");
    assert.equal(url.searchParams.get("freshness"), "week");
    assert.equal(url.searchParams.get("livecrawl"), "news");
    assert.equal(url.searchParams.get("livecrawl_formats"), "markdown");
    assert.equal((capturedInit?.headers as Record<string, string>)["X-API-Key"], "you-key");
    assert.equal(body.provider, "youcom-search");
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].title, "You.com news result");
    assert.equal(body.results[0].snippet, "Breaking update");
    assert.equal(body.results[0].citation.provider, "youcom-search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v1 search POST accepts authless SearXNG with provider_options baseUrl", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";

  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "SearXNG result",
            url: "https://searx.example/result",
            content: "Self-hosted response",
            engines: ["duckduckgo"],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "self hosted meta search",
          provider: "searxng-search",
          search_type: "news",
          provider_options: {
            baseUrl: "http://127.0.0.1:9090/custom-search",
          },
        }),
      })
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(
      capturedUrl,
      "http://127.0.0.1:9090/custom-search/search?q=self+hosted+meta+search&format=json&categories=news"
    );
    assert.equal(body.provider, "searxng-search");
    assert.equal(body.results[0].title, "SearXNG result");
    assert.equal(body.results[0].citation.provider, "searxng-search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v1 search POST rejects authless SearXNG on the unconfigured catalog default base URL (#10976)", async () => {
  // #10976/#10981 (already merged on this base): the catalog-default
  // localhost:8888 always fails in Docker/K8s, so it's now skipped unless a
  // request/connection baseUrl override resolves it to a real URL. This
  // replaces the older "default URL is attempted as-is" expectation.
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = async (url) => {
    fetchCalled = true;
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Default SearXNG result",
            url: "https://searx.example/default",
            content: "Default self-hosted response",
            engines: ["duckduckgo"],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "default self hosted meta search",
          provider: "searxng-search",
          search_type: "web",
        }),
      })
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 503);
    assert.equal(fetchCalled, false);
    assert.match(String(body.error?.message ?? body.error ?? ""), /catalog default/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v1 search POST preserves stored SearXNG baseUrl for authless providers", async () => {
  await seedConnection("searxng-search", {
    apiKey: null,
    authType: "none",
    providerSpecificData: {
      baseUrl: "http://127.0.0.1:9090/custom-search",
    },
  });

  const originalFetch = globalThis.fetch;
  let capturedUrl = "";

  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return new Response(
      JSON.stringify({
        results: [
          {
            title: "Stored SearXNG result",
            url: "https://searx.example/stored",
            content: "Stored self-hosted response",
            engines: ["duckduckgo"],
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "stored self hosted meta search",
          provider: "searxng-search",
          search_type: "web",
        }),
      })
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(
      capturedUrl,
      "http://127.0.0.1:9090/custom-search/search?q=stored+self+hosted+meta+search&format=json&categories=general"
    );
    assert.equal(body.provider, "searxng-search");
    assert.equal(body.results[0].title, "Stored SearXNG result");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v1 search POST falls back to duckduckgo-free when no provider is configured (#11097)", async () => {
  // Contract changed by PR #11097 ("fix(search): fall back to duckduckgo-free when
  // no search provider is configured"): zero-credential /v1/search no longer returns
  // 400 — it promotes the fallback-only duckduckgo-free provider so out-of-the-box
  // search works. This test pins the NEW contract.
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";

  // DuckDuckGo lite HTML shape: result link + snippet cell (see
  // open-sse/services/freeWebSearch.ts parseDuckDuckGoLite).
  const liteHtml = `<html><body>
    <a href="https://example.com/auto-result" class='result-link'>Auto-selected DuckDuckGo result</a>
    <td class='result-snippet'>Fallback free search snippet</td>
  </body></html>`;

  globalThis.fetch = async (url) => {
    capturedUrl = String(url);
    return new Response(liteHtml, { status: 200, headers: { "content-type": "text/html" } });
  };

  try {
    const response = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "auto select self hosted search",
          search_type: "web",
        }),
      })
    );
    const body = (await response.json()) as any;

    assert.equal(response.status, 200);
    assert.equal(
      capturedUrl,
      "https://lite.duckduckgo.com/lite/",
      "the fallback must call the DuckDuckGo lite endpoint"
    );
    assert.equal(body.provider, "duckduckgo-free");
    assert.equal(body.results[0].title, "Auto-selected DuckDuckGo result");
    assert.equal(body.results[0].url, "https://example.com/auto-result");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v1 search reserves distinct selected accounts before concurrent provider attempts", async () => {
  const accountA = await seedConnection("linkup-search", {
    apiKey: "linkup-capacity-a",
    maxConcurrent: 1,
  });
  const accountB = await seedConnection("linkup-search", {
    apiKey: "linkup-capacity-b",
    maxConcurrent: 1,
  });

  const originalFetch = globalThis.fetch;
  const requestsStarted = deferred<void>();
  const authKeys: string[] = [];
  const finishRequests: Array<() => void> = [];
  const responses: Promise<Response>[] = [];
  let fetchCalls = 0;

  globalThis.fetch = async (_url, init = {}) => {
    fetchCalls++;
    authKeys.push(new Headers(init.headers).get("Authorization") || "");
    if (fetchCalls === 2) requestsStarted.resolve();

    const signal = init.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      finishRequests.push(() => {
        signal.removeEventListener("abort", onAbort);
        resolve(
          new Response(
            JSON.stringify({
              results: [
                {
                  name: "Concurrent Linkup result",
                  url: "https://example.com/concurrent-search-result",
                  content: "The configured account handled this distinct query.",
                  type: "web",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      });
    });
  };

  const post = (query: string) =>
    searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          provider: "linkup-search",
          max_results: 1,
          search_type: "web",
        }),
      })
    );

  try {
    const first = post(`distinct capacity query A ${Date.now()}`);
    responses.push(first);
    const firstStartedDeadline = Date.now() + 3_000;
    while (fetchCalls < 1 && Date.now() < firstStartedDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(fetchCalls, 1, "the first provider attempt should start");

    const second = post(`distinct capacity query B ${Date.now()}`);
    responses.push(second);
    let startupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        requestsStarted.promise,
        new Promise<never>((_, reject) => {
          startupTimeout = setTimeout(
            () => reject(new Error("second provider attempt did not start")),
            3_000
          );
        }),
      ]);
    } finally {
      if (startupTimeout) clearTimeout(startupTimeout);
    }

    assert.deepEqual(
      new Set(authKeys),
      new Set(["Bearer linkup-capacity-a", "Bearer linkup-capacity-b"]),
      "an in-flight reservation should make a distinct-query miss select the other account"
    );
    assert.equal(getAccountRequestInFlightCount(String(accountA.id)), 1);
    assert.equal(getAccountRequestInFlightCount(String(accountB.id)), 1);

    for (const finish of finishRequests) finish();
    const results = await Promise.all(responses);
    assert.deepEqual(
      results.map((response) => response.status),
      [200, 200]
    );
    assert.equal(fetchCalls, 2);
    assert.equal(getAccountRequestInFlightCount(String(accountA.id)), 0);
    assert.equal(getAccountRequestInFlightCount(String(accountB.id)), 0);
  } finally {
    for (const finish of finishRequests) finish();
    await Promise.allSettled(responses);
    globalThis.fetch = originalFetch;
  }
});

test("auto-search selects and reserves fallback accounts only after primary failure", async () => {
  const { SEARCH_PROVIDERS, selectProvider } =
    await import("../../open-sse/config/searchRegistry.ts");
  const primaryConfig = selectProvider(undefined, "web");
  assert.ok(primaryConfig);
  const fallbackConfig = SEARCH_PROVIDERS["serper-search"];
  const primaryAccount = await seedConnection(primaryConfig.id, {
    apiKey: "primary-search-key",
    maxConcurrent: 8,
  });
  const lowCapacityFallback = await seedConnection(fallbackConfig.id, {
    apiKey: "fallback-low-capacity-key",
    maxConcurrent: 1,
  });
  const highCapacityFallback = await seedConnection(fallbackConfig.id, {
    apiKey: "fallback-high-capacity-key",
    maxConcurrent: 10,
  });
  await settingsDb.updateSettings({ fallbackStrategy: "available-capacity" });
  _clearAccountRequestOccupancyForTest();

  const originalFetch = globalThis.fetch;
  const primaryResponses: Array<(response: Response) => void> = [];
  const fallbackResponses: Array<(response: Response) => void> = [];
  const fallbackAccounts: string[] = [];
  const primaryStarted = deferred<void>();
  const fallbackStarted = deferred<void>();
  let primaryFetches = 0;

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes(primaryConfig.baseUrl)) {
      primaryFetches++;
      if (primaryFetches === 4) primaryStarted.resolve();
      return new Promise<Response>((resolve) => primaryResponses.push(resolve));
    }

    if (target.includes(fallbackConfig.baseUrl)) {
      const apiKey = new Headers(init.headers).get("x-api-key");
      if (apiKey === "fallback-low-capacity-key") fallbackAccounts.push("low");
      else if (apiKey === "fallback-high-capacity-key") fallbackAccounts.push("high");
      else assert.fail(`unexpected fallback credential: ${apiKey}`);
      assert.equal(
        getAccountRequestInFlightCount(String(primaryAccount.id)),
        0,
        "the failed primary releases its reservation before alternate admission"
      );
      if (fallbackAccounts.length === 4) fallbackStarted.resolve();
      return new Promise<Response>((resolve) => fallbackResponses.push(resolve));
    }

    assert.fail(`unexpected search provider URL: ${target}`);
  };

  const post = (query: string) =>
    searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, max_results: 1, search_type: "web" }),
      })
    );
  const requests = [0, 1, 2, 3].map((index) =>
    post(`fallback capacity query ${Date.now()} ${index}`)
  );
  const waitForWithTimeout = async (promise: Promise<void>, label: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(label)), 3_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  try {
    await waitForWithTimeout(primaryStarted.promise, "four primary attempts did not start");
    assert.equal(
      fallbackAccounts.length,
      0,
      "fallback accounts stay unreserved during primary work"
    );
    for (const resolve of primaryResponses) resolve(new Response("rate limited", { status: 429 }));

    await waitForWithTimeout(fallbackStarted.promise, "four fallback attempts did not start");

    assert.equal(
      fallbackAccounts.filter((account) => account === "low").length,
      1,
      "available-capacity selection should spend the single low-capacity slot once"
    );
    assert.equal(
      fallbackAccounts.filter((account) => account === "high").length,
      3,
      "later concurrent fallbacks should see and account for already reserved capacity"
    );
    assert.equal(getAccountRequestInFlightCount(String(lowCapacityFallback.id)), 1);
    assert.equal(getAccountRequestInFlightCount(String(highCapacityFallback.id)), 3);

    for (const resolve of fallbackResponses) {
      resolve(
        Response.json({
          organic: [{ title: "Fallback", link: "https://example.com/fallback", snippet: "ok" }],
        })
      );
    }
    const results = await Promise.all(requests);
    assert.deepEqual(
      results.map((response) => response.status),
      [200, 200, 200, 200]
    );
    const bodies = await Promise.all(results.map((response) => response.json() as Promise<any>));
    assert.ok(bodies.every((body) => body.provider === fallbackConfig.id));
    assert.equal(getAccountRequestInFlightCount(String(lowCapacityFallback.id)), 0);
    assert.equal(getAccountRequestInFlightCount(String(highCapacityFallback.id)), 0);
  } finally {
    for (const resolve of primaryResponses) resolve(new Response("rate limited", { status: 429 }));
    for (const resolve of fallbackResponses) {
      resolve(Response.json({ organic: [] }));
    }
    await Promise.allSettled(requests);
    globalThis.fetch = originalFetch;
    _clearAccountRequestOccupancyForTest();
  }
});

test("identical auto-search fallbacks coalesce on the actual account and release cache-hit reservations", async () => {
  const { SEARCH_PROVIDERS, selectProvider } =
    await import("../../open-sse/config/searchRegistry.ts");
  const primaryConfig = selectProvider(undefined, "web");
  assert.ok(primaryConfig);
  const blockedFallbackConfig = SEARCH_PROVIDERS["zai-search"];
  const fallbackConfig = SEARCH_PROVIDERS["serper-search"];
  assert.ok(blockedFallbackConfig.costPerQuery < fallbackConfig.costPerQuery);

  await seedConnection(primaryConfig.id, { apiKey: "primary-search-key-a", maxConcurrent: 8 });
  await seedConnection(primaryConfig.id, { apiKey: "primary-search-key-b", maxConcurrent: 8 });
  const blockedFallbackAccount = await seedConnection(blockedFallbackConfig.id, {
    apiKey: "blocked-zai-search-key",
  });
  const fallbackAccount = await seedConnection(fallbackConfig.id, {
    apiKey: "serper-fallback-key",
    maxConcurrent: 1,
  });
  await settingsDb.updateSettings({
    fallbackStrategy: "available-capacity",
    blockedProviders: [blockedFallbackConfig.id],
  });
  _clearAccountRequestOccupancyForTest();

  const originalFetch = globalThis.fetch;
  const primaryStarted = deferred<void>();
  const primaryResponse = deferred<Response>();
  const fallbackStarted = deferred<void>();
  const fallbackResponse = deferred<Response>();
  let primaryCalls = 0;
  let fallbackCalls = 0;
  let blockedFallbackCalls = 0;

  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.includes(primaryConfig.baseUrl)) {
      primaryCalls++;
      primaryStarted.resolve();
      return primaryCalls === 1
        ? primaryResponse.promise
        : new Response("rate limited", { status: 429 });
    }

    if (target.includes(blockedFallbackConfig.baseUrl)) {
      blockedFallbackCalls++;
      assert.fail("a blocked search provider must not be attempted as fallback");
    }

    if (target.includes(fallbackConfig.baseUrl)) {
      fallbackCalls++;
      assert.equal(new Headers(init.headers).get("x-api-key"), "serper-fallback-key");
      assert.equal(
        getAccountRequestInFlightCount(String(fallbackAccount.id)),
        1,
        "one selected fallback account reservation owns the shared attempt"
      );
      fallbackStarted.resolve();
      return fallbackResponse.promise;
    }

    assert.fail(`unexpected search provider URL: ${target}`);
  };

  const query = `identical fallback coalescing ${Date.now()}`;
  const post = () =>
    searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, max_results: 1, search_type: "web" }),
      })
    );
  const waitFor = async (condition: () => boolean, message: string) => {
    const deadline = Date.now() + 3_000;
    while (!condition() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(condition(), message);
  };
  const waitForHits = async (minimum: number) => {
    await waitFor(
      () => getCacheStats().hits >= minimum,
      "expected search request to join cache work"
    );
  };
  const waitForPromise = async <T>(promise: Promise<T>, message: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), 3_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const first = post();
  let second: Promise<Response> | undefined;

  try {
    await waitForPromise(primaryStarted.promise, "primary search attempt did not start");
    const cacheHitsBeforeSecond = getCacheStats().hits;
    second = post();
    await waitForHits(cacheHitsBeforeSecond + 1);
    assert.equal(primaryCalls, 1, "identical searches share the primary upstream attempt");

    const cacheHitsAfterPrimaryJoin = getCacheStats().hits;
    primaryResponse.resolve(new Response("rate limited", { status: 429 }));
    await waitForPromise(fallbackStarted.promise, "fallback search attempt did not start");
    await waitForHits(cacheHitsAfterPrimaryJoin + 1);
    assert.equal(fallbackCalls, 1, "identical failures share one fallback upstream attempt");
    assert.equal(blockedFallbackCalls, 0, "blocked fallback providers are skipped");

    fallbackResponse.resolve(
      Response.json({
        organic: [{ title: "Shared fallback", link: "https://example.com/shared-fallback" }],
      })
    );
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const [firstBody, secondBody] = await Promise.all([
      firstResponse.json() as Promise<any>,
      secondResponse.json() as Promise<any>,
    ]);
    assert.equal(firstResponse.status, 200);
    assert.equal(secondResponse.status, 200);
    assert.equal(firstBody.provider, fallbackConfig.id);
    assert.equal(secondBody.provider, fallbackConfig.id);
    assert.equal(getAccountRequestInFlightCount(String(fallbackAccount.id)), 0);

    const cachedFallback = await post();
    const cachedFallbackBody = (await cachedFallback.json()) as any;
    assert.equal(cachedFallback.status, 200);
    assert.equal(
      cachedFallbackBody.cached,
      true,
      "the fallback cache is keyed by the selected account"
    );
    assert.equal(primaryCalls, 2, "a primary error is not cached as a success");
    assert.equal(fallbackCalls, 1, "the actual fallback account's cached result is reused");
    assert.equal(
      getAccountRequestInFlightCount(String(fallbackAccount.id)),
      0,
      "a cache hit releases the newly selected but unclaimed fallback reservation"
    );
  } finally {
    primaryResponse.resolve(new Response("rate limited", { status: 429 }));
    fallbackResponse.resolve(Response.json({ organic: [] }));
    await Promise.allSettled(second ? [first, second] : [first]);
    globalThis.fetch = originalFetch;
    _clearAccountRequestOccupancyForTest();
  }
  assert.equal(getAccountRequestInFlightCount(String(blockedFallbackAccount.id)), 0);
});

test("v1 search POST detaches one cancelled cache waiter without aborting shared upstream work", async () => {
  const accountA = await seedConnection("linkup-search", {
    apiKey: "linkup-cancel-test-key-a",
    maxConcurrent: 1,
  });
  const accountB = await seedConnection("linkup-search", {
    apiKey: "linkup-cancel-test-key-b",
    maxConcurrent: 1,
  });

  const originalFetch = globalThis.fetch;
  const upstreamStarted = deferred<AbortSignal>();
  const completeUpstreams: Array<() => void> = [];
  let fetchCalls = 0;
  const responsePromises: Promise<Response>[] = [];

  globalThis.fetch = async (_url, init = {}) => {
    fetchCalls++;
    const upstreamSignal = init.signal as AbortSignal;
    upstreamStarted.resolve(upstreamSignal);

    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(upstreamSignal.reason);
      if (upstreamSignal.aborted) {
        onAbort();
        return;
      }
      upstreamSignal.addEventListener("abort", onAbort, { once: true });
      completeUpstreams.push(() => {
        upstreamSignal.removeEventListener("abort", onAbort);
        resolve(
          new Response(
            JSON.stringify({
              results: [
                {
                  name: "Shared Linkup result",
                  url: "https://example.com/shared-search-result",
                  content: "The remaining waiter receives this result.",
                  type: "web",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
        );
      });
    });
  };

  const query = `shared cancellation ${Date.now()}`;
  const request = (signal: AbortSignal) =>
    new Request("http://localhost/api/v1/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        provider: "linkup-search",
        max_results: 1,
        search_type: "web",
      }),
      signal,
    });

  try {
    const firstController = new AbortController();
    const firstResponsePromise = searchRoute.POST(request(firstController.signal));
    responsePromises.push(firstResponsePromise);
    const upstreamSignal = await upstreamStarted.promise;

    const hitsBeforeSecondWaiter = getCacheStats().hits;
    const secondController = new AbortController();
    const secondResponsePromise = searchRoute.POST(request(secondController.signal));
    responsePromises.push(secondResponsePromise);
    const joinDeadline = Date.now() + 3_000;
    while (getCacheStats().hits === hitsBeforeSecondWaiter && Date.now() < joinDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.ok(
      getCacheStats().hits > hitsBeforeSecondWaiter,
      "the second request should join the first request's in-flight search"
    );

    firstController.abort();
    const firstResponse = await firstResponsePromise;
    assert.equal(
      firstResponse.status,
      499,
      "the cancelled waiter should receive a client-cancel status"
    );
    assert.equal(
      upstreamSignal.aborted,
      false,
      "the remaining waiter must keep producer work alive"
    );
    assert.equal(
      getAccountRequestInFlightCount(String(accountA.id)) +
        getAccountRequestInFlightCount(String(accountB.id)),
      1,
      "the cancelled waiter must not release the producer's reservation while another waiter remains"
    );

    assert.ok(completeUpstreams.length > 0, "the shared upstream response should still be pending");
    for (const complete of completeUpstreams) complete();
    const secondResponse = await secondResponsePromise;
    const body = (await secondResponse.json()) as any;

    assert.equal(secondResponse.status, 200);
    assert.equal(body.results[0].title, "Shared Linkup result");
    assert.equal(fetchCalls, 1, "coalesced requests must make only one provider request");
    assert.equal(
      getAccountRequestInFlightCount(String(accountA.id)) +
        getAccountRequestInFlightCount(String(accountB.id)),
      0,
      "the shared reservation must be released after the provider attempt finishes"
    );
  } finally {
    for (const complete of completeUpstreams) complete();
    await Promise.allSettled(responsePromises);
    globalThis.fetch = originalFetch;
  }
});

test("v1 search preserves a provider AbortError as 504 when the caller remains connected", async () => {
  await seedConnection("linkup-search", { apiKey: "linkup-timeout-test-key" });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new DOMException("provider request timed out", "AbortError");
  };

  try {
    const response = await searchRoute.POST(
      new Request("http://localhost/api/v1/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `provider abort classification ${Date.now()}`,
          provider: "linkup-search",
          max_results: 1,
          search_type: "web",
        }),
      })
    );

    assert.equal(
      response.status,
      504,
      "provider-owned aborts must remain timeouts, not caller 499s"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("v1 search returns 499 when body parsing fails after caller cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = {
    signal: controller.signal,
    json: async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    },
  } as Request;

  const response = await searchRoute.POST(request);

  assert.equal(response.status, 499);
});
