import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nous-public-models-route-"));
process.env.DATA_DIR = dataDir;

const db = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const route = await import("../../src/app/api/providers/[id]/models/route.ts");
const originalFetch = globalThis.fetch;

async function seedConnection() {
  return providers.createProviderConnection({
    provider: "nous-oauth",
    authType: "oauth",
    name: `nous-public-models-${Math.random().toString(16).slice(2)}`,
    accessToken: "local-test-access-not-a-secret",
    refreshToken: "local-test-refresh-not-a-secret",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    providerSpecificData: { nousInferenceBaseUrl: "https://inference-api.nousresearch.com/v1" },
    isActive: true,
    testStatus: "active",
  });
}

async function listModels(id: string) {
  return route.GET(new Request(`http://localhost/api/providers/${id}/models?refresh=true`), {
    params: { id },
  });
}

test.after(() => {
  globalThis.fetch = originalFetch;
  db.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("Nous OAuth route labels only live zero-priced models and never sends bearer to catalog", async () => {
  const conn = await seedConnection();
  let fetchCalls = 0;
  globalThis.fetch = async (url, init) => {
    fetchCalls++;
    assert.equal(String(url), "https://inference-api.nousresearch.com/v1/models");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "manual");
    assert.doesNotMatch(JSON.stringify(init), /local-test-access|local-test-refresh/i);
    return new Response(
      JSON.stringify({
        data: [
          {
            id: "stealth/space-bunny-alpha",
            name: "Space Bunny Alpha",
            pricing: { prompt: "0.0000000000", completion: "0" },
          },
          {
            id: "upstage/solar-pro4:free",
            name: "Upstage Solar Pro 4",
            pricing: { prompt: "0", completion: "0" },
          },
          {
            id: "example/paid:free",
            name: "Priced Model",
            pricing: { prompt: "0.02", completion: "0.03" },
          },
          { id: "example/no-price", name: "Unknown Price" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };
  const res = await listModels(String(conn.id));
  assert.equal(res.status, 200);
  const result = await res.json();
  assert.equal(result.provider, "nous-oauth");
  assert.equal(result.source, "api");
  assert.equal(fetchCalls, 1);
  assert.deepEqual(
    result.models.map((m: { id: string; isFree: boolean }) => [m.id, m.isFree]),
    [
      ["stealth/space-bunny-alpha", true],
      ["upstage/solar-pro4:free", true],
      ["example/paid:free", false],
      ["example/no-price", false],
    ]
  );
  assert.match(result.models[0].name, /Free/);
  assert.doesNotMatch(result.models[2].name, /Free/);
  assert.equal(
    result.models.some((m: { id: string }) => m.id === "Hermes-4-70B"),
    false
  );
});

test("Nous OAuth catalog failure returns no stale/static Free claims", async () => {
  const conn = await seedConnection();
  globalThis.fetch = async () => {
    throw new Error("synthetic catalog outage");
  };
  const res = await listModels(String(conn.id));
  assert.equal(res.status, 503);
  const result = await res.json();
  assert.equal(result.source, "error");
  assert.deepEqual(result.models, []);
  assert.equal(typeof result.warning, "string");
  assert.doesNotMatch(JSON.stringify(result), /local-test-access|local-test-refresh/);
});
