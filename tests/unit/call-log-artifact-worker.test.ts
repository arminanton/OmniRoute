import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallLogArtifact } from "../../src/lib/usage/callLogArtifacts.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-worker-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const {
  writeCallArtifactAsync,
  closeCallLogArtifactWriter,
  resolveCallLogArtifactWorker,
  estimateCallLogArtifactFootprint,
  reserveCallLogArtifactPreparation,
  releaseCallLogArtifactPreparation,
  writeDiagnosticOverflowStubAsync,
} = await import("../../src/lib/usage/callLogArtifactWriter.ts");

test.after(async () => {
  await closeCallLogArtifactWriter();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function buildArtifact(id: string): CallLogArtifact {
  return {
    schemaVersion: 5 as const,
    summary: {
      id,
      timestamp: "2026-08-11T12:34:56.789Z",
      method: "POST",
      path: "/v1/chat/completions",
      status: 200,
      model: "test-model",
      requestedModel: null,
      provider: "test-provider",
      account: "test-account",
      connectionId: null,
      duration: 10,
      tokens: {
        in: 1,
        out: 2,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: "chat",
      sourceFormat: "openai",
      targetFormat: "openai",
      apiKeyId: null,
      apiKeyName: null,
      correlationId: "corr-worker-artifact",
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: { worker: true },
    responseBody: { content: "written" },
    error: null,
  };
}

test("worker resolution covers npm, standalone, source, and missing layouts", () => {
  const layoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-worker-layout-"));
  const createWorker = (workerFile: string) => {
    fs.mkdirSync(path.dirname(workerFile), { recursive: true });
    fs.writeFileSync(workerFile, "");
  };

  try {
    const npmRoot = path.join(layoutRoot, "package", "dist");
    const npmWorker = path.join(npmRoot, "src", "lib", "usage", "callLogArtifactWorker.js");
    createWorker(npmWorker);
    assert.deepEqual(
      resolveCallLogArtifactWorker({
        moduleDir: path.join(npmRoot, ".next", "server", "chunks"),
        cwd: path.join(layoutRoot, "unrelated-caller"),
        entryFile: path.join(npmRoot, "server.js"),
        fileExists: fs.existsSync,
      }),
      { workerFile: npmWorker, execArgv: [] }
    );

    const standaloneRoot = path.join(layoutRoot, "standalone");
    const standaloneWorker = path.join(
      standaloneRoot,
      "src",
      "lib",
      "usage",
      "callLogArtifactWorker.js"
    );
    createWorker(standaloneWorker);
    assert.deepEqual(
      resolveCallLogArtifactWorker({
        moduleDir: path.join(standaloneRoot, ".next", "server", "chunks"),
        cwd: standaloneRoot,
        entryFile: null,
        fileExists: fs.existsSync,
      }),
      { workerFile: standaloneWorker, execArgv: [] }
    );

    const sourceDir = path.join(layoutRoot, "source", "src", "lib", "usage");
    const sourceWorker = path.join(sourceDir, "callLogArtifactWorker.ts");
    createWorker(sourceWorker);
    assert.deepEqual(
      resolveCallLogArtifactWorker({
        moduleDir: sourceDir,
        cwd: path.join(layoutRoot, "unrelated-source-caller"),
        entryFile: null,
        fileExists: fs.existsSync,
      }),
      { workerFile: sourceWorker, execArgv: ["--import", "tsx/esm"] }
    );

    const missingRoot = path.join(layoutRoot, "missing");
    assert.deepEqual(
      resolveCallLogArtifactWorker({
        moduleDir: path.join(missingRoot, ".next", "server", "chunks"),
        cwd: path.join(layoutRoot, "unrelated-missing-caller"),
        entryFile: path.join(missingRoot, "server.js"),
        fileExists: fs.existsSync,
      }),
      {
        workerFile: path.join(missingRoot, "src", "lib", "usage", "callLogArtifactWorker.js"),
        execArgv: [],
      }
    );
  } finally {
    fs.rmSync(layoutRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  const resolved = resolveCallLogArtifactWorker();
  assert.equal(fs.existsSync(resolved.workerFile), true);
  assert.equal(path.basename(resolved.workerFile), "callLogArtifactWorker.ts");
  assert.deepEqual(resolved.execArgv, ["--import", "tsx/esm"]);

  const source = fs.readFileSync("src/lib/usage/callLogArtifactWriter.ts", "utf8");
  assert.doesNotMatch(source, /firstAncestorWith|MAX_WALK_UP|runtimeAnchors/);
  assert.doesNotMatch(source, /new Worker\(/);
  assert.match(source, /Reflect\.construct\(Worker/);
});

test("async worker writes call-log artifact and returns matching metadata", async () => {
  const artifact = buildArtifact("worker-write-1");
  const result = await writeCallArtifactAsync(artifact);
  assert.ok(result);

  const artifactPath = path.join(TEST_DATA_DIR, "call_logs", result.relPath);
  const serialized = fs.readFileSync(artifactPath, "utf8");
  assert.equal(result.sizeBytes, Buffer.byteLength(serialized));
  assert.match(result.sha256, /^[0-9a-f]{8}$/);
  assert.deepEqual(JSON.parse(serialized), artifact);
});

test("artifact footprint estimate bounds large strings, tool arrays, and sparse arrays", () => {
  const text = estimateCallLogArtifactFootprint({ content: "x".repeat(1_000_000) });
  assert.equal(text.reason, undefined);
  assert.ok(text.estimatedBytes >= 10_000_000);

  const tools = estimateCallLogArtifactFootprint({
    tool_calls: Array.from({ length: 48 }, (_, index) => ({
      id: `call_${index}`,
      function: { name: `tool_${index}`, arguments: '{"value":"large"}' },
    })),
  });
  assert.equal(tools.reason, undefined);
  assert.ok(tools.estimatedBytes > 48 * 128);

  const sparse = new Array(10_000);
  const sparseEstimate = estimateCallLogArtifactFootprint(sparse);
  assert.equal(sparseEstimate.reason, undefined);
  assert.ok(sparseEstimate.estimatedBytes >= sparse.length * 32);
});

test("artifact footprint estimation terminates safely on cycles and object count caps", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(estimateCallLogArtifactFootprint(cyclic).reason, "cycle");

  const tooManyObjects = Array.from({ length: 50_001 }, () => ({}));
  assert.equal(estimateCallLogArtifactFootprint(tooManyObjects).reason, "object_limit");

  const tooManyValues = Array.from({ length: 100_001 }, () => null);
  assert.equal(estimateCallLogArtifactFootprint(tooManyValues).reason, "value_limit");
});

test("artifact footprint estimation rejects accessors without invoking them", () => {
  let getterInvoked = false;
  const artifact = Object.defineProperty({}, "payload", {
    enumerable: true,
    get() {
      getterInvoked = true;
      return "must not be read by the admission estimator";
    },
  });

  assert.equal(estimateCallLogArtifactFootprint(artifact).reason, "unsupported");
  assert.equal(getterInvoked, false);
});

test("artifact preparation refusal logs a bounded reason and never the payload", () => {
  const secretLike = `private-body-marker-${"x".repeat(7 * 1024 * 1024)}`;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
  try {
    const reservation = reserveCallLogArtifactPreparation({ requestBody: secretLike });
    assert.equal(reservation, null);
    const warning = warnings.find((message) => message.includes("preparation refused"));
    assert.ok(warning);
    assert.match(warning, /reason=single_artifact_budget/);
    assert.match(warning, /estimateMiB=/);
    assert.doesNotMatch(warning, /private-body-marker/);
  } finally {
    console.warn = originalWarn;
  }
});

test("preparation reservation counts exact shared stage bodies once", () => {
  const sharedBody = { input: [{ role: "user", content: "x".repeat(100_000) }] };
  const sharedReservation = reserveCallLogArtifactPreparation({
    requestBody: null,
    responseBody: null,
    error: null,
    pipeline: {
      clientRawRequest: { body: sharedBody },
      openaiRequest: { body: sharedBody },
      providerRequest: { body: sharedBody },
    },
  });
  assert.ok(sharedReservation);
  const sharedBytes = sharedReservation.estimatedBytes;
  releaseCallLogArtifactPreparation(sharedReservation);

  const distinctReservation = reserveCallLogArtifactPreparation({
    requestBody: null,
    responseBody: null,
    error: null,
    pipeline: {
      clientRawRequest: { body: structuredClone(sharedBody) },
      openaiRequest: { body: structuredClone(sharedBody) },
      providerRequest: { body: structuredClone(sharedBody) },
    },
  });
  assert.ok(distinctReservation);
  const distinctBytes = distinctReservation.estimatedBytes;
  releaseCallLogArtifactPreparation(distinctReservation);

  assert.ok(
    sharedBytes < distinctBytes,
    `shared body reservations should be smaller (${sharedBytes} < ${distinctBytes})`
  );
});

test("aggregate artifact budget includes active writes and releases reservations on completion", async () => {
  const largePayload = "x".repeat(2_000_000);
  const writes = Array.from({ length: 7 }, (_, index) => {
    const artifact = buildArtifact(`worker-budget-${index}`);
    artifact.requestBody = { content: largePayload };
    return writeCallArtifactAsync(artifact);
  });

  // Six estimates of about 20 MiB fit the 128 MiB aggregate cap; the seventh
  // is omitted while those writes are active or waiting behind the worker.
  const initialResults = await Promise.all(writes);
  assert.equal(initialResults.filter(Boolean).length, 6);
  assert.equal(initialResults.filter((result) => result === null).length, 1);

  const retryArtifact = buildArtifact("worker-budget-after-release");
  retryArtifact.requestBody = { content: largePayload };
  const retryResult = await writeCallArtifactAsync(retryArtifact);
  assert.ok(retryResult);
});

test("queue budget overflow stores only a safe private diagnostic reference stub", async () => {
  const largePayload = "x".repeat(2_000_000);
  const writes = Array.from({ length: 6 }, (_, index) => {
    const artifact = buildArtifact(`worker-stub-budget-${index}`);
    artifact.requestBody = { content: largePayload };
    return writeCallArtifactAsync(artifact);
  });

  const overflow = buildArtifact("worker-stub-overflow");
  overflow.requestBody = { content: largePayload };
  overflow.summary.apiKeyId = "sk-never-persist-this";
  overflow.summary.apiKeyName = "credential-name-never-persist-this";
  overflow.summary.account = "private-account@example.test";
  overflow.summary.connectionId = "private-connection-id";
  overflow.summary.path = "/v1/responses?api_key=secret-query-value#fragment";
  overflow.summary.correlationId = "corr-safe-overflow-17";
  const diagnosticOverflow = {
    schema: "omni-diagnostic-overflow/v1" as const,
    traceId: "01234567-89ab-cdef-0123-456789abcdef",
    state: "complete" as const,
  };
  overflow.pipeline = {
    diagnosticOverflow,
    providerRequest: { body: { secret: "provider-body-must-not-be-retained" } },
  };
  const overflowWrite = writeCallArtifactAsync(overflow);

  const results = await Promise.all([...writes, overflowWrite]);
  assert.ok(results.slice(0, 6).every(Boolean));
  assert.ok(
    results[6],
    "a bounded pointer-only artifact should survive the full-payload rejection"
  );
  assert.equal(results[6]?.diagnosticOverflowStub, true);

  const saved = JSON.parse(
    fs.readFileSync(path.join(TEST_DATA_DIR, "call_logs", results[6]!.relPath), "utf8")
  ) as CallLogArtifact;
  assert.deepEqual(saved.pipeline?.diagnosticOverflow, diagnosticOverflow);
  assert.equal(saved.summary.id, overflow.summary.id);
  assert.equal(saved.summary.method, "POST");
  assert.equal(saved.summary.path, "/v1/responses");
  assert.equal(saved.summary.model, overflow.summary.model);
  assert.equal(saved.summary.provider, overflow.summary.provider);
  assert.equal(saved.summary.status, overflow.summary.status);
  assert.equal(saved.summary.correlationId, "corr-safe-overflow-17");
  assert.equal(saved.summary.apiKeyId, null);
  assert.equal(saved.summary.apiKeyName, null);
  assert.equal(saved.summary.account, "-");
  assert.equal(saved.summary.connectionId, null);
  assert.match(String(saved.requestBody), /artifact queue memory budget exceeded/);
  assert.match(String(saved.responseBody), /artifact queue memory budget exceeded/);
  assert.doesNotMatch(
    JSON.stringify(saved),
    /provider-body-must-not-be-retained|secret-query-value|sk-never/
  );
});

test("100 concurrent preparations stay under the shared cap and transfer or release once", async () => {
  const records = Array.from({ length: 100 }, (_, index) => {
    const artifact = buildArtifact(`worker-preparation-${index}`);
    artifact.requestBody = { content: "x".repeat(256 * 1024) };
    const diagnosticOverflow = {
      schema: "omni-diagnostic-overflow/v1" as const,
      traceId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      state: "complete" as const,
    };
    artifact.pipeline = { diagnosticOverflow };
    return {
      artifact,
      diagnosticOverflow,
      reservation: reserveCallLogArtifactPreparation({
        requestBody: artifact.requestBody,
        pipeline: artifact.pipeline,
      }),
    };
  });

  const accepted = records.filter((record) => record.reservation !== null);
  const refused = records.filter((record) => record.reservation === null);
  const reservedBytes = accepted.reduce(
    (total, record) => total + (record.reservation?.estimatedBytes ?? 0),
    0
  );
  assert.ok(accepted.length > 0);
  assert.ok(
    refused.length > 0,
    "large parallel preparations must fail open before copying details"
  );
  assert.ok(reservedBytes <= 128 * 1024 * 1024);

  const acceptedWrites = accepted.map((record) =>
    writeCallArtifactAsync(record.artifact, record.reservation)
  );
  const refusedWrites = refused.map((record) =>
    writeDiagnosticOverflowStubAsync(record.artifact.summary, record.diagnosticOverflow)
  );
  const results = await Promise.all([...acceptedWrites, ...refusedWrites]);
  assert.ok(results.every(Boolean));
  assert.ok(
    results.slice(accepted.length).every((result) => result?.diagnosticOverflowStub === true)
  );

  const released = reserveCallLogArtifactPreparation({ requestBody: { content: "small" } });
  assert.ok(released, "worker completion must release transferred reservations");
  releaseCallLogArtifactPreparation(released);
});

test("bounded queue fails open and rate-limits saturation warnings", async () => {
  const originalWarn = console.warn;
  let warningCount = 0;
  console.warn = () => {
    warningCount++;
  };

  try {
    // Saturate the writer's count ceiling in one synchronous burst; the
    // weighted byte budget remains a separate limit.
    const writes = Array.from({ length: 1027 }, (_, index) =>
      writeCallArtifactAsync(buildArtifact(`worker-overflow-${index}`))
    );
    assert.equal(warningCount, 1);

    await closeCallLogArtifactWriter(0);
    const results = await Promise.all(writes);
    assert.ok(results.every((result) => result === null));
  } finally {
    console.warn = originalWarn;
  }
});
