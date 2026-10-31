// GhostCLI (https://ghostcli.cloud) — High-throughput Enterprise API gateway.
// Guards the canonical catalog entry, alias resolution, 1M context capabilities,
// and protocol routing.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROVIDERS,
  getProviderByAlias,
} from "@/shared/constants/providers";

test("ghostcli is a canonical provider with the agreed id/alias/brand", () => {
  const provider = AI_PROVIDERS.ghostcli as unknown as Record<string, unknown>;
  assert.ok(provider, "ghostcli missing from AI_PROVIDERS");
  assert.equal(provider.id, "ghostcli");
  assert.equal(provider.alias, "ghcl");
  assert.equal(provider.name, "GhostCLI");
  assert.equal(provider.color, "#6366F1");
  assert.match(String(provider.website), /^https:\/\/ghostcli\.cloud/);
});

test("ghostcli resolves by alias ghcl and gcli", () => {
  const byGhcl = getProviderByAlias("ghcl") as unknown as Record<string, unknown> | null;
  assert.ok(byGhcl, "alias ghcl does not resolve");
  assert.equal(byGhcl.id, "ghostcli");

  const byGcli = getProviderByAlias("gcli") as unknown as Record<string, unknown> | null;
  assert.ok(byGcli, "alias gcli does not resolve");
  assert.equal(byGcli.id, "ghostcli");
});

test("ghostcli registry entry points at measured endpoints and models", async () => {
  const { REGISTRY } = await import("@omniroute/open-sse/config/providers/index.ts");
  const entry = REGISTRY.ghostcli as unknown as Record<string, unknown>;
  assert.ok(entry, "ghostcli missing from REGISTRY");
  assert.equal(entry.alias, "ghcl");
  assert.equal(entry.format, "openai");
  assert.equal(entry.authType, "apikey");
  assert.equal(entry.authHeader, "bearer");
  assert.equal(entry.executor, "ghostcli");
  assert.equal(entry.baseUrl, "https://ghostcli.cloud/v1/chat/completions");
  assert.equal(entry.responsesBaseUrl, "https://ghostcli.cloud/v1/responses");
  assert.equal(entry.messagesUrl, "https://ghostcli.cloud/v1/messages");
  assert.equal(entry.defaultContextLength, 1000000);
});

test("ghostcli models all feature 1,000,000 context window", async () => {
  const { REGISTRY } = await import("@omniroute/open-sse/config/providers/index.ts");
  const models = (
    REGISTRY.ghostcli as unknown as {
      models: Array<{ id: string; contextLength?: number; targetFormat?: string }>;
    }
  ).models;

  assert.ok(models.length >= 6, "Expected at least 6 primary models in ghostcli catalog");
  for (const m of models) {
    assert.equal(m.contextLength, 1000000, `Model ${m.id} should have 1M context window`);
  }

  const ids = new Set(models.map((m) => m.id));
  assert.ok(ids.has("claude-opus-5-5"), "missing claude-opus-5-5");
  assert.ok(ids.has("claude-opus-5.5"), "missing claude-opus-5.5 alias");
  assert.ok(ids.has("claude-sonnet-5"), "missing claude-sonnet-5");
  assert.ok(ids.has("claude-fable-5.1"), "missing claude-fable-5.1");
  assert.ok(ids.has("gpt-6-astra"), "missing gpt-6-astra");
  assert.ok(ids.has("z-ai/glm-5.3"), "missing z-ai/glm-5.3");
  assert.ok(ids.has("glm-5.3"), "missing glm-5.3 alias");
  assert.ok(ids.has("z-ai/glm-5.3-flash"), "missing z-ai/glm-5.3-flash");
  assert.ok(ids.has("glm-5.3-flash"), "missing glm-5.3-flash alias");
});

test("ghostcli routes claude models to native messagesUrl and gpt-6-astra to responses", async () => {
  const { GhostCliExecutor } = await import("@omniroute/open-sse/executors/ghostcli.ts");
  const executor = new GhostCliExecutor();

  // Test canonical names
  assert.equal(executor.buildUrl("claude-opus-5-5", true), "https://ghostcli.cloud/v1/messages");
  assert.equal(executor.buildUrl("gpt-6-astra", true), "https://ghostcli.cloud/v1/responses");
  assert.equal(executor.buildUrl("z-ai/glm-5.3", true), "https://ghostcli.cloud/v1/chat/completions");

  // Test short / prefixed aliases
  assert.equal(executor.buildUrl("ghcl/claude-opus-5.5", true), "https://ghostcli.cloud/v1/messages");
  assert.equal(executor.buildUrl("opus-5.5", true), "https://ghostcli.cloud/v1/messages");
  assert.equal(executor.buildUrl("ghcl/astra", true), "https://ghostcli.cloud/v1/responses");
  assert.equal(executor.buildUrl("glm-5.3", true), "https://ghostcli.cloud/v1/chat/completions");
  assert.equal(executor.buildUrl("glm-5.3-flash", true), "https://ghostcli.cloud/v1/chat/completions");
});

test("ghostcli transforms request model payload into canonical upstream model id", async () => {
  const { GhostCliExecutor } = await import("@omniroute/open-sse/executors/ghostcli.ts");
  const executor = new GhostCliExecutor();

  const transformedGlm = executor.transformRequest(
    "glm-5.3",
    { model: "glm-5.3", messages: [] },
    false,
    {} as any
  ) as any;
  assert.equal(transformedGlm.model, "z-ai/glm-5.3");

  const transformedOpus = executor.transformRequest(
    "ghcl/claude-opus-5.5",
    { model: "ghcl/claude-opus-5.5", messages: [] },
    false,
    {} as any
  ) as any;
  assert.equal(transformedOpus.model, "claude-opus-5-5");

  const transformedAstra = executor.transformRequest(
    "ghcl/astra",
    { model: "ghcl/astra", messages: [] },
    false,
    {} as any
  ) as any;
  assert.equal(transformedAstra.model, "gpt-6-astra");
});
