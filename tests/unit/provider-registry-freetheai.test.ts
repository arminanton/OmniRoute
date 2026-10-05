/**
 * Issue #6670 — Add FreeTheAi as an OpenAI-compatible gateway provider
 * (free tier via Discord signup).
 *
 * Verifies the new provider is wired end-to-end the same way as the other
 * aggregator/gateway providers (chutes, glhf, ...):
 *   - present in the executor REGISTRY with an OpenAI-compatible shape
 *   - resolvable through getExecutor() (falls through to DefaultExecutor,
 *     same as every other `executor: "default"` registry entry)
 *   - listed in AGGREGATOR_PROVIDER_IDS so it shows up in the aggregator
 *     category on the dashboard
 *   - has provider metadata (name/website/free-tier note) in the apikey
 *     gateway catalog
 */
import test from "node:test";
import assert from "node:assert/strict";

const { REGISTRY } = await import("../../open-sse/config/providerRegistry.ts");
const { getExecutor, DefaultExecutor } = await import("../../open-sse/executors/index.ts");
const { AGGREGATOR_PROVIDER_IDS } = await import("../../src/shared/constants/providers.ts");
const { APIKEY_PROVIDERS } = await import("../../src/shared/constants/providers/apikey/index.ts");

test("#6670 freetheai is registered in the executor registry with an OpenAI-compatible shape", () => {
  const entry = (REGISTRY as Record<string, Record<string, unknown>>).freetheai;
  assert.ok(entry, "freetheai should be present in the executor registry");
  assert.equal(entry.format, "openai");
  assert.equal(entry.executor, "default");
  assert.equal(entry.baseUrl, "https://api.freetheai.org/v1/chat/completions");
  assert.equal(entry.modelsUrl, "https://api.freetheai.org/v1/models");
  assert.equal(entry.authType, "apikey");
  assert.equal(entry.authHeader, "bearer");
  assert.equal(entry.passthroughModels, true);
  assert.ok(
    Array.isArray(entry.models) && entry.models.length > 0,
    "must seed a fallback model list"
  );
});

test("#6670 freetheai resolves through getExecutor() as a DefaultExecutor instance", async () => {
  const executor = await getExecutor("freetheai");
  assert.ok(
    executor instanceof DefaultExecutor,
    "freetheai has no custom executor — must fall through to DefaultExecutor"
  );
});

test("#6670 freetheai is classified as an aggregator/gateway provider", () => {
  assert.ok(
    AGGREGATOR_PROVIDER_IDS.has("freetheai"),
    "freetheai must be listed in AGGREGATOR_PROVIDER_IDS alongside chutes/etc"
  );
});

test("#6670 freetheai has provider metadata with free-tier info", () => {
  const meta = (APIKEY_PROVIDERS as Record<string, Record<string, unknown>>).freetheai;
  assert.ok(meta, "freetheai should have an APIKEY_PROVIDERS metadata entry");
  assert.equal(meta.id, "freetheai");
  assert.equal(meta.name, "FreeTheAi");
  assert.equal(meta.website, "https://freetheai.org");
  assert.equal(meta.hasFree, true);
  assert.equal(typeof meta.freeNote, "string");
  assert.ok((meta.freeNote as string).length > 0);
});

test("#15385 freetheai seeds only fully-qualified fta/ model ids", () => {
  const entry = (REGISTRY as Record<string, Record<string, unknown>>).freetheai;
  const models = entry.models as Array<{ id: string }>;
  const retired = ["gpt-4o-mini", "llama-3.3-70b-instruct", "deepseek-chat"];
  for (const model of models) {
    assert.ok(
      model.id.startsWith("fta/"),
      `seeded model "${model.id}" must include the fta/ namespace`
    );
    assert.ok(!retired.includes(model.id), `retired model "${model.id}" must not be seeded`);
  }
});

test("#15385 freetheai signup copy references the current domain", () => {
  const meta = (APIKEY_PROVIDERS as Record<string, Record<string, unknown>>).freetheai;
  for (const field of ["freeNote", "authHint"] as const) {
    const copy = String(meta[field] ?? "");
    assert.ok(!/freetheai\.xyz/.test(copy));
    assert.match(copy, /freetheai\.org/);
  }
});
