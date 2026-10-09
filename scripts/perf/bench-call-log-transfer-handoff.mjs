#!/usr/bin/env node
/**
 * Bounded comparison of OmniRoute's current call-log worker handoff with a
 * benchmark-only transferable serialized-buffer handoff.
 *
 * Both modes build the same payload through protectPipelinePayloads(). The
 * transfer mode uses the production stream/text compaction helpers, then
 * transfers UTF-8 bytes to a small test worker for disk writing. Its serialized
 * bytes are checked against the production writer's exact output for this
 * fixture, and read back through the production reader. The test-only transfer
 * writer skips production checksum/metadata work, so it is a content-handoff
 * prototype rather than a drop-in writer. Hard limit: 10 MiB artifact.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const sourceFile = path.resolve("scripts/perf/bench-call-log-transfer-handoff.mjs");

function summarizeRss() {
  return process.resourceUsage().maxRSS * 1024;
}

function makePayloads() {
  const secret = "sk-test-call-log-transfer-secret";
  const chunk = `data: ${"event-fragment-".repeat(2_048)}\n\n`;
  const rawRequest = {
    model: "codex/gpt-6.1-sol",
    messages: [{ role: "user", content: "r".repeat(2 * 1024 * 1024) }],
    metadata: { api_key: secret, run: "handoff-benchmark" },
  };
  const rawResponse = {
    id: "resp_handoff_benchmark",
    output: [{ type: "message", content: "s".repeat(1024 * 1024) }],
  };
  const rawPipeline = {
    clientRawRequest: {
      endpoint: "/v1/responses",
      headers: { authorization: "Bearer benchmark-only" },
      body: rawRequest,
    },
    openaiRequest: {
      endpoint: "/v1/responses",
      headers: { authorization: "Bearer benchmark-only" },
      body: rawRequest,
    },
    providerRequest: {
      url: "https://mock.local/v1/responses",
      headers: { authorization: "Bearer benchmark-only" },
      body: rawRequest,
    },
    clientResponse: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: rawResponse,
    },
    providerResponse: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: rawResponse,
    },
    streamChunks: {
      provider: Array(8).fill(chunk),
      openai: Array(8).fill(chunk),
      client: Array(8).fill(chunk),
    },
  };
  return { rawPipeline, rawRequest, rawResponse, secret };
}

function makeArtifact(pipeline, id) {
  return {
    schemaVersion: 9,
    summary: {
      id,
      timestamp: "2026-10-09T12:00:00.000Z",
      method: "POST",
      path: "/v1/responses",
      status: 200,
      model: "gpt-6.1-sol",
      requestedModel: "codex/gpt-6.1-sol",
      provider: "codex",
      account: "benchmark",
      connectionId: null,
      duration: 200,
      tokens: {
        in: 50_000,
        out: 1_000,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: "responses",
      sourceFormat: "openai-responses",
      targetFormat: "openai-responses",
      apiKeyId: null,
      apiKeyName: null,
      correlationId: "handoff-benchmark",
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody: undefined,
    requestBodyRef: "pipeline.clientRawRequest.body",
    responseBody: undefined,
    responseBodyRef: "pipeline.clientResponse.body",
    error: null,
    pipeline,
  };
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertSafeAndEquivalent(read, expected, secret) {
  assert.equal(read.state, "ready", "written artifact must be readable through production reader");
  const artifact = read.artifact;
  assert.ok(artifact);
  assert.equal(
    digest(artifact.requestBody),
    expected.requestDigest,
    "request body must round-trip through production body-reference expansion"
  );
  assert.equal(
    digest(artifact.responseBody),
    expected.responseDigest,
    "response body must round-trip through production body-reference expansion"
  );
  assert.equal(
    digest(artifact.pipeline.streamChunks),
    expected.streamDigest,
    "stream chunks must round-trip through production stream/text table expansion"
  );
  assert.equal(digest(artifact.pipeline.openaiRequest.body), expected.requestDigest);
  assert.equal(digest(artifact.pipeline.providerRequest.body), expected.requestDigest);
  assert.equal(digest(artifact.pipeline.clientResponse.body), expected.responseDigest);
  assert.equal(digest(artifact.pipeline.providerResponse.body), expected.responseDigest);
  const serialized = JSON.stringify(artifact);
  assert.ok(
    !serialized.includes(secret),
    "protected API-key value must not appear in persisted artifacts"
  );
  assert.ok(
    !serialized.includes("Bearer benchmark-only"),
    "protected authorization header must not appear in persisted artifacts"
  );
}

/**
 * Test-only projection matching the private duplicate-body storage transform.
 * protectPipelinePayloads shares these source body identities, so identity
 * equality is sufficient for this fixed fixture; an exact-writer SHA oracle
 * rejects any divergence from the canonical production serialized form.
 */
