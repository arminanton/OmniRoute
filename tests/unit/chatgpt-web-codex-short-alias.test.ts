/** Short ChatGPT Web Codex prefix must not change canonical or saved provider identities. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cgpt-short-alias-"));
process.env.DATA_DIR = dataDir;

const { REGISTRY, getRegistryEntry, generateAliasMap } =
  await import("../../open-sse/config/providerRegistry.ts");
const { parseModel, getModelInfoCore } = await import("../../open-sse/services/model.ts");
const { getModelInfo } = await import("../../src/sse/services/model.ts");
const { getExecutor, hasSpecializedExecutor, DefaultExecutor } =
  await import("../../open-sse/executors/index.ts");
const { getProviderByAlias, getProviderAlias, resolveProviderId } =
  await import("../../src/shared/constants/providers.ts");
const { getReservedProviderPrefixes, isReservedProviderPrefix } =
  await import("../../src/shared/constants/reservedProviderPrefixes.ts");
const { createProviderNodeSchema } =
  await import("../../src/shared/validation/schemas/provider.ts");
const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
const { createProviderNode } = await import("../../src/lib/db/providers/nodes.ts");
const { getProviderCredentials } = await import("../../src/sse/services/auth.ts");

const CANONICAL = "chatgpt-web-codex";
const PREFIXES = [CANONICAL, "cgpt-codex", "cgpt"];

function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(dataDir, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("cgpt is a secondary alias, not a new provider or primary alias", () => {
  const entry = REGISTRY[CANONICAL];
  assert.equal(entry.id, CANONICAL);
  assert.equal(entry.alias, "cgpt-codex");
  assert.ok(entry.additionalAliases?.includes("cgpt"));
  assert.equal(generateAliasMap()[CANONICAL], "cgpt-codex");
  assert.equal(getProviderAlias(CANONICAL), "cgpt-codex");
  for (const prefix of PREFIXES) {
    assert.equal(getRegistryEntry(prefix), entry, prefix);
    assert.equal(getProviderByAlias(prefix)?.id, CANONICAL, prefix);
    assert.equal(resolveProviderId(prefix), CANONICAL, prefix);
  }
  assert.equal(getRegistryEntry("cgpt-web"), null, "retired clean-room alias stays retired");
});

test("all three model prefixes resolve through parser, core and runtime to the canonical ID", async () => {
  for (const prefix of PREFIXES) {
    const fullModel = `${prefix}/high`;
    assert.deepEqual(parseModel(fullModel), {
      provider: CANONICAL,
      providerAlias: prefix,
      model: "high",
      isAlias: false,
      extendedContext: false,
    });
    assert.deepEqual(await getModelInfoCore(fullModel, null), {
      provider: CANONICAL,
      model: "high",
      extendedContext: false,
    });
    const runtime = await getModelInfo(fullModel);
    assert.equal(runtime.provider, CANONICAL, prefix);
    assert.equal(runtime.model, "high", prefix);
  }
});

test("active connection saved under old canonical ID serves short and legacy aliases", async () => {
  resetStorage();
  const connection = await createProviderConnection({
    provider: CANONICAL,
    authType: "cookie",
    name: "local alias test only",
    apiKey: "fake-local-cookie-not-a-credential",
    isActive: true,
    testStatus: "active",
  });
  for (const prefix of PREFIXES) {
    const parsed = parseModel(`${prefix}/high`);
    const selected = await getProviderCredentials(parsed.provider!, null, null, parsed.model);
    assert.equal(selected?.connectionId, connection.id, `${prefix} lookup by parsed canonical ID`);
    const selectedDirect = await getProviderCredentials(prefix, null, null, "high");
    assert.equal(selectedDirect?.connectionId, connection.id, `${prefix} lookup by raw prefix`);
  }
});

test("short and legacy aliases use the specialized Codex executor, never a default OpenAI executor", async () => {
  const canonical = await getExecutor(CANONICAL);
  assert.equal(canonical.constructor.name, "ChatGptWebCodexExecutor");
  for (const prefix of PREFIXES) {
    assert.equal(hasSpecializedExecutor(prefix), true, prefix);
    const executor = await getExecutor(prefix);
    assert.equal(executor.constructor, canonical.constructor, prefix);
    assert.equal(executor instanceof DefaultExecutor, false, prefix);
    assert.equal(executor.provider, CANONICAL, prefix);
  }
});

test("cgpt is reserved: node schema rejects it and a historical shadow cannot hijack runtime", async () => {
  resetStorage();
  assert.equal(isReservedProviderPrefix("cgpt"), true);
  assert.equal(getReservedProviderPrefixes().has("cgpt-codex"), true);
  const rejected = createProviderNodeSchema.safeParse({
    name: "Shadow",
    prefix: "cgpt",
    apiType: "chat",
    baseUrl: "https://invalid.example/v1",
  });
  assert.equal(rejected.success, false);
  if (!rejected.success) {
    assert.ok(rejected.error.issues.some((issue) => issue.path[0] === "prefix"));
  }
  // DB insert bypasses the write-path schema to model a pre-existing custom node.
  await createProviderNode({
    id: "openai-compatible-cgpt-shadow",
    type: "openai-compatible",
    name: "Historical shadow",
    prefix: "cgpt",
    apiType: "chat",
    baseUrl: "https://invalid.example/v1",
  });
  const resolved = await getModelInfo("cgpt/high");
  assert.equal(resolved.provider, CANONICAL);
  assert.equal(resolved.model, "high");
});
