import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CallLogArtifact } from "../../src/lib/usage/callLogArtifacts.ts";
import type { CallLogArtifactWriteResult } from "../../src/lib/usage/callLogArtifacts.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-worker-failure-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const artifactWriter = await import("../../src/lib/usage/callLogArtifactWriter.ts");

test.after(async () => {
  await artifactWriter.closeCallLogArtifactWriter(0);
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("write_failed worker reply persists only a bounded private-overflow pointer stub", async () => {
  const diagnosticOverflow = {
    schema: "omni-diagnostic-overflow/v1" as const,
    traceId: "31234567-89ab-cdef-0123-456789abcdef",
    state: "complete" as const,
  };
  const artifact: CallLogArtifact = {
    schemaVersion: 5,
    summary: {
      id: "worker-failure\u0000request",
      timestamp: "2026-10-09T12:00:00.000Z",
      method: "POST",
      path: "/v1/responses?api_key=private-query-secret",
      status: 503,
      model: "antigravity/gemini-3.8-flash-high",
      requestedModel: "antigravity/gemini-3.8-flash-high",
      provider: "antigravity",
      account: "private-account@example.test",
      connectionId: "private-connection-id",
      duration: 10,
      tokens: {
        in: 1,
        out: 0,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: "chat",
      sourceFormat: "openai",
      targetFormat: "gemini",
      apiKeyId: "sk-private-key-id",
      apiKeyName: "private-key-name",
      correlationId: "corr-worker-failure-1",
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: { content: "private request body marker" },
    responseBody: { content: "private response body marker" },
    error: "upstream unavailable",
    pipeline: { diagnosticOverflow },
  };
  const beforeMetrics = artifactWriter.getCallLogArtifactWriterSnapshot();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => warnings.push(String(message ?? ""));

  let result: CallLogArtifactWriteResult | null;
  try {
    // The NUL in the original call-log ID makes the worker's normal artifact
    // path fail with `write_failed`; the safe stub builder removes it.
    result = await artifactWriter.writeCallArtifactAsync(artifact);
  } finally {
    console.warn = originalWarn;
  }

  const afterMetrics = artifactWriter.getCallLogArtifactWriterSnapshot();
  assert.ok(warnings.some((message) => message.includes("reason=write_failed")));
  assert.equal(afterMetrics.workerFailuresTotal, beforeMetrics.workerFailuresTotal + 1);
  assert.equal(afterMetrics.detailOmissionsTotal, beforeMetrics.detailOmissionsTotal + 1);
  assert.equal(afterMetrics.pointerFallbacksTotal, beforeMetrics.pointerFallbacksTotal + 1);
  assert.equal(
    afterMetrics.pointerFallbackFailuresTotal,
    beforeMetrics.pointerFallbackFailuresTotal
  );
  assert.equal(afterMetrics.diagnosticStubRefusalsTotal, beforeMetrics.diagnosticStubRefusalsTotal);
  assert.equal(afterMetrics.preparationRefusalsTotal, beforeMetrics.preparationRefusalsTotal);
  assert.ok(result?.diagnosticOverflowStub);
  const serialized = fs.readFileSync(path.join(TEST_DATA_DIR, "call_logs", result.relPath), "utf8");
  const saved = JSON.parse(serialized);
  assert.deepEqual(saved.pipeline.diagnosticOverflow, diagnosticOverflow);
  assert.equal(saved.pipeline.error.reason, "call_log_artifact_worker_failure");
  assert.equal(saved.summary.id, "worker-failure request");
  assert.equal(saved.summary.apiKeyId, null);
  assert.equal(saved.summary.apiKeyName, null);
  assert.equal(saved.summary.account, "-");
  assert.equal(saved.summary.connectionId, null);
  assert.equal(saved.summary.path, "/v1/responses");
  assert.match(saved.requestBody, /worker failed/);
  assert.doesNotMatch(
    serialized,
    /private request body|private response body|private-query-secret/
  );
});
