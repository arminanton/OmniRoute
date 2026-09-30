import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-opencode-models-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsRoute = await import("../../src/app/api/providers/[id]/models/route.ts");
const snapshots = await import("../../src/lib/db/models/noAuthCatalog.ts");
test.beforeEach(async () => {
  for (const provider of ["opencode", "duckduckgo-web", "uncloseai"]) {
    await snapshots.deleteNoAuthModelCatalog(provider);
  }
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// #3047 — OpenCode Free (no-auth) has no connection row, so the
// "Import from /models" button used to hit a 404 and silently no-op. The models
// route must serve a non-empty model list when called with a no-auth provider id.
// #3611 — the source may now be "upstream" (live fetch succeeded) or
// "local_catalog" (live fetch failed/unavailable); both are acceptable here.
test("models route serves models for a no-auth provider id (#3047)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    const response = await modelsRoute.GET(
      new Request("http://localhost/api/providers/opencode/models?refresh=true"),
      { params: { id: "opencode" } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, "opencode");
    assert.ok(
      body.source === "local_catalog" || body.source === "upstream",
      `source must be 'local_catalog' or 'upstream', got '${body.source}'`
    );
    assert.ok(Array.isArray(body.models) && body.models.length > 0, "should return catalog models");
    assert.ok(
      body.models.every((m: { id?: unknown }) => typeof m.id === "string" && m.id.length > 0),
      "every model must have a non-empty id"
    );
    assert.ok(!body.models.some((m: { id: string }) => m.id === "muse-spark-1.2"));
    assert.match(body.warning, /unavailable.*local catalog/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("models route still 404s for an unknown provider/connection id", async () => {
  const response = await modelsRoute.GET(
    new Request("http://localhost/api/providers/does-not-exist-xyz/models"),
    { params: { id: "does-not-exist-xyz" } }
  );
  assert.equal(response.status, 404);
});

// #3611 — OpenCode Free (noAuth + modelsUrl) must fetch live models from the
// provider's modelsUrl instead of always returning the stale local_catalog.

const LIVE_MODEL_LIST = [
  { id: "live-model-alpha-free", object: "model" },
  { id: "big-pickle", object: "model" },
  { id: "gpt-paid", object: "model" },
];

test("models route fetches live models from modelsUrl for noAuth provider with modelsUrl (#3611)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL, _init?: RequestInit) => {
    const urlStr = String(url);
    if (urlStr === "https://opencode.ai/zen/v1/models") {
      return Response.json({ data: LIVE_MODEL_LIST });
    }
    return new Response("unexpected fetch: " + urlStr, { status: 500 });
  };

  try {
    const response = await modelsRoute.GET(
      new Request("http://localhost/api/providers/opencode/models"),
      { params: { id: "opencode" } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, "opencode");
    assert.equal(
      body.source,
      "upstream",
      "should report source as 'upstream' when live fetch succeeds"
    );
    assert.ok(Array.isArray(body.models), "models should be an array");
    const ids = body.models.map((m: { id: string }) => m.id);
    assert.ok(ids.includes("live-model-alpha-free"), "should include live model alpha");
    assert.ok(ids.includes("big-pickle"), "should include Big Pickle");
    assert.ok(!ids.includes("gpt-paid"), "Free discovery must not advertise paid Zen models");
    assert.ok(!ids.includes("hy3-free"), "live discovery must not reintroduce stale static models");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("metadata-only no-auth connection row still uses public model discovery", async () => {
  const connection = await providersDb.createProviderConnection({
    provider: "opencode",
    authType: "apikey",
    name: "opencode-metadata",
    isActive: true,
    testStatus: "unknown",
    providerSpecificData: {
      fingerprints: [{ id: "fingerprint-1" }],
      accountProxies: [],
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL) => {
    if (String(url) === "https://opencode.ai/zen/v1/models") {
      return Response.json({ data: LIVE_MODEL_LIST });
    }
    return new Response("unexpected", { status: 500 });
  };

  try {
    const response = await modelsRoute.GET(
      new Request(`http://localhost/api/providers/${connection.id}/models`),
      { params: { id: connection.id } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, "opencode");
    assert.equal(body.connectionId, connection.id);
    assert.equal(body.source, "upstream");
    assert.ok(body.models.some((model: { id: string }) => model.id === "live-model-alpha-free"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("models route falls back to local_catalog when live modelsUrl fetch throws (#3611 fallback on error)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL, _init?: RequestInit) => {
    if (String(url) === "https://opencode.ai/zen/v1/models") {
      throw new Error("network failure");
    }
    return new Response("unexpected", { status: 500 });
  };

  try {
    const response = await modelsRoute.GET(
      new Request("http://localhost/api/providers/opencode/models"),
      { params: { id: "opencode" } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, "opencode");
    assert.equal(body.source, "local_catalog", "should fall back to local_catalog on fetch error");
    assert.ok(Array.isArray(body.models) && body.models.length > 0, "should have catalog models");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("models route falls back to local_catalog when live modelsUrl fetch returns non-OK (#3611 fallback on non-OK)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL, _init?: RequestInit) => {
    if (String(url) === "https://opencode.ai/zen/v1/models") {
      return new Response("Service Unavailable", { status: 503 });
    }
    return new Response("unexpected", { status: 500 });
  };

  try {
    const response = await modelsRoute.GET(
      new Request("http://localhost/api/providers/opencode/models"),
      { params: { id: "opencode" } }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, "opencode");
    assert.equal(
      body.source,
      "local_catalog",
      "should fall back to local_catalog when upstream returns non-OK"
    );
    assert.ok(Array.isArray(body.models) && body.models.length > 0, "should have catalog models");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("disabled OpenCode discovery returns 403 before any upstream call", async () => {
  const { updateSettings } = await import("../../src/lib/db/settings.ts");
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("Discovery must not fetch while disabled");
  };
  try {
    await updateSettings({ blockedProviders: ["opencode"] });
    const response = await modelsRoute.GET(
      new Request("http://localhost/api/providers/opencode/models?refresh=true"),
      { params: { id: "opencode" } }
    );
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Provider is disabled" });
    assert.equal(fetchCalls, 0);
  } finally {
    await updateSettings({ blockedProviders: [] });
    globalThis.fetch = originalFetch;
  }
});

test("Free catalog filtering does not change authenticated Zen or Go discovery", async () => {
  const { filterModelsForRoute } =
    await import("../../src/app/api/providers/[id]/models/modelRouteProjection.ts");
  for (const provider of ["opencode-zen", "opencode-go"]) {
    assert.deepEqual(filterModelsForRoute(provider, LIVE_MODEL_LIST, false), LIVE_MODEL_LIST);
  }
});

test("a live catalog with no free models stays empty rather than reviving static models", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ id: "paid-model" }] });
  try {
    const response = await modelsRoute.GET(
      new Request("http://localhost/api/providers/opencode/models?refresh=true"),
      { params: { id: "opencode" } }
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "upstream");
    assert.deepEqual(body.models, []);
    assert.equal(body.warning, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("other no-auth live catalog failures also disclose their static fallback", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    const response = await modelsRoute.GET(
      new Request("http://localhost/api/providers/uncloseai/models?refresh=true"),
      { params: { id: "uncloseai" } }
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "local_catalog");
    assert.match(body.warning, /unavailable.*local catalog/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("curated-only no-auth catalogs do not claim an upstream failure or fetch", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("Curated catalogs do not fetch");
  };
  try {
    for (const provider of ["cloudflare-playground", "chipotle"]) {
      const response = await modelsRoute.GET(
        new Request(`http://localhost/api/providers/${provider}/models?refresh=true`),
        { params: { id: provider } }
      );
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.source, "local_catalog");
      assert.equal(body.warning, undefined);
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DuckDuckGo discovers the public free-tier catalog without inference or session requests", async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    assert.equal(String(url), "https://duck.ai/duckchat/v1/models");
    return Response.json({
      models: [
        { id: "live-duck-free", name: "Live Duck", accessTier: ["free"] },
        { id: "paid-duck", accessTier: ["plus"] },
      ],
    });
  };
  try {
    const response = await modelsRoute.GET(
      new Request("http://localhost/api/providers/duckduckgo-web/models?refresh=true"),
      { params: { id: "duckduckgo-web" } }
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, "upstream");
    assert.deepEqual(body.models, [{ id: "live-duck-free", name: "Live Duck" }]);
    assert.equal(urls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DuckDuckGo distinguishes failed catalog discovery from an authoritative empty catalog", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [503, 200]) {
      globalThis.fetch = async () =>
        status === 503 ? new Response(null, { status }) : Response.json({ models: [] });
      const response = await modelsRoute.GET(
        new Request("http://localhost/api/providers/duckduckgo-web/models?refresh=true"),
        { params: { id: "duckduckgo-web" } }
      );
      const body = await response.json();
      assert.equal(response.status, 200);
      if (status === 503) {
        assert.equal(body.source, "local_catalog");
        assert.match(body.warning, /unavailable.*local catalog/i);
      } else {
        assert.equal(body.source, "upstream");
        assert.deepEqual(body.models, []);
        assert.equal(body.warning, undefined);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("successful Free discovery persists before hidden filtering and errors retain that snapshot", async () => {
  const { setModelIsHidden } = await import("../../src/lib/db/models.ts");
  const originalFetch = globalThis.fetch;
  const request = () =>
    modelsRoute.GET(
      new Request(
        "http://localhost/api/providers/opencode/models?excludeHidden=true&chatOnly=true"
      ),
      { params: { id: "opencode" } }
    );
  try {
    setModelIsHidden("opencode", "hidden-new-free", true);
    globalThis.fetch = async () =>
      Response.json({
        data: [{ id: "hidden-new-free" }, { id: "visible-new-free" }, { id: "paid-model" }],
      });
    const live = await (await request()).json();
    assert.equal(live.authoritative, true);
    assert.deepEqual(
      live.models.map((m: { id: string }) => m.id),
      ["visible-new-free"]
    );
    const snapshot = await snapshots.readNoAuthModelCatalog("opencode");
    assert.deepEqual(
      snapshot?.models.map((m) => m.id),
      ["hidden-new-free", "visible-new-free"]
    );
    for (const payload of [null, { data: "malformed" }, { data: [{ id: "" }] }]) {
      globalThis.fetch = async () =>
        payload === null ? new Response(null, { status: 503 }) : Response.json(payload);
      const cached = await (await request()).json();
      assert.equal(cached.source, "cache");
      assert.equal(cached.authoritative, true);
      assert.match(cached.warning, /unavailable.*last discovered catalog/i);
      assert.deepEqual(
        cached.models.map((m: { id: string }) => m.id),
        ["visible-new-free"]
      );
      assert.deepEqual(await snapshots.readNoAuthModelCatalog("opencode"), snapshot);
    }
  } finally {
    setModelIsHidden("opencode", "hidden-new-free", false);
    globalThis.fetch = originalFetch;
  }
});

test("validated empty Free discovery replaces prior snapshot and remains empty on fetch failure", async () => {
  const originalFetch = globalThis.fetch;
  const request = () =>
    modelsRoute.GET(new Request("http://localhost/api/providers/opencode/models?refresh=true"), {
      params: { id: "opencode" },
    });
  try {
    await snapshots.replaceNoAuthModelCatalog("opencode", [
      { id: "retired-free", name: "Retired" },
    ]);
    globalThis.fetch = async () => Response.json({ data: [] });
    const live = await (await request()).json();
    assert.equal(live.source, "upstream");
    assert.equal(live.authoritative, true);
    assert.deepEqual(live.models, []);
    assert.deepEqual((await snapshots.readNoAuthModelCatalog("opencode"))?.models, []);
    globalThis.fetch = async () => new Response(null, { status: 503 });
    const cached = await (await request()).json();
    assert.equal(cached.source, "cache");
    assert.equal(cached.authoritative, true);
    assert.deepEqual(cached.models, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
