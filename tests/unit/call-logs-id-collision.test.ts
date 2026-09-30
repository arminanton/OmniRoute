import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-call-log-identity-"));
process.env.DATA_DIR = dataDir;
process.env.CALL_LOG_RETENTION_DAYS = "3650";

const core = await import("../../src/lib/db/core.ts");
const logs = await import("../../src/lib/usage/callLogs.ts");
const artifacts = await import("../../src/lib/usage/callLogArtifacts.ts");
const { runWithCallLogApiKeyContext, getCallLogApiKeyContext } =
  await import("../../src/lib/usage/callLogApiKeyContext.ts");
const { buildCallLogAttemptId } = await import("../../src/shared/utils/callLogAttemptId.ts");

const timestamp = "2026-09-29T12:00:00.000Z";

function entry(id: string, correlationId: string, marker: string) {
  return {
    id,
    timestamp,
    correlationId,
    status: 200,
    model: "fixture-model",
    provider: "fixture-provider",
    requestBody: { messages: [{ role: "user", content: marker }] },
    responseBody: { marker },
    pipelinePayloads: { clientResponse: { body: { marker } } },
  };
}

function artifactBytes(relativePath: string | null): string {
  assert.ok(relativePath);
  return fs.readFileSync(path.join(dataDir, "call_logs", relativePath), "utf8");
}

test.after(async () => {
  await logs.closeCallLogSaves(10_000);
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("two saves in one bound attempt keep separate rows and immutable artifacts", async () => {
  const logicalId = "same-context-request";
  const attemptId = buildCallLogAttemptId(logicalId, "attempt-1");
  await runWithCallLogApiKeyContext({ apiKeyId: "key-one", apiKeyName: "Key One" }, async () => {
    await logs.saveCallLog(entry(attemptId, logicalId, "first"));
    const first = await logs.getCallLogById(attemptId);
    assert.ok(first);
    const firstBytes = artifactBytes(first.artifactRelPath);

    await logs.saveCallLog(entry(attemptId, logicalId, "second"));
    const rows = await logs.getCallLogs({ correlationId: logicalId });
    assert.equal(
      rows.length,
      2,
      "each save must insert its own row even with identical timestamps"
    );
    assert.equal(new Set(rows.map((row) => row.id)).size, 2);
    assert.equal(new Set(rows.map((row) => row.artifactRelPath)).size, 2);
    const second = rows.find((row) => row.id !== first.id);
    assert.ok(second);
    assert.equal(
      artifactBytes(first.artifactRelPath),
      firstBytes,
      "first artifact must not change"
    );

    for (let repeat = 0; repeat < 3; repeat++) {
      const physical = await logs.getCallLogById(first.id);
      assert.deepEqual(physical?.responseBody, { marker: "first" });
      assert.deepEqual((await logs.getCallLogById(second.id))?.responseBody, { marker: "second" });
      const latest = await logs.getCallLogById(logicalId);
      assert.equal(latest?.id, second.id, "logical lookup uses insertion order for timestamp ties");
      assert.equal(latest.apiKeyId, "key-one");
      assert.equal(latest.apiKeyName, "Key One");
    }
  });
  assert.equal(getCallLogApiKeyContext(), null);
});

test("concurrent bound contexts with the same caller id do not cross attribution or payloads", async () => {
  const logicalId = "concurrent-shared-request";
  const attemptId = buildCallLogAttemptId(logicalId, "same-attempt");
  await Promise.all(
    ["alpha", "beta"].map((name) =>
      runWithCallLogApiKeyContext({ apiKeyId: `key-${name}`, apiKeyName: name }, async () => {
        await Promise.resolve();
        await Promise.all(
          [1, 2].map((index) => logs.saveCallLog(entry(attemptId, logicalId, `${name}-${index}`)))
        );
        assert.equal(getCallLogApiKeyContext()?.apiKeyId, `key-${name}`);
      })
    )
  );
  const rows = await logs.getCallLogs({ correlationId: logicalId });
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map((row) => row.id)).size, 4);
  assert.equal(new Set(rows.map((row) => row.artifactRelPath)).size, 4);
  const markers = new Set<string>();
  for (const row of rows) {
    const detail = await logs.getCallLogById(row.id);
    const body = detail?.responseBody as { marker: string };
    markers.add(body.marker);
    assert.equal(row.apiKeyId, `key-${body.marker.split("-")[0]}`);
    assert.equal(row.apiKeyName, body.marker.split("-")[0]);
    const artifact = JSON.parse(artifactBytes(row.artifactRelPath));
    assert.equal(artifact.summary.id, row.id);
    assert.equal(artifact.summary.apiKeyId, row.apiKeyId);
    assert.deepEqual(artifact.responseBody, body);
  }
  assert.deepEqual([...markers].sort(), ["alpha-1", "alpha-2", "beta-1", "beta-2"]);
  assert.equal(getCallLogApiKeyContext(), null);
});

