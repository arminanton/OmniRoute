import test from "node:test";
import assert from "node:assert/strict";
import { parseGeminiModelsList } from "../../src/lib/providerModels/geminiModelsParser.ts";
import { parseVertexPublisherModels } from "../../src/lib/providerModels/vertexPublisherModelsParser.ts";
import { discoverVertexModelsWithBearer, discoverVertexModelsWithApiKey } from "../../src/lib/providerModels/vertexModelDiscovery.ts";

test("Google supported actions and modalities do not advertise non-chat rows as chat", () => {
  const rows = parseGeminiModelsList({ models: [
    { name: "models/gemini-chat", supportedGenerationMethods: ["generateContent"] },
    { name: "models/text-embedding-005", supportedGenerationMethods: ["predict"] },
    { name: "models/rerank-v1", supportedGenerationMethods: ["predict"] },
    { name: "models/imagen-4", supportedGenerationMethods: ["predictLongRunning"] },
    { name: "models/veo-3", supportedGenerationMethods: ["predict"] },
    { name: "models/gemini-image-only", supportedGenerationMethods: ["generateContent"], outputModalities: ["IMAGE"] },
    { name: "models/gemini-live", supportedGenerationMethods: ["bidiGenerateContent"] },
    { name: "models/unknown", supportedGenerationMethods: ["inventedMethod"] },
  ] });
  assert.deepEqual(rows.map((m) => m.supportedEndpoints), [["chat"], ["embeddings"], ["rerank"], ["images"], ["videos"], ["images"]]);
});

test("Vertex publisher parser normalizes project/region and keeps publisher boundaries", () => {
  const rows = parseVertexPublisherModels({ publisherModels: [
    { name: "projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6", supportedActions: { viewRestApi: {} } },
    { name: "publishers/google/models/gemini-pro" },
    { name: "unknown-product", supportedActions: { requestAccess: {} } },
    null,
  ] }, "anthropic");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "claude-sonnet-4-6");
  assert.equal(rows[0].targetFormat, "claude");
  assert.deepEqual(parseVertexPublisherModels({}, "meta"), []);
});

test("Vertex Bearer uses 300-entry publisher pages and preserves partial results", async () => {
  const urls: URL[] = [];
  const result = await discoverVertexModelsWithBearer({ bearerToken: "fixture", fetchImpl: async (url, init) => {
    const parsed = new URL(url); urls.push(parsed);
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture");
    assert.equal(parsed.hostname, "aiplatform.googleapis.com");
    assert.equal(parsed.searchParams.get("pageSize"), "300");
    if (parsed.pathname.includes("anthropic")) return Response.json({ publisherModels: [{ name: "publishers/anthropic/models/claude-sonnet-4-6" }] });
    if (parsed.searchParams.has("pageToken")) return new Response(null, { status: 503 });
    return Response.json({ publisherModels: [{ name: "publishers/google/models/gemini-3.7-flash" }], nextPageToken: "opaque + /" });
  } });
  assert.equal(urls.length, 3);
  assert.equal(urls[1].searchParams.get("pageToken"), "opaque + /");
  assert.deepEqual(result.models.map((m) => m.id), ["gemini-3.7-flash", "claude-sonnet-4-6"]);
  assert.ok(result.warning);
});

test("Vertex Bearer bounds repeated continuation tokens", async () => {
  let calls = 0;
  const result = await discoverVertexModelsWithBearer({ bearerToken: "fixture", fetchImpl: async () => {
    calls++;
    return Response.json({ publisherModels: [], nextPageToken: "same" });
  } });
  assert.equal(calls, 4);
  assert.ok(result.unavailable);
});

test("Vertex Express key validates on Vertex, stays out of URLs and returns curated catalog", async () => {
  const curated = [{ id: "gemini-3.7-flash", supportedEndpoints: ["chat"] }];
  const result = await discoverVertexModelsWithApiKey({ apiKey: "fixture-secret", curatedModels: curated, fetchImpl: async (url, init) => {
    assert.equal(new URL(url).hostname, "aiplatform.googleapis.com");
    assert.equal(url.includes("fixture-secret"), false);
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), "fixture-secret");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    return Response.json({});
  } });
  assert.deepEqual(result.models, curated);
  assert.ok(result.warning);
  const rejected = await discoverVertexModelsWithApiKey({ apiKey: "fixture", curatedModels: curated, fetchImpl: async () => new Response(null, { status: 403 }) });
  assert.deepEqual(rejected.models, []);
  assert.equal(rejected.failureStatus, 403);
});
