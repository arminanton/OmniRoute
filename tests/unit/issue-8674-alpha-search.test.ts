import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-alpha-search-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const searchRegistry = await import("../../open-sse/config/searchRegistry.ts");
const alphaSearchRoute = await import("../../src/app/api/v1/alpha/search/route.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function seedConnection(provider: string, apiKey: string) {
  return providersDb.createProviderConnection({
    provider,
    authType: "apikey",
    name: `${provider}-${Math.random().toString(16).slice(2, 8)}`,
    apiKey,
    isActive: true,
    testStatus: "active",
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeRequest(body: unknown) {
  return new Request("http://localhost/v1/alpha/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("issue-8674: rejects unsupported search operations with 400", async () => {
  for (const operation of ["open", "click", "find", "screenshot"] as const) {
    const response = await alphaSearchRoute.POST(
      makeRequest({
        commands: { search_query: [{ q: "test" }], [operation]: [{ url: "https://example.com" }] },
      })
    );
    const body = (await response.json()) as { error: { message: string } };

    assert.equal(response.status, 400);
    assert.match(body.error.message, new RegExp(operation));
  }
});

test("issue-8674: rejects unsupported operation keys with null or empty values", async () => {
  for (const operation of ["open", "click", "find", "screenshot"] as const) {
    for (const value of [null, "", [], {}]) {
      const response = await alphaSearchRoute.POST(
        makeRequest({ commands: { search_query: [{ q: "test" }], [operation]: value } })
      );

      assert.equal(response.status, 400, `${operation}=${JSON.stringify(value)}`);
    }
  }
});

test("issue-8674: rejects more than 10 search queries", async () => {
  const response = await alphaSearchRoute.POST(
    makeRequest({
      commands: {
        search_query: Array.from({ length: 11 }, (_, index) => ({ q: `query ${index}` })),
      },
    })
  );
  const body = (await response.json()) as { error: { message: string } };

  assert.equal(response.status, 400);
  assert.match(body.error.message, /at most 10 queries/);
});

test("issue-8674: adapts native queries to the existing search provider path", async () => {
  await seedConnection("linkup-search", "linkup-key");
  const linkup = searchRegistry.SEARCH_PROVIDERS["linkup-search"];
  const originalCost = linkup.costPerQuery;
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  linkup.costPerQuery = -1;
  globalThis.fetch = async (url, init = {}) => {
    capturedUrl = String(url);
    capturedInit = init;
    return new Response(
      JSON.stringify({
        results: [
          {
            name: "Provider result",
            url: "https://example.com/result",
            content: "Real provider snippet",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const response = await alphaSearchRoute.POST(
      makeRequest({
        response_length: "long",
        commands: {
          search_query: [
            {
              q: "  native search test  ",
              recency: 7,
              domains: [" example.com ", "docs.example.org"],
            },
          ],
        },
      })
    );
    const body = (await response.json()) as {
      results: { title: string; url: string; snippet: string }[];
      output: string;
    };
    const providerRequest = JSON.parse(String(capturedInit?.body));

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, "https://api.linkup.so/v1/search");
    assert.equal(providerRequest.q, "native search test");
    assert.equal(providerRequest.maxResults, 10);
    assert.deepEqual(providerRequest.includeDomains, ["example.com", "docs.example.org"]);
    assert.equal(
      (Date.parse(providerRequest.toDate) - Date.parse(providerRequest.fromDate)) / 86_400_000,
      7
    );
    assert.deepEqual(body.results, [
      {
        title: "Provider result",
        url: "https://example.com/result",
        snippet: "Real provider snippet",
      },
    ]);
    assert.equal(
      body.output,
      "Provider result — https://example.com/result — Real provider snippet"
    );
  } finally {
    globalThis.fetch = originalFetch;
    linkup.costPerQuery = originalCost;
  }
});
