import test from "node:test";
import assert from "node:assert/strict";
import { discoverDuckDuckGoModels } from "../../src/lib/providerModels/duckDuckGoModels.ts";
import { RuntimePolicyError } from "../../src/shared/runtimePolicy.ts";

test("DDG discovery is token-free and excludes paid/internal/malformed entries", async () => {
  const calls: string[] = [];
  const models = await discoverDuckDuckGoModels(async (url, options) => {
    calls.push(String(url));
    assert.equal(options?.method, "GET");
    assert.deepEqual(options?.headers, { Accept: "application/json" });
    return Response.json({
      models: [
        { id: "free-model", name: "Free Model", accessTier: ["free", "pro"] },
        { id: "paid", accessTier: ["pro"] },
        { id: "internal", accessTier: ["internal"] },
        { id: "missing-tier" },
        { id: 42, accessTier: ["free"] },
        { id: "", accessTier: ["free"] },
        { id: "free-model", accessTier: ["free"] },
      ],
    });
  });
  assert.deepEqual(calls, ["https://duck.ai/duckchat/v1/models"]);
  assert.deepEqual(models, [{ id: "free-model", name: "Free Model" }]);
});

test("DDG valid empty free catalog is authoritative", async () => {
  assert.deepEqual(
    await discoverDuckDuckGoModels(async () =>
      Response.json({ models: [{ id: "paid", accessTier: ["pro"] }] })
    ),
    []
  );
});

test("DDG unavailable or malformed catalog returns null for honest fallback", async () => {
  for (const response of [
    new Response("blocked", { status: 403 }),
    new Response("not JSON"),
    Response.json({}),
    Response.json({ models: {} }),
  ]) {
    assert.equal(await discoverDuckDuckGoModels(async () => response), null);
  }
  assert.equal(
    await discoverDuckDuckGoModels(async () => {
      throw new Error("offline");
    }),
    null
  );
});

test("DDG discovery does not hide runtime policy failures behind fallback", async () => {
  const error = new RuntimePolicyError("management-auth-required");
  await assert.rejects(
    discoverDuckDuckGoModels(async () => {
      throw error;
    }),
    (actual) => actual === error
  );
});