function compactSharedStageBodiesForFixture(artifact) {
  const pipeline = { ...artifact.pipeline };
  for (const names of [
    ["clientRawRequest", "openaiRequest", "providerRequest"],
    ["clientResponse", "providerResponse"],
  ]) {
    const firstName = names.find((name) => {
      const stage = pipeline[name];
      return stage && Object.hasOwn(stage, "body") && stage.body !== undefined;
    });
    if (!firstName) continue;
    const canonicalBody = pipeline[firstName].body;
    for (const name of names.slice(names.indexOf(firstName) + 1)) {
      const stage = pipeline[name];
      if (!stage || !Object.hasOwn(stage, "body") || stage.body !== canonicalBody) continue;
      pipeline[name] = {
        ...stage,
        body: undefined,
        bodyRef: `pipeline.${firstName}.body`,
      };
    }
  }
  return { ...artifact, pipeline };
}

async function createProtectedInput(id) {
  const [format, artifacts] = await Promise.all([
    import(pathToFileURL(path.resolve("src/lib/usage/callLogs/format.ts")).href),
    import(pathToFileURL(path.resolve("src/lib/usage/callLogArtifacts.ts")).href),
  ]);
  const payloads = makePayloads();
  const protectedPipeline = format.protectPipelinePayloads(payloads.rawPipeline);
  assert.ok(protectedPipeline);
  payloads.rawPipeline = null;
  payloads.rawRequest = null;
  payloads.rawResponse = null;
  const artifact = makeArtifact(protectedPipeline, id);
  const serializedSize = Buffer.byteLength(JSON.stringify(artifact));
  assert.ok(
    serializedSize > 0 && serializedSize <= MAX_ARTIFACT_BYTES,
    `artifact ${serializedSize}B exceeds 10 MiB bound`
  );
  assert.ok(
    !JSON.stringify(protectedPipeline).includes(payloads.secret),
    "protection helper must redact the synthetic API key"
  );
  return { artifact, protectedPipeline, secret: payloads.secret, artifacts };
}

function transferWriteWorker(directory, relativePath, bytes) {
  const workerFile = path.resolve("scripts/perf/call-log-transfer-writer-worker.ts");
  const worker = new Worker(pathToFileURL(workerFile), { execArgv: ["--import", "tsx/esm"] });
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeListener("error", onError);
      worker.removeListener("messageerror", onMessageError);
      worker.removeListener("message", onMessage);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onMessageError = () => {
      cleanup();
      reject(new Error("transfer worker message error"));
    };
    const onMessage = (message) => {
      if (message?.ready) {
        worker.postMessage({ directory, relativePath, bytes }, [bytes.buffer]);
        return;
      }
      cleanup();
      worker.terminate().finally(() => resolve(message));
    };
    worker.on("error", onError);
    worker.on("messageerror", onMessageError);
    worker.on("message", onMessage);
  });
}

async function runChild(mode) {
  if (process.env.DATA_DIR === undefined) throw new Error("DATA_DIR must be set by parent");
  process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "10240";
  process.env.CHAT_DEBUG_FILE = "false";
  const id = "handoff-transfer-fixture";
  let { artifact, protectedPipeline, secret, artifacts } = await createProtectedInput(id);
  const rawSize = Buffer.byteLength(JSON.stringify(artifact));
  if (rawSize > MAX_ARTIFACT_BYTES)
    throw new Error(`source object graph exceeds 10 MiB (${rawSize})`);
  const { readCallArtifact } = artifacts;
  const expected = {
    requestDigest: digest(protectedPipeline.clientRawRequest.body),
    responseDigest: digest(protectedPipeline.providerResponse.body),
    streamDigest: digest(protectedPipeline.streamChunks),
  };
  if (typeof global.gc === "function") global.gc();
  let writeResult;
  let handoffSyncMs = null;
  const startedAt = process.hrtime.bigint();

  if (mode === "clone" || mode === "oracle") {
    const writer = await import(
      pathToFileURL(path.resolve("src/lib/usage/callLogArtifactWriter.ts")).href
    );
    const handoffStarted = process.hrtime.bigint();
    const pending = writer.writeCallArtifactAsync(artifact);
    handoffSyncMs = Number(process.hrtime.bigint() - handoffStarted) / 1e6;
    artifact = null;
    protectedPipeline = null;
    writeResult = await pending;
    await writer.closeCallLogArtifactWriter(10_000);
    if (mode === "oracle") {
      const productionBytes = fs.readFileSync(
        path.join(artifacts.CALL_LOGS_DIR, writeResult.relPath)
      );
      const productionSerializedSha256 = createHash("sha256").update(productionBytes).digest("hex");
      if (process.env.TRANSFER_ORACLE_SHA_FILE) {
        fs.writeFileSync(process.env.TRANSFER_ORACLE_SHA_FILE, productionSerializedSha256, {
          mode: 0o600,
        });
      }
    }
  } else if (mode === "transfer") {
    const writer = await import(
      pathToFileURL(path.resolve("src/lib/usage/callLogArtifactWriter.ts")).href
    );
    const expectedProductionSha = fs
      .readFileSync(process.env.TRANSFER_ORACLE_SHA_FILE, "utf8")
      .trim();
    const handoffStarted = process.hrtime.bigint();
    const bodyCompacted = compactSharedStageBodiesForFixture(artifact);
    const streamCompacted = artifacts.compactCallLogStreamChunkText(bodyCompacted);
    const estimate = writer.estimateCallLogArtifactFootprint(streamCompacted);
    assert.equal(
      estimate.reason,
      undefined,
      `production footprint estimator rejected fixture: ${estimate.reason}`
    );
    let compacted = artifacts.compactCallLogRepeatedText(streamCompacted);
    let serialized = JSON.stringify(compacted);
    const byteLength = Buffer.byteLength(serialized);
    if (byteLength > MAX_ARTIFACT_BYTES)
      throw new Error(`transfer bytes exceed 10 MiB (${byteLength})`);
    let bytes = new TextEncoder().encode(serialized);
    serialized = null;
    compacted = null;
    const relativePath = artifacts.buildArtifactRelativePath(
      artifact.summary.timestamp,
      artifact.summary.id
    );
    artifact = null;
    protectedPipeline = null;
    const pending = transferWriteWorker(artifacts.CALL_LOGS_DIR, relativePath, bytes);
    handoffSyncMs = Number(process.hrtime.bigint() - handoffStarted) / 1e6;
    const result = await pending;
    bytes = null;
    assert.equal(
      result.sha256,
      expectedProductionSha,
      "transfer serialization must equal production writer output for this fixture"
    );
    writeResult = {
      relPath: relativePath,
      sizeBytes: result.bytesWritten,
      sha256: result.sha256,
    };
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }

  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  assert.ok(writeResult, "artifact writer must complete");
  assert.ok(writeResult.sizeBytes <= MAX_ARTIFACT_BYTES, "stored artifact must stay within 10 MiB");
  const read = readCallArtifact(writeResult.relPath);
  assertSafeAndEquivalent(read, expected, secret);
  console.log(
    JSON.stringify({
      mode,
      success: true,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      handoffSyncMs: Math.round(handoffSyncMs * 100) / 100,
      sourceBytes: rawSize,
      storedBytes: writeResult.sizeBytes,
      peakRssBytes: summarizeRss(),
      roundTrip: true,
      redaction: true,
    })
  );
}

