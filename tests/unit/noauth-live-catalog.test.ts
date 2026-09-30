import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "noauth-catalog-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const cache = await import("../../src/lib/db/readCache.ts");
const snapshots = await import("../../src/lib/db/models/noAuthCatalog.ts");
const { mergeProviderModelListing } =
  await import("../../src/lib/providers/mergeProviderModelListing.ts");

test.after(async () => {
  // Runtime routing imports schedule one immediate local call-log rotation.
  // Let that work finish before closing/removing the isolated database.
  await new Promise<void>((resolve) => setImmediate(resolve));
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("provider snapshot replaces IDs, preserves authoritative empty, isolates providers and invalidates catalog", async () => {
  assert.equal(await snapshots.readNoAuthModelCatalog("aihorde"), null);
  const before = cache.getModelCatalogCacheVersion();
  await snapshots.replaceNoAuthModelCatalog("aihorde", [{ id: "live", name: "Live" }]);
  assert.notEqual(cache.getModelCatalogCacheVersion(), before);
  await snapshots.replaceNoAuthModelCatalog("uncloseai", [{ id: "other", name: "Other" }]);
  await snapshots.replaceNoAuthModelCatalog("aihorde", []);
  assert.deepEqual((await snapshots.readNoAuthModelCatalog("aihorde"))?.models, []);
  assert.equal((await snapshots.readNoAuthModelCatalog("uncloseai"))?.models[0].id, "other");
  core.resetDbInstance();
  assert.deepEqual((await snapshots.readNoAuthModelCatalog("aihorde"))?.models, []);
  await assert.rejects(() => snapshots.replaceNoAuthModelCatalog("openai", []));
  await assert.rejects(() => snapshots.replaceNoAuthModelCatalog("aihorde", [{ nonsense: true }]));
  assert.deepEqual((await snapshots.readNoAuthModelCatalog("aihorde"))?.models, []);
  await snapshots.deleteNoAuthModelCatalog("aihorde");
  assert.equal(await snapshots.readNoAuthModelCatalog("aihorde"), null);
});

test("authoritative provider listing drops seeds and stale imports, retains manual entries and metadata", () => {
  const input = {
    providerId: "aihorde",
    registryModels: [{ id: "stale-seed" }],
    syncedModels: [{ id: "stale-sync" }],
    customModels: [
      { id: "stale-import", source: "imported" },
      { id: "manual", source: "custom", supportsVision: true },
      { id: "live", source: "custom", name: "User name", supportsVision: false },
    ],
    authoritativeModels: [{ id: "live", name: "Upstream name", supportsVision: true }],
  };
  const result = mergeProviderModelListing(input);
  assert.deepEqual(result.map((m) => m.id).sort(), ["live", "manual"]);
  assert.equal(result.find((m) => m.id === "live")?.name, "User name");
  assert.equal(result.find((m) => m.id === "live")?.supportsVision, false);
  assert.deepEqual(
    mergeProviderModelListing({ ...input, authoritativeModels: [] })
      .map((m) => m.id)
      .sort(),
    ["live", "manual"]
  );
  assert.ok(
    mergeProviderModelListing({ ...input, authoritativeModels: null }).some(
      (m) => m.id === "stale-seed"
    )
  );
});

test("/v1/models uses the same authoritative no-auth snapshot as the dashboard, including empty", async () => {
  const modelsDb = await import("../../src/lib/db/models.ts");
  const { getUnifiedModelsResponse } = await import("../../src/app/api/v1/models/catalog.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 503 });
  try {
    await modelsDb.addCustomModel("aihorde", "manual-choice", "Manual choice");
    await modelsDb.addCustomModel("aihorde", "stale-import", "Stale import", "imported");
    await snapshots.replaceNoAuthModelCatalog("aihorde", [
      { id: "live-choice", name: "Live choice" },
    ]);
    const readIds = async () => {
      const response = await getUnifiedModelsResponse(
        new Request("http://localhost/api/v1/models")
      );
      assert.equal(response.status, 200);
      const body = (await response.json()) as { data: Array<{ id: string; type?: string }> };
      return body.data
        .filter((model) => model.id.startsWith("horde/") && (!model.type || model.type === "chat"))
        .map((model) => model.id)
        .sort();
    };
    assert.deepEqual(await readIds(), ["horde/live-choice", "horde/manual-choice"]);
    await snapshots.replaceNoAuthModelCatalog("aihorde", []);
    assert.deepEqual(await readIds(), ["horde/manual-choice"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AI Horde discovery is shared by dashboard and v1 without imported seed accumulation", async () => {
  const { GET } = await import("../../src/app/api/providers/[id]/models/route.ts");
  const { getUnifiedModelsResponse } = await import("../../src/app/api/v1/models/catalog.ts");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ data: [{ id: "worker/new-live", name: "Current worker" }] });
  try {
    const response = await GET(new Request("http://localhost/api/providers/aihorde/models"), {
      params: { id: "aihorde" },
    });
    assert.equal(response.status, 200);
    const discovery = await response.json();
    assert.equal(discovery.authoritative, true);
    assert.equal(discovery.source, "upstream");
    const dashboard = mergeProviderModelListing({
      providerId: "aihorde",
      registryModels: [{ id: "stale-seed" }],
      syncedModels: [],
      customModels: [
        { id: "manual-choice", source: "manual" },
        { id: "stale-import", source: "imported" },
      ],
      authoritativeModels: discovery.models,
    });
    const catalogResponse = await getUnifiedModelsResponse(
      new Request("http://localhost/api/v1/models")
    );
    const catalogBody = (await catalogResponse.json()) as {
      data: Array<{ id: string; type?: string }>;
    };
    const catalogIds = catalogBody.data
      .filter((model) => model.id.startsWith("horde/") && (!model.type || model.type === "chat"))
      .map((model) => model.id.slice("horde/".length))
      .sort();
    assert.deepEqual(catalogIds, dashboard.map((model) => model.id).sort());
    assert.deepEqual(catalogIds, ["manual-choice", "worker/new-live"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("snapshot-only Horde slash IDs and new OpenCode free IDs pass runtime admission and dispatch preparation", async () => {
  const { getModelInfo } = await import("../../src/sse/services/model.ts");
  const { resolveModelOrError } = await import("../../src/sse/handlers/chatHelpers.ts");
  const { getExecutor } = await import("../../open-sse/executors/index.ts");
  const { isPremiumOpencodeModel } = await import("../../open-sse/executors/opencode.ts");
  const { getCustomModels } = await import("../../src/lib/db/models.ts");
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    throw new Error("Offline runtime test forbids network");
  };
  try {
    const cases = [
      {
        provider: "aihorde",
        alias: "horde",
        id: "koboldcpp/volunteer/Brand-New-Model-Q4_K_M",
        host: "oai.aihorde.net",
      },
      {
        provider: "opencode",
        alias: "oc",
        id: "brand-new-discovery-only-free",
        host: "opencode.ai",
      },
    ];
    for (const entry of [...cases].reverse()) {
      await snapshots.replaceNoAuthModelCatalog(entry.provider, [{ id: entry.id, name: entry.id }]);
      const custom = (await getCustomModels(entry.provider)) as Array<{ id: string }>;
      assert.equal(
        custom.some((m) => m.id === entry.id),
        false,
        "model must exist only in anonymous snapshot"
      );
      const qualified = `${entry.alias}/${entry.id}`;
      const info = await getModelInfo(qualified);
      assert.equal(info.provider, entry.provider, JSON.stringify(info));
      assert.equal(info.model, entry.id, "all slash-rich upstream segments survive resolution");
      const body = {
        model: qualified,
        messages: [{ role: "user", content: "offline fixture" }],
        stream: false,
      };
      const admitted = await resolveModelOrError(qualified, body, "/v1/chat/completions");
      assert.equal("error" in admitted, false);
      assert.equal(admitted.provider, entry.provider);
      assert.equal(admitted.model, entry.id);
      const executor = await getExecutor(entry.provider);
      const url = executor.buildUrl(entry.id, false, 0, {});
      assert.equal(new URL(url).host, entry.host);
      const prepared = await executor.transformRequest(
        entry.id,
        { ...body, model: entry.id },
        false,
        {}
      );
      assert.equal((prepared as { model: string }).model, entry.id);
      if (entry.provider === "opencode")
        assert.equal(isPremiumOpencodeModel(entry.id, entry.provider), false);
    }
    assert.equal(fetches, 0, "resolution/admission/dispatch preparation must remain fully offline");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("scoped anonymous discovery aliases agree between the UI and runtime registry", async () => {
  const { NOAUTH_PROVIDERS } = await import("../../src/shared/constants/providers/noauth.ts");
  const { resolveProviderAlias } = await import("../../open-sse/services/model.ts");
  for (const provider of ["aihorde", "opencode", "uncloseai", "duckduckgo-web"] as const) {
    assert.equal(resolveProviderAlias(NOAUTH_PROVIDERS[provider].alias), provider);
  }
});

test("no-auth runtime membership preserves manual models but rejects stale imports and honors empty snapshots", async () => {
  const { getModelInfo } = await import("../../src/sse/services/model.ts");
  const { getActiveSyncedCatalog } = await import("../../src/lib/db/models/activeSyncedCatalog.ts");
  await snapshots.replaceNoAuthModelCatalog("aihorde", []);
  const active = await getActiveSyncedCatalog("aihorde");
  assert.equal(active.authoritative, true);
  assert.deepEqual(
    active.models.map((m) => m.id),
    ["manual-choice"]
  );
  assert.equal((await getModelInfo("horde/manual-choice")).provider, "aihorde");
  assert.equal((await getModelInfo("horde/stale-import")).errorType, "model_not_found");
  assert.equal(
    (await getModelInfo("horde/koboldcpp/volunteer/Brand-New-Model-Q4_K_M")).errorType,
    "model_not_found"
  );
  await snapshots.replaceNoAuthModelCatalog("opencode", []);
  assert.equal(
    (await getModelInfo("oc/brand-new-discovery-only-free")).errorType,
    "model_not_found"
  );
});

test("validated Cloudflare discovery has provider-scoped authoritative snapshots including empty", async () => {
  const { getActiveSyncedCatalog } = await import("../../src/lib/db/models/activeSyncedCatalog.ts");
  const { getModelInfo } = await import("../../src/sse/services/model.ts");
  const { addCustomModel } = await import("../../src/lib/db/models.ts");
  await addCustomModel("cloudflare-playground", "manual-choice", "Manual choice");
  await snapshots.replaceNoAuthModelCatalog("cloudflare-playground", [
    { id: "vendor/new-catalog-model", name: "New catalog model" },
  ]);
  assert.equal(
    (await getModelInfo("cfp/vendor/new-catalog-model")).provider,
    "cloudflare-playground"
  );
  await snapshots.replaceNoAuthModelCatalog("cloudflare-playground", []);
  const active = await getActiveSyncedCatalog("cloudflare-playground");
  assert.equal(active.authoritative, true);
  assert.deepEqual(
    active.models.map((model) => model.id),
    ["manual-choice"]
  );
  assert.equal((await getModelInfo("cfp/vendor/new-catalog-model")).errorType, "model_not_found");
  assert.equal((await getModelInfo("cfp/manual-choice")).provider, "cloudflare-playground");
});
