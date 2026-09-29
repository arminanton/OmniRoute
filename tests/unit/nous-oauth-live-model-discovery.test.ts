import test from "node:test";
import assert from "node:assert/strict";

import { NOUS_OAUTH_INFERENCE_BASE_URLS } from "../../open-sse/config/nousOAuth.ts";
import {
  clearNousOAuthDiscoveryCacheForTests,
  discoverNousOAuthModels,
  NOUS_OAUTH_CATALOG_MAX_BYTES,
  NOUS_OAUTH_CATALOG_MAX_ROWS,
  NOUS_OAUTH_CATALOG_TIMEOUT_MS,
  NOUS_OAUTH_CATALOG_TTL_MS,
} from "../../src/app/api/providers/[id]/models/nousOAuthDiscovery.ts";

const base = NOUS_OAUTH_INFERENCE_BASE_URLS[0];
const welcome = NOUS_OAUTH_INFERENCE_BASE_URLS[1];

test.beforeEach(clearNousOAuthDiscoveryCacheForTests);

function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>
): typeof fetch {
  return (async (url, init) => handler(String(url), init ?? {})) as typeof fetch;
}

test("public GET uses only the exact trusted inference base, no credentials, and blocks redirects", async () => {
  const seen: string[] = [];
  const fetchImpl = mockFetch((url, init) => {
    seen.push(url);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.equal(init.referrerPolicy, "no-referrer");
    assert.equal(init.cache, "no-store");
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get("authorization"), null);
    assert.equal(new Headers(init.headers).get("cookie"), null);
    assert.equal(new Headers(init.headers).get("accept"), "application/json");
    assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ data: [{ id: "model-1", pricing: { prompt: "0", completion: "0" } }] });
  });
  assert.equal((await discoverNousOAuthModels(base, { fetchImpl })).models[0]?.id, "model-1");
  assert.equal((await discoverNousOAuthModels(welcome, { fetchImpl })).models[0]?.id, "model-1");
  assert.deepEqual(seen, [`${base}/models`, `${welcome}/models`]);

  for (const bad of [
    undefined,
    "",
    `${base}/`,
    `${base}/chat/completions`,
    `${base}?url=https://evil.test`,
    `${base}#evil`,
    `${base}/../v1`,
    "http://inference-api.nousresearch.com/v1",
    "https://inference-api.nousresearch.com:443/v1",
    "https://user:secret@inference-api.nousresearch.com/v1",
    "https://inference-api.nousresearch.com.evil.test/v1",
  ]) {
    assert.deepEqual(await discoverNousOAuthModels(bad, { fetchImpl }), {
      models: [],
      source: "error",
      warning: "Invalid Nous OAuth inference base URL",
    });
  }
  assert.equal(seen.length, 2, "invalid host/URL must not reach fetch");

  for (const status of [301, 302, 307, 308]) {
    clearNousOAuthDiscoveryCacheForTests();
    let calls = 0;
    const redirected = await discoverNousOAuthModels(base, {
      fetchImpl: mockFetch((url, init) => {
        calls++;
        assert.equal(url, `${base}/models`);
        assert.equal(init.redirect, "manual");
        return new Response(null, {
          status,
          headers: { Location: "https://evil.test/models?access_token=SECRET_NEVER_SEND" },
        });
      }),
    });
    assert.equal(redirected.source, "error");
    assert.deepEqual(redirected.models, []);
    assert.equal(JSON.stringify(redirected).includes("SECRET_NEVER_SEND"), false);
    assert.equal(calls, 1);
  }
});