async function runParent() {
  const results = [];
  const oracleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omni-call-log-oracle-"));
  const oracleShaFile = path.join(oracleRoot, "production-sha256");
  try {
    for (const mode of ["clone", "oracle", "transfer"]) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `omni-call-log-${mode}-`));
      try {
        const child = spawnSync(
          process.execPath,
          [
            "--expose-gc",
            "--import",
            "tsx/esm",
            "--import",
            "./open-sse/utils/setupPolyfill.ts",
            sourceFile,
            "--child",
            mode,
          ],
          {
            cwd: process.cwd(),
            encoding: "utf8",
            env: {
              ...process.env,
              DATA_DIR: dataDir,
              CALL_LOG_PIPELINE_MAX_SIZE_KB: "10240",
              DISABLE_SQLITE_AUTO_BACKUP: "true",
              ...(mode === "oracle" ? { TRANSFER_ORACLE_SHA_FILE: oracleShaFile } : {}),
              ...(mode === "transfer" ? { TRANSFER_ORACLE_SHA_FILE: oracleShaFile } : {}),
              OMNIROUTE_CALLLOG_HANDOFF_BENCH_CHILD: "1",
            },
            maxBuffer: 1024 * 1024,
          }
        );
        if (child.error) throw child.error;
        if (child.status !== 0) {
          throw new Error(`${mode} child exit=${child.status}\n${child.stdout}\n${child.stderr}`);
        }
        const reportLine = child.stdout.trim().split("\n").at(-1);
        const report = JSON.parse(reportLine);
        results.push(report);
        if (mode !== "oracle") process.stdout.write(`${JSON.stringify(report)}\n`);
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(oracleRoot, { recursive: true, force: true });
  }
  const clone = results.find((result) => result.mode === "clone");
  const transfer = results.find((result) => result.mode === "transfer");
  console.log(
    JSON.stringify(
      {
        comparison: {
          peakRssDeltaBytesTransferMinusClone: transfer.peakRssBytes - clone.peakRssBytes,
          elapsedDeltaMsTransferMinusClone:
            Math.round((transfer.elapsedMs - clone.elapsedMs) * 100) / 100,
          handoffSyncDeltaMsTransferMinusClone:
            Math.round((transfer.handoffSyncMs - clone.handoffSyncMs) * 100) / 100,
          sourceBytesEqual: clone.sourceBytes === transfer.sourceBytes,
          bothRoundTripAndRedactionVerified:
            clone.roundTrip && transfer.roundTrip && clone.redaction && transfer.redaction,
          transferSerializerByteIdenticalToProductionWriter: true,
          note: "One synthetic protected artifact per isolated process; single artifact, no concurrency. Peak RSS includes encode, worker write, and production-reader readback. Transfer mode moves synchronous compaction/JSON serialization onto the caller isolate; the test-only worker omits production checksum/metadata, so this is not a drop-in writer benchmark.",
        },
      },
      null,
      2
    )
  );
}

if (process.argv[2] === "--child") {
  await runChild(process.argv[3]);
} else {
  await runParent();
}
