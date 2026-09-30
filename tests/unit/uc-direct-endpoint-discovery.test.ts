import test from "node:test";
import assert from "node:assert/strict";

import { ucDirectProvider } from "../../open-sse/config/providers/registry/uc-direct/index.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import {
  assembleProviderModelsHeaders,
  PROVIDER_MODELS_CONFIG,
} from "../../src/app/api/providers/[id]/models/discovery/providerModelsConfig.ts";

test("UC Direct uses the full metered chat endpoint and a separate public catalog", () => {
  assert.equal(ucDirectProvider.baseUrl, "https://api.uncensored.com/api/v1/chat/completions");
  assert.equal(ucDirectProvider.modelsUrl, "https://api.uncensored.com/api/v1/models");
  assert.equal(ucDirectProvider.executor, "default");
  assert.equal(ucDirectProvider.format, "openai");
  assert.equal(ucDirectProvider.authType, "apikey");
  assert.equal(ucDirectProvider.authHeader, "x-api-key");
});

test("UC Direct and its alias remain separate from Persona", () => {
  for (const prefix of ["uc-direct", "ucd"]) {
    assert.equal(getRegistryEntry(prefix)?.id, "uc-direct");
  }
  for (const prefix of ["uc", "ucn", "uc-persona"]) {
    assert.equal(getRegistryEntry(prefix)?.id, "uc");
    assert.notEqual(getRegistryEntry(prefix), ucDirectProvider);
  }
});

test("UC Direct public discovery never attaches Developer or Persona credentials", () => {
  const config = PROVIDER_MODELS_CONFIG["uc-direct"];
  assert.ok(config);
  assert.equal(config.url, ucDirectProvider.modelsUrl);
  assert.equal(config.method, "GET");
  assert.equal(config.authHeader, undefined);
  assert.equal(config.authQuery, undefined);
  for (const token of ["", "fixture-developer-key", "fixture-persona-token"]) {
    assert.deepEqual(
      assembleProviderModelsHeaders(config, token, {
        apiKey: "fixture-developer-key",
        accessToken: "fixture-persona-token",
        providerSpecificData: { ucClientCookie: "fixture-persona-cookie" },
      }),
      { "Content-Type": "application/json" }
    );
  }
});

test("UC Direct discovery accepts public catalog envelopes without rewriting model IDs", () => {
  const config = PROVIDER_MODELS_CONFIG["uc-direct"];
  const models = [
    { id: "deepseek-r1", object: "model" },
    { id: "claude-sonnet-4.5", object: "model" },
  ];
  assert.deepEqual(config.parseResponse({ object: "list", data: models }), models);
  assert.deepEqual(config.parseResponse({ models }), models);
  assert.deepEqual(config.parseResponse({ data: [] }), []);
  assert.deepEqual(config.parseResponse({}), []);
});
