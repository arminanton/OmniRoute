import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeCodeAssistDiscovery,
  normalizeCodeAssistCatalogReply,
} from "../../../open-sse/services/codeAssistDiscovery.ts";
import {
  buildCodeAssistCountTokensRequest,
  buildCodeAssistReadOnlyRpcPlan,
  CODE_ASSIST_SURFACES,
  parseCodeAssistCountTokensResponse,
} from "../../../open-sse/services/codeAssistRpc.ts";
import {
  filterUserCallableAntigravityModels,
  mapAntigravityModelForClient,
} from "../../../src/app/api/providers/[id]/models/discovery/normalizers.ts";

test("native ModelDetails fields preserve true/false capabilities and account windows", () => {
  const models = normalizeCodeAssistDiscovery({
    models: {
      "gemini-3.8-flash": {
        displayName: "Native flash",
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        supportsImages: true,
        supportsThinking: false,
        supportsVideo: true,
        supportsPdf: false,
        supportedMimeTypes: { "image/png": true, "application/pdf": false },
      },
      "gemini-3.7-pro": { disabled: true, maxTokens: 1000000 },
    },
    defaultAgentModelId: "gemini-3.8-flash",
    tabModelIds: ["gemini-3.8-flash"],
  });
  assert.equal(models[0].inputTokenLimit, 1048576);
  assert.equal(models[0].outputTokenLimit, 65536);
  assert.equal(models[0].supportsThinking, false);
  assert.deepEqual(models[0].discoveryRoles, ["tab", "agent"]);
  assert.deepEqual(models[0].supportedMimeTypes, { "image/png": true, "application/pdf": false });
  assert.deepEqual(
    filterUserCallableAntigravityModels(models, "agy").map((m) => m.id),
    ["gemini-3.8-flash"]
  );
  const projected = mapAntigravityModelForClient(models[0], "agy");
  assert.equal(projected.supportsVision, true);
  assert.equal(projected.supportsThinking, false);
  assert.equal(projected.outputTokenLimit, 65536);
});

test("unknown and malformed limits stay unknown; snake-case flags are supported", () => {
  const models = normalizeCodeAssistDiscovery({
    models: {
      "gemini-unknown": {
        max_tokens: -1,
        max_output_tokens: "65536",
        supports_images: false,
        supports_thinking: true,
      },
      "invalid-row": null,
      "gemini-internal": { is_internal: true },
    },
  });
  assert.equal(models.length, 2);
  assert.equal(models[0].inputTokenLimit, undefined);
  assert.equal(models[0].outputTokenLimit, undefined);
  assert.equal(models[0].supportsImages, false);
  assert.equal(models[0].supportsThinking, true);
  assert.equal(models[1].isInternal, true);
});

test("legacy arrays deduplicate identifiers and reject control bytes", () => {
  const models = normalizeCodeAssistDiscovery({
    models: [
      { id: "gemini-a", inputTokenLimit: 120000, outputTokenLimit: 8000 },
      { id: "gemini-a", inputTokenLimit: 1 },
      { id: "bad\nheader" },
    ],
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].inputTokenLimit, 120000);
});

test("CCPA countTokens wire shape includes caller tools without execution", () => {
  const body = buildCodeAssistCountTokensRequest("gemini-3.8-flash", {
    contents: [{ role: "user", parts: [{ text: "fixture" }] }],
    tools: [{ functionDeclarations: [{ name: "external", parameters: { type: "OBJECT" } }] }],
  });
  assert.equal(body.request.model, "gemini-3.8-flash");
  assert.equal("project" in body, false);
  const plan = buildCodeAssistReadOnlyRpcPlan("cloud-code", "countTokens", body);
  assert.equal(plan.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:countTokens");
  assert.equal(parseCodeAssistCountTokensResponse({ totalTokens: 123 }), 123);
  assert.throws(() => parseCodeAssistCountTokensResponse({ totalTokens: -1 }));
  assert.throws(() => parseCodeAssistCountTokensResponse({ totalTokens: 2147483648 }));
  assert.throws(() =>
    buildCodeAssistCountTokensRequest("gemini-a", {
      contents: [],
      cachedContent: "foreign-resource",
    })
  );
});

test("unverified native AI Code, local SDK and arbitrary origins remain fail closed", () => {
  for (const surface of [
    "consumer-ai-code",
    "business-ai-code",
    "antigravity-local-sdk",
  ] as const) {
    assert.throws(() => buildCodeAssistReadOnlyRpcPlan(surface, "fetchAvailableModels", {}));
  }
  assert.throws(() =>
    buildCodeAssistReadOnlyRpcPlan(
      "cloud-code",
      "fetchAvailableModels",
      {},
      "https://unapproved.example"
    )
  );
  assert.equal(CODE_ASSIST_SURFACES["consumer-ai-code"].explicitCacheReference, "not-in-request");
  assert.equal(CODE_ASSIST_SURFACES["antigravity-local-sdk"].callerTools, "runtime-tool-runner");
});

test("authoritative empty/disabled native catalog differs from unavailable metadata", () => {
  assert.deepEqual(normalizeCodeAssistCatalogReply({ models: {} }), []);
  assert.deepEqual(normalizeCodeAssistCatalogReply({ models: [] }), []);
  assert.equal(normalizeCodeAssistCatalogReply({ error: "provider unavailable" }), null);
  assert.equal(normalizeCodeAssistCatalogReply({ models: { malformed: null } }), null);
  const disabled = normalizeCodeAssistCatalogReply({
    models: { "gemini-3.8-flash": { disabled: true } },
  });
  assert(disabled);
  assert.deepEqual(filterUserCallableAntigravityModels(disabled, "agy"), []);
});