test("legacy exact and composite IDs keep immutable detail and artifact links", async () => {
  const logicalId = "legacy-request";
  const oldId = buildCallLogAttemptId(logicalId, "old-attempt");
  const relPath = artifacts.buildArtifactRelativePath(timestamp, oldId);
  const absPath = path.join(dataDir, "call_logs", relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const serialized = JSON.stringify({
    schemaVersion: 5,
    summary: { id: oldId },
    requestBody: { legacy: "request" },
    responseBody: { legacy: "response" },
    error: null,
  });
  fs.writeFileSync(absPath, serialized);
  core
    .getDbInstance()
    .prepare(
      `
    INSERT INTO call_logs (id, timestamp, status, correlation_id, detail_state, artifact_relpath)
    VALUES (?, ?, 200, ?, 'ready', ?)
  `
    )
    .run(oldId, timestamp, logicalId, relPath);

  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal((await logs.getCallLogById(logicalId))?.id, oldId);
    assert.deepEqual((await logs.getCallLogById(oldId))?.responseBody, { legacy: "response" });
  }
  await logs.saveCallLog(entry(oldId, logicalId, "new-save"));
  assert.equal(fs.readFileSync(absPath, "utf8"), serialized);
  assert.deepEqual((await logs.getCallLogById(oldId))?.responseBody, { legacy: "response" });
  const rows = await logs.getCallLogs({ correlationId: logicalId });
  assert.equal(rows.length, 2);
  const newer = rows.find((row) => row.id !== oldId);
  assert.ok(newer);
  assert.equal((await logs.getCallLogById(logicalId))?.id, newer.id);
  assert.deepEqual((await logs.getCallLogById(newer.id))?.responseBody, { marker: "new-save" });
});

test("logical lookup escapes SQL wildcards and exact legacy IDs win over group matches", async () => {
  const logicalId = "literal_%_request";
  await logs.saveCallLog(entry(buildCallLogAttemptId(logicalId, "one"), "escaped-one", "correct"));
  await logs.saveCallLog(
    entry(buildCallLogAttemptId("literal_XX_request", "two"), "escaped-two", "wrong")
  );
  assert.deepEqual((await logs.getCallLogById(logicalId))?.responseBody, { marker: "correct" });
  assert.equal(await logs.getCallLogById("literal"), null);
  core
    .getDbInstance()
    .prepare(
      `
    INSERT INTO call_logs (id, timestamp, status, detail_state) VALUES (?, ?, 204, 'none')
  `
    )
    .run(logicalId, timestamp);
  assert.equal((await logs.getCallLogById(logicalId))?.id, logicalId);
  assert.equal((await logs.getCallLogById(logicalId))?.status, 204);
});

test("duplicate no-log saves remain distinct without payload artifacts", async () => {
  const logicalId = "no-log-repeat";
  const attemptId = buildCallLogAttemptId(logicalId, "one");
  await Promise.all(
    [1, 2].map((index) =>
      logs.saveCallLog({
        ...entry(attemptId, logicalId, String(index)),
        noLog: true,
      })
    )
  );
  const rows = await logs.getCallLogs({ correlationId: logicalId });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.detailState, "none");
    assert.equal(row.artifactRelPath, null);
    assert.equal(row.hasRequestBody, false);
    assert.equal(row.hasResponseBody, false);
    assert.equal(row.hasPipelineDetails, false);
  }
});

