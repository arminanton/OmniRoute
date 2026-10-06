import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-provider-models-length-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const providerModelsRoute =
  await import("../../src/app/api/v1/providers/[provider]/models/route.ts");

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("filtered provider models response drops stale body headers and remains readable", async (t) => {
  const upstreamBody = JSON.stringify({
    object: "list",
    data: [
      { id: "openai/gpt-4o", owned_by: "openai", root: "gpt-4o" },
      { id: "anthropic/claude-3-7-sonnet", owned_by: "anthropic" },
    ],
  });
  const upstreamResponse = new Response(upstreamBody, {
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(upstreamBody).byteLength + 512),
      "content-encoding": "gzip",
      "content-range": "bytes 0-999/1000",
      etag: '"full-catalog"',
      "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT",
      "content-md5": "stale-md5",
      digest: "sha-256=stale",
      "content-digest": "sha-256=:stale:",
      "repr-digest": "sha-256=:stale:",
      "access-control-allow-origin": "https://app.example",
      "access-control-expose-headers": "X-Request-Id",
      vary: "Origin",
      "x-request-id": "upstream-request",
    },
  });
  t.mock.method(
    providerModelsRoute.providerModelsCatalog,
    "getUnifiedModelsResponse",
    async () => upstreamResponse
  );

  const response = await providerModelsRoute.GET(
    new Request("http://localhost/api/v1/providers/openai/models"),
    { params: Promise.resolve({ provider: "openai" }) }
  );

  assert.equal(response.status, 200);
  const bodyText = await response.text();
  assert.equal(
    bodyText,
    JSON.stringify({
      object: "list",
      data: [{ id: "gpt-4o", owned_by: "openai", root: "gpt-4o", parent: null }],
    })
  );
  assert.equal(response.headers.get("content-type")?.startsWith("application/json"), true);
  for (const header of [
    "content-length",
    "content-encoding",
    "content-range",
    "etag",
    "last-modified",
    "content-md5",
    "digest",
    "content-digest",
    "repr-digest",
  ]) {
    assert.equal(
      response.headers.get(header),
      null,
      `${header} must not describe the old catalog body`
    );
  }
  assert.equal(response.headers.get("access-control-allow-origin"), "https://app.example");
  assert.equal(response.headers.get("access-control-expose-headers"), "X-Request-Id");
  assert.equal(response.headers.get("vary"), "Origin");
  assert.equal(response.headers.get("x-request-id"), "upstream-request");
});
