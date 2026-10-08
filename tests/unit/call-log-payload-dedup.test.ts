import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-dedup-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { CALL_LOGS_DIR, readCallArtifact, writeCallArtifact } =
  await import("../../src/lib/usage/callLogArtifacts.ts");

function artifact(
  requestBody: unknown,
  responseBody: unknown,
  options: { schemaVersion?: 5 | 6; clientRequestBody?: unknown; clientResponseBody?: unknown } = {}
) {
  return {
    schemaVersion: options.schemaVersion ?? 6,
    summary: {
      id: `dedup-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      method: "POST",
      path: "/v1/responses",
      status: 200,
      model: "codex/gpt-6.1-sol",
      requestedModel: "codex/gpt-6.1-sol",
      provider: "codex",
      account: "test",
      connectionId: null,
      duration: 1,
      tokens: {
        in: 1,
        out: 1,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: null,
      sourceFormat: "openai-responses",
      targetFormat: "openai-responses",
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody,
    responseBody,
    error: null,
    pipeline: {
      clientRawRequest: {
        endpoint: "/v1/responses",
        headers: {},
        body: options.clientRequestBody ?? requestBody,
      },
      clientResponse: {
        timestamp: new Date().toISOString(),
        body: options.clientResponseBody ?? responseBody,
      },
    },
  };
}

function writeAndRead(input: ReturnType<typeof artifact>) {
  const relativePath = `payload-dedup/${input.summary.id}.json`;
  const writeResult = writeCallArtifact(input as never, relativePath);
  assert.ok(writeResult, "artifact should be written");
  const filePath = path.join(CALL_LOGS_DIR!, relativePath);
  const storedJson = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const result = readCallArtifact(relativePath);
  assert.equal(result.state, "ready");
  assert.ok(result.artifact);
  return { storedJson, artifact: result.artifact, sizeBytes: writeResult.sizeBytes };
}

test("identical top-level and pipeline request/response payloads are stored once and expanded on read", () => {
  const requestBody = {
    model: "codex/gpt-6.1-sol",
    input: [{ role: "user", content: "repeated request content ".repeat(20_000) }],
  };
  const responseBody = {
    id: "resp_123",
    output: [{ type: "message", content: [{ type: "output_text", text: "generated text" }] }],
  };
  const input = artifact(requestBody, responseBody);
  const { storedJson, artifact: roundTripped, sizeBytes } = writeAndRead(input);

  assert.equal(storedJson.requestBodyRef, "pipeline.clientRawRequest.body");
  assert.equal(storedJson.responseBodyRef, "pipeline.clientResponse.body");
  assert.equal(Object.hasOwn(storedJson, "requestBody"), false);
  assert.equal(Object.hasOwn(storedJson, "responseBody"), false);
  assert.deepEqual(roundTripped.requestBody, requestBody);
  assert.deepEqual(roundTripped.responseBody, responseBody);
  assert.equal(Object.hasOwn(roundTripped, "requestBodyRef"), false);
  assert.equal(Object.hasOwn(roundTripped, "responseBodyRef"), false);
  assert.ok(
    sizeBytes < Buffer.byteLength(JSON.stringify(input)) - 100_000,
    "the on-disk artifact should omit both duplicate payload copies"
  );
});

test("different payloads and legacy schema-v5 artifacts retain their original fields", () => {
  const requestBody = { input: "top-level request" };
  const responseBody = { output: "top-level response" };
  const { storedJson, artifact: roundTripped } = writeAndRead(
    artifact(requestBody, responseBody, {
      schemaVersion: 5,
      clientRequestBody: { input: "different pipeline request" },
      clientResponseBody: { output: "different pipeline response" },
    })
  );

  assert.equal(Object.hasOwn(storedJson, "requestBodyRef"), false);
  assert.equal(Object.hasOwn(storedJson, "responseBodyRef"), false);
  assert.deepEqual(roundTripped.requestBody, requestBody);
  assert.deepEqual(roundTripped.responseBody, responseBody);
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