test("models stay complete; zero pricing on BOTH sides alone earns a Free suffix and flags", async () => {
  const originalId = "vendor/stealth/space-bunny-alpha:preview";
  const upstream = [
    {
      id: originalId,
      display_name: "Space Bunny Alpha",
      pricing: { prompt: "0.000", completion: "0" },
    },
    {
      id: "new-unlisted-model",
      name: "An unexpected free model",
      pricing: { prompt: "0e12", completion: "-0" },
    },
    { id: "already-free", name: "Already (Free)", pricing: { prompt: "0", completion: "0" } },
    { id: "paid", name: "Paid name", pricing: { prompt: "0", completion: "0.001" } },
    { id: "missing-completion", display_name: "Missing completion", pricing: { prompt: "0" } },
    { id: "unknown-pricing", pricing: { prompt: "", completion: "0" }, isFree: true },
    { id: "infinite-pricing", pricing: { prompt: "Infinity", completion: "0" } },
    { id: "not-a-decimal", pricing: { prompt: "0x0", completion: "0" } },
    { id: "whitespace", pricing: { prompt: "   ", completion: "0" } },
    { id: "underflow-string", pricing: { prompt: "1e-999", completion: "0" } },
    { id: "numeric-zero", pricing: { prompt: 0, completion: "0" } },
    { id: "id:free", name: "Suffix does not prove free", pricing: { prompt: 1, completion: 0 } },
    { id: "paid-upstream-label", name: "Upstream (Free)", pricing: { prompt: 1, completion: 1 } },
    { id: "", name: "no id" },
    { id: 12, pricing: { prompt: 0, completion: 0 } },
  ];
  const response = await discoverNousOAuthModels(base, {
    fetchImpl: mockFetch(() => Response.json({ object: "list", data: upstream })),
  });
  assert.equal(response.source, "api");
  assert.equal(response.models.length, upstream.length - 2, "paid and unpriced rows must stay");
  assert.deepEqual(response.models[0], {
    id: originalId,
    name: "Space Bunny Alpha (Free)",
    free: true,
    isFree: true,
    pricing: { prompt: "0.000", completion: "0" },
  });
  assert.equal(response.models[1]?.name, "An unexpected free model (Free)");
  assert.equal(response.models[1]?.free, true, "no fixed free-ID allowlist");
  assert.equal(response.models[2]?.name, "Already (Free)", "do not duplicate upstream label");
  assert.deepEqual(
    response.models.find((row) => row.id === "paid"),
    {
      id: "paid",
      name: "Paid name",
      free: false,
      isFree: false,
      pricing: { prompt: "0", completion: "0.001" },
    }
  );
  for (const id of [
    "missing-completion",
    "unknown-pricing",
    "infinite-pricing",
    "not-a-decimal",
    "whitespace",
    "underflow-string",
    "numeric-zero",
    "id:free",
    "paid-upstream-label",
  ]) {
    assert.equal(response.models.find((row) => row.id === id)?.free, false, id);
  }
  assert.equal(
    response.models.find((row) => row.id === "unknown-pricing")?.name,
    "unknown-pricing"
  );
  assert.equal(response.models.find((row) => row.id === "underflow-string")?.pricing, undefined);
  assert.equal(
    response.models.find((row) => row.id === "paid-upstream-label")?.name,
    "Upstream",
    "remove a misleading paid upstream label"
  );
});

