import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-dedup-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const ORIGINAL_PIPELINE_MAX_KB = process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;

const { CALL_LOGS_DIR, readCallArtifact, writeCallArtifact } =
  await import("../../src/lib/usage/callLogArtifacts.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { closeCallLogArtifactWriter } = await import("../../src/lib/usage/callLogArtifactWriter.ts");

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

  assert.equal(storedJson.schemaVersion, 6);
  assert.equal(storedJson.requestBodyRef, "pipeline.clientRawRequest.body");
  assert.equal(storedJson.responseBodyRef, "pipeline.clientResponse.body");
  assert.equal(Object.hasOwn(storedJson, "requestBody"), false);
  assert.equal(Object.hasOwn(storedJson, "responseBody"), false);
  assert.deepEqual(roundTripped.requestBody, requestBody);
  assert.deepEqual(roundTripped.responseBody, responseBody);
  assert.equal(Object.hasOwn(roundTripped, "requestBodyRef"), false);
  assert.equal(Object.hasOwn(roundTripped, "responseBodyRef"), false);
  const legacyBytes = Buffer.byteLength(JSON.stringify(input));
  assert.ok(sizeBytes <= 512 * 1024, "the deduplicated artifact should fit the default 512 KiB cap");
  assert.ok(
    legacyBytes - sizeBytes > 450_000,
    `the on-disk artifact should omit the duplicate payload copies (saved ${legacyBytes - sizeBytes} bytes)`
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

test("saveCallLog reserves and protects a shared client request body only once", async () => {
  const requestBody = {
    model: "codex/gpt-6.1-sol",
    input: [{ role: "user", content: "shared request body ".repeat(20_000) }],
  };
  const responseBody = { id: "resp_saved", output: [{ type: "message", content: "done" }] };
  process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "512";
  await callLogs.saveCallLog({
    id: "dedup-save-call-log",
    timestamp: new Date().toISOString(),
    method: "POST",
    path: "/v1/responses",
    status: 200,
    model: requestBody.model,
    provider: "codex",
    requestBody,
    responseBody,
    pipelinePayloads: {
      clientRawRequest: {
        endpoint: "/v1/responses",
        headers: {},
        body: structuredClone(requestBody),
      },
      clientResponse: {
        timestamp: new Date().toISOString(),
        body: structuredClone(responseBody),
      },
    },
  });

  const detail = await callLogs.getCallLogById("dedup-save-call-log");
  assert.ok(detail?.artifactRelPath);
  assert.equal(detail?.hasRequestBody, true);
  assert.equal(detail?.hasResponseBody, true);
  assert.deepEqual(detail?.requestBody, requestBody);
  assert.deepEqual(detail?.responseBody, responseBody);
  const diskArtifact = JSON.parse(
    fs.readFileSync(path.join(CALL_LOGS_DIR!, detail.artifactRelPath), "utf8")
  ) as Record<string, unknown>;
  assert.equal(diskArtifact.requestBodyRef, "pipeline.clientRawRequest.body");
  assert.equal(diskArtifact.responseBodyRef, "pipeline.clientResponse.body");
  assert.equal(Object.hasOwn(diskArtifact, "requestBody"), false);
  assert.equal(Object.hasOwn(diskArtifact, "responseBody"), false);
});

test.after(async () => {
  await closeCallLogArtifactWriter();
  resetDbInstance();
  if (ORIGINAL_PIPELINE_MAX_KB === undefined) delete process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
  else process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = ORIGINAL_PIPELINE_MAX_KB;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
