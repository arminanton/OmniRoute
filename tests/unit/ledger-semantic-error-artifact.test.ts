import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "omni-semantic-artifact-"));
process.env.DATA_DIR = dir;
const { writeCallArtifact, readCallArtifact } =
  await import("../../src/lib/usage/callLogArtifacts.ts");

test.after(() => rmSync(dir, { recursive: true, force: true }));
test("oversized history retains semantic native failure and traceheaders despite wire200 and no streamchunks", () => {
  const message =
    "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
  const nativeError = {
    message,
    type: "invalid_request_error",
    code: "bad_gateway",
    requestId: "req_fixture",
    wireStatus: 200,
    authorization: "Bearer fixture-secret-never-log",
  };
  const artifact = {
    schemaVersion: 5 as const,
    summary: {
      id: "semantic-fixture",
      timestamp: "2026-10-06T12:00:00.000Z",
      method: "POST",
      path: "/v1/responses",
      status: 502,
      model: "test-model",
      requestedModel: null,
      provider: "codex",
      account: "test-account",
      connectionId: null,
      duration: 10,
      tokens: {
        in: 0,
        out: 0,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: "chat",
      sourceFormat: "openai-responses",
      targetFormat: "openai-responses",
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: { history: "x".repeat(900000) },
    responseBody: { error: { message } },
    error: message,
    pipeline: {
      providerRequest: { body: { history: "x".repeat(900000) } },
      error: { message, nativeError },
      providerResponse: {
        status: 200,
        statusText: "OK",
        headers: {
          "x-request-id": "req_fixture",
          authorization: "Bearer fixture-secret-never-log",
        },
        body: { error: nativeError, wireStatus: 200 },
      },
    },
  };
  const written = writeCallArtifact(artifact)!;
  assert.ok(written);
  const saved = readCallArtifact(written.relPath).artifact!;
  assert.equal(saved.pipeline?.providerResponse?.status, 200);
  assert.equal(saved.pipeline?.providerResponse?.wireStatus, 200);
  const error = saved.pipeline?.error?.nativeError as Record<string, unknown>;
  assert.equal(error.message, message);
  assert.equal(error.code, "bad_gateway");
  assert.equal(error.type, "invalid_request_error");
  assert.equal(error.requestId, "req_fixture");
  assert.ok(!JSON.stringify(saved).includes("fixture-secret-never-log"));
  assert.ok(!JSON.stringify(saved).includes("x".repeat(1000)));
});
