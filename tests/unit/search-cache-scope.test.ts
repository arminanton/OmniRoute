import test from "node:test";
import assert from "node:assert/strict";

const { computeCacheKey } = await import("../../open-sse/services/searchCache.ts");

function key(
  scope: {
    apiKeyId?: string | null;
    connectionId?: string | null;
    alternateProvider?: string | null;
    alternateConnectionId?: string | null;
  },
  filters = {}
) {
  return computeCacheKey(
    "same query",
    "linkup-search",
    "web",
    5,
    "US",
    "en",
    { content: { full_page: false }, provider_options: filters },
    scope
  );
}

test("search cache scope separates client keys and provider account proxy contexts", () => {
  const baseline = key({ apiKeyId: "client-a", connectionId: "account-1" });

  assert.equal(key({ apiKeyId: "client-a", connectionId: "account-1" }), baseline);
  assert.notEqual(key({ apiKeyId: "client-b", connectionId: "account-1" }), baseline);
  assert.notEqual(key({ apiKeyId: "client-a", connectionId: "account-2" }), baseline);
  assert.notEqual(
    key({
      apiKeyId: "client-a",
      connectionId: "account-1",
      alternateProvider: "brave-search",
      alternateConnectionId: "fallback-account",
    }),
    baseline
  );
});

test("search cache keys include result-affecting provider options and content modes", () => {
  const baseline = key({ apiKeyId: "client-a", connectionId: "account-1" }, { mode: "web" });
  const differentProviderOptions = key(
    { apiKeyId: "client-a", connectionId: "account-1" },
    { mode: "news" }
  );
  const differentContent = computeCacheKey(
    "same query",
    "linkup-search",
    "web",
    5,
    "US",
    "en",
    { content: { full_page: true }, provider_options: { mode: "web" } },
    { apiKeyId: "client-a", connectionId: "account-1" }
  );
  const differentStrictFilterMode = computeCacheKey(
    "same query",
    "linkup-search",
    "web",
    5,
    "US",
    "en",
    {
      content: { full_page: false },
      provider_options: { mode: "web" },
      strict_filters: true,
    },
    { apiKeyId: "client-a", connectionId: "account-1" }
  );

  assert.notEqual(differentProviderOptions, baseline);
  assert.notEqual(differentContent, baseline);
  assert.notEqual(differentStrictFilterMode, baseline);
});