test("cache expires at five minutes, isolates callers, and never serves old free flags on fetch failure", async () => {
  let now = 42_000;
  let calls = 0;
  const fetchImpl = mockFetch(() => {
    calls++;
    return Response.json({
      models: [{ id: "was-free", pricing: { prompt: "0", completion: "0" } }],
    });
  });
  const options = { fetchImpl, now: () => now };
  const first = await discoverNousOAuthModels(base, options);
  assert.equal(first.source, "api");
  assert.equal(first.models[0].free, true);
  first.models[0].name = "poison";
  first.models[0].pricing!.completion = "99";
  now += NOUS_OAUTH_CATALOG_TTL_MS - 1;
  const stillValid = await discoverNousOAuthModels(base, options);
  assert.equal(stillValid.source, "cache");
  assert.equal(stillValid.models[0].name, "was-free (Free)");
  assert.deepEqual(stillValid.models[0].pricing, { prompt: "0", completion: "0" });
  assert.equal(calls, 1);

  now++;
  const failure = await discoverNousOAuthModels(base, {
    ...options,
    fetchImpl: mockFetch(() => {
      throw new Error("SENSITIVE-OAUTH-TOKEN-AND-URL");
    }),
  });
  assert.deepEqual(failure, {
    models: [],
    source: "error",
    warning: "Nous OAuth public model catalog unavailable",
  });
  assert.equal(JSON.stringify(failure).includes("SENSITIVE"), false);
  // Even at the same clock tick, a failed refresh must not revive stale free badges.
  assert.equal((await discoverNousOAuthModels(base, { ...options, refresh: true })).source, "api");
  const validRefreshFailure = await discoverNousOAuthModels(base, {
    ...options,
    refresh: true,
    fetchImpl: mockFetch(() => new Response(null, { status: 503 })),
  });
  assert.deepEqual(validRefreshFailure.models, []);
  assert.equal(validRefreshFailure.source, "error");
  const retry = await discoverNousOAuthModels(base, options);
  assert.equal(retry.source, "api", "failed refresh must clear even still-fresh previous entry");
  assert.equal(calls, 3);
});

test("invalid JSON, unexpected payload, oversized bodies, and timed-out reads fail closed", async () => {
  const invalid = [
    mockFetch(() => new Response("{invalid", { status: 200 })),
    mockFetch(() => Response.json({ data: { id: "not-an-array" } })),
    mockFetch(
      () =>
        new Response("{}", {
          headers: { "Content-Length": String(NOUS_OAUTH_CATALOG_MAX_BYTES + 1) },
        })
    ),
    mockFetch(() => new Response(new Uint8Array(NOUS_OAUTH_CATALOG_MAX_BYTES + 1))),
    mockFetch(() => new Response(null, { status: 429 })),
    mockFetch(() =>
      Response.json({
        data: Array.from({ length: NOUS_OAUTH_CATALOG_MAX_ROWS + 1 }, (_, i) => ({ id: `m${i}` })),
      })
    ),
  ];
  for (const fetchImpl of invalid) {
    clearNousOAuthDiscoveryCacheForTests();
    const result = await discoverNousOAuthModels(base, { fetchImpl });
    assert.equal(result.source, "error");
    assert.deepEqual(result.models, []);
  }
  clearNousOAuthDiscoveryCacheForTests();
  const stalled = await discoverNousOAuthModels(base, {
    timeoutMs: 25,
    fetchImpl: mockFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"data":['));
              // Remain open to verify the deadline covers body reads, not only fetch().
            },
          })
        )
    ),
  });
  assert.equal(stalled.source, "error");
  assert.deepEqual(stalled.models, []);
  assert.equal(NOUS_OAUTH_CATALOG_TIMEOUT_MS, 10_000);
});

test("positive raw numeric underflow cannot be marked Free by JSON.parse rounding", async () => {
  const result = await discoverNousOAuthModels(base, {
    fetchImpl: mockFetch(
      () =>
        new Response(
          '{"data":[{"id":"underflow-number","pricing":{"prompt":1e-999,"completion":"0"}},{"id":"numeric-zero","pricing":{"prompt":0,"completion":"0"}}]}'
        )
    ),
  });
  assert.equal(result.source, "api");
  assert.deepEqual(
    result.models.map((row) => ({ id: row.id, free: row.free })),
    [
      { id: "underflow-number", free: false },
      { id: "numeric-zero", free: false },
    ]
  );
});

test("concurrent requests share one in-flight public GET", async () => {
  let finish!: (value: Response) => void;
  let calls = 0;
  const fetchImpl = mockFetch(() => {
    calls++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  });
  const first = discoverNousOAuthModels(base, { fetchImpl });
  const second = discoverNousOAuthModels(base, { fetchImpl });
  assert.equal(calls, 1);
  finish(Response.json({ data: [{ id: "alpha", pricing: { prompt: 0, completion: 0 } }] }));
  assert.equal((await first).source, "api");
  assert.equal((await second).source, "api");
  assert.equal(calls, 1);
});