test("persistAttemptLogs can save twice from the same captured dispatch context, then retry", async () => {
  const { persistAttemptLogs } = await import("../../open-sse/handlers/chatCore/attemptLogging.ts");
  const logicalId = "captured-dispatch-request";
  const ctx = {
    traceId: "dispatch-trace",
    provider: "fixture-provider",
    connectionId: null,
    model: "fixture-model",
    skillRequestId: "dispatch-skill",
    detailedLoggingEnabled: true,
    reqLogger: null,
    pendingRequestId: logicalId,
    callLogId: buildCallLogAttemptId(logicalId, "dispatch-skill"),
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    requestedModel: "fixture-model",
    credentials: null,
    startTime: Date.now(),
    body: { messages: [{ role: "user", content: "fixture" }] },
    sourceFormat: "openai",
    targetFormat: "openai",
    comboName: "fixture-combo",
    comboStepId: "fixture-step",
    comboExecutionKey: "fixture-execution",
    tokensCompressed: 0,
    apiKeyInfo: { id: "dispatch-key", name: "Dispatch Key" },
    noLogEnabled: false,
    correlationId: logicalId,
  };
  const boundSave = (status: number, marker: string) =>
    persistAttemptLogs({ status, responseBody: { marker } }, ctx);
  boundSave(502, "first-failure");
  boundSave(502, "second-failure");
  assert.equal(await logs.waitForCallLogSaves(10_000), true);
  const failures = await logs.getCallLogs({ correlationId: logicalId });
  assert.equal(failures.length, 2);
  persistAttemptLogs(
    { status: 200, responseBody: { marker: "retry-success" } },
    {
      ...ctx,
      callLogId: buildCallLogAttemptId(logicalId, "retry-skill"),
      skillRequestId: "retry-skill",
    }
  );
  assert.equal(await logs.waitForCallLogSaves(10_000), true);
  const rows = await logs.getCallLogs({ correlationId: logicalId });
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.id)).size, 3);
  assert.deepEqual((await logs.getCallLogById(logicalId))?.responseBody, {
    marker: "retry-success",
  });
  for (const row of rows) {
    assert.equal(row.comboName, "fixture-combo");
    assert.equal(row.comboExecutionKey, "fixture-execution");
    assert.equal(row.apiKeyId, "dispatch-key");
    assert.equal((await logs.getCallLogById(row.id))?.detailState, "ready");
  }
});

test("both detail APIs resolve legacy composite links and new physical links repeatedly", async () => {
  const { GET: getUsageDetail } = await import("../../src/app/api/usage/call-logs/[id]/route.ts");
  const { GET: getLogDetail } = await import("../../src/app/api/logs/[id]/route.ts");
  const logicalId = "api-detail-request";
  const oldId = buildCallLogAttemptId(logicalId, "legacy");
  core
    .getDbInstance()
    .prepare(
      `
    INSERT INTO call_logs (id, timestamp, status, correlation_id, detail_state)
    VALUES (?, ?, 201, ?, 'none')
  `
    )
    .run(oldId, timestamp, logicalId);
  await logs.saveCallLog(entry(buildCallLogAttemptId(logicalId, "new"), logicalId, "api-body"));
  const rows = await logs.getCallLogs({ correlationId: logicalId });
  const newer = rows.find((row) => row.id !== oldId);
  assert.ok(newer);
  for (const handler of [getUsageDetail, getLogDetail]) {
    for (let repeat = 0; repeat < 2; repeat++) {
      // Direct in-process calls without a Request are trusted by requireManagementAuth.
      const oldResponse = await handler(undefined, { params: Promise.resolve({ id: oldId }) });
      assert.equal(oldResponse.status, 200);
      assert.equal((await oldResponse.json()).id, oldId);
      for (const id of [logicalId, newer.id]) {
        const response = await handler(undefined, { params: Promise.resolve({ id }) });
        assert.equal(response.status, 200);
        const detail = await response.json();
        assert.equal(detail.id, newer.id);
        assert.deepEqual(detail.responseBody, { marker: "api-body" });
      }
    }
  }
});

test("separate failed-save artifacts keep existing credential and error sanitization", async () => {
  const logicalId = "sanitized-duplicate";
  const callerId = buildCallLogAttemptId(logicalId, "same");
  for (const marker of ["first", "second"]) {
    await logs.saveCallLog({
      ...entry(callerId, logicalId, marker),
      status: 502,
      error: "upstream Authorization: Bearer fixture-secret-value",
      requestBody: { headers: { authorization: "Bearer fixture-request-secret" }, marker },
      responseBody: {
        error: { message: "upstream Authorization: Bearer fixture-response-secret" },
      },
    });
  }
  const rows = await logs.getCallLogs({ correlationId: logicalId });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    const bytes = artifactBytes(row.artifactRelPath);
    assert.doesNotMatch(bytes, /fixture-(?:secret-value|request-secret|response-secret)/);
    assert.match(bytes, /REDACTED/);
    const detail = await logs.getCallLogById(row.id);
    assert.equal(detail?.status, 502);
    assert.doesNotMatch(String(detail?.error), /fixture-secret-value/);
  }
});
