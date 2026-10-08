#!/usr/bin/env node
/**
 * Reproducible lossless call-log text-dedup microbenchmark.
 *
 * This uses synthetic repeated policy/tool text, writes only into a private temporary DATA_DIR,
 * and removes that directory before exit. It reports the text-table pass separately from the
 * complete artifact writer (which also removes exact duplicate request/response stage bodies).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const count = Number(process.argv[2] ?? 100);
if (!Number.isSafeInteger(count) || count < 1 || count > 1000) {
  throw new Error("usage: bench-call-log-text-dedup.mjs [artifact-count: 1..1000]");
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-call-log-text-dedup-"));
const originalDataDir = process.env.DATA_DIR;
const originalPipelineCap = process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
process.env.DATA_DIR = dataDir;
process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "512";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

function buildBodies(index) {
  const sharedText = `Shared policy and tool instructions. ${"Preserve exact behavior and report evidence. ".repeat(360)}`;
  const requestBody = {
    model: "codex/gpt-6.1-sol",
    instructions: [sharedText, sharedText, sharedText, sharedText],
    input: [
      { role: "system", content: sharedText },
      { role: "developer", content: sharedText },
      { role: "user", content: `Inspect synthetic session ${index}.` },
    ],
    tools: [{ name: "inspect", description: sharedText }],
  };
  const responseBody = { output: [{ type: "message", content: sharedText }] };
  return { requestBody, responseBody };
}

function percentile(samples, fraction) {
  return samples[Math.max(0, Math.ceil(samples.length * fraction) - 1)];
}

try {
  const { compactCallLogRepeatedText, writeCallArtifact } = await import(
    pathToFileURL(path.resolve("src/lib/usage/callLogArtifacts.ts")).href
  );
  const compactSamples = [];
  const uniqueContextSamples = [];
  let compactBeforeBytes = 0;
  let compactAfterBytes = 0;
  let fullBeforeBytes = 0;
  let fullAfterBytes = 0;
  const writeSamples = [];

  for (let index = 0; index < count; index++) {
    const { requestBody, responseBody } = buildBodies(index);
    const afterBodyReferenceArtifact = {
      schemaVersion: 7,
      summary: { id: `dedup-${index}`, model: requestBody.model, provider: "codex" },
      requestBody: undefined,
      requestBodyRef: "pipeline.clientRawRequest.body",
      responseBody: undefined,
      responseBodyRef: "pipeline.clientResponse.body",
      error: null,
      pipeline: {
        clientRawRequest: { body: requestBody },
        openaiRequest: { bodyRef: "pipeline.clientRawRequest.body" },
        providerRequest: { bodyRef: "pipeline.clientRawRequest.body" },
        clientResponse: { body: responseBody },
        providerResponse: { bodyRef: "pipeline.clientResponse.body" },
      },
    };
    const before = Buffer.byteLength(JSON.stringify(afterBodyReferenceArtifact));
    const compactStarted = process.hrtime.bigint();
    const compacted = compactCallLogRepeatedText(afterBodyReferenceArtifact);
    const compactElapsedMs = Number(process.hrtime.bigint() - compactStarted) / 1e6;
    const after = Buffer.byteLength(JSON.stringify(compacted));
    compactBeforeBytes += before;
    compactAfterBytes += after;
    compactSamples.push(compactElapsedMs);

    const uniqueMessages = Array.from({ length: 5 }, (_, turn) => {
      const prefix = `independent-session-${index}-turn-${turn}-`;
      return {
        role: "user",
        content: `${prefix}${"q".repeat(262_144 - prefix.length)}`,
      };
    });
    const uniqueContextArtifact = {
      schemaVersion: 8,
      requestBody: { messages: uniqueMessages },
      responseBody: { output: "short synthetic response" },
      error: null,
    };
    const uniqueStarted = process.hrtime.bigint();
    const uniqueCompacted = compactCallLogRepeatedText(uniqueContextArtifact);
    const uniqueElapsedMs = Number(process.hrtime.bigint() - uniqueStarted) / 1e6;
    if (uniqueCompacted !== uniqueContextArtifact) {
      throw new Error("large unique context should stay in its original representation");
    }
    uniqueContextSamples.push(uniqueElapsedMs);

    const timestamp = new Date().toISOString();
    const fullArtifact = {
      schemaVersion: 8,
      summary: {
        id: `dedup-write-${index}`,
        timestamp,
        method: "POST",
        path: "/v1/responses",
        status: 200,
        model: requestBody.model,
        requestedModel: requestBody.model,
        provider: "codex",
        account: "synthetic-benchmark",
        connectionId: null,
        duration: 100,
        tokens: {
          in: 1000,
          out: 200,
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
        clientRawRequest: { endpoint: "/v1/responses", headers: {}, body: requestBody },
        openaiRequest: { body: requestBody },
        providerRequest: {
          url: "https://mock.local/v1/responses",
          headers: {},
          body: requestBody,
        },
        providerResponse: { status: 200, headers: {}, body: responseBody },
        clientResponse: { body: responseBody },
        streamChunks: { provider: [], openai: [], client: [] },
      },
    };
    fullBeforeBytes += Buffer.byteLength(JSON.stringify(fullArtifact));
    const writeStarted = process.hrtime.bigint();
    const stored = writeCallArtifact(fullArtifact);
    const writeElapsedMs = Number(process.hrtime.bigint() - writeStarted) / 1e6;
    if (!stored) throw new Error(`artifact ${index} did not write`);
    fullAfterBytes += stored.sizeBytes;
    writeSamples.push(writeElapsedMs);
  }

  compactSamples.sort((a, b) => a - b);
  uniqueContextSamples.sort((a, b) => a - b);
  writeSamples.sort((a, b) => a - b);
  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "call-log-exact-text-dedup/v1",
        syntheticArtifacts: count,
        exactTextTableAfterBodyRefs: {
          inputBytes: compactBeforeBytes,
          storedBytes: compactAfterBytes,
          savedBytes: compactBeforeBytes - compactAfterBytes,
          savedPercent: Number(
            (((compactBeforeBytes - compactAfterBytes) / compactBeforeBytes) * 100).toFixed(2)
          ),
          transformMsMedian: Number(percentile(compactSamples, 0.5).toFixed(3)),
          transformMsP95: Number(percentile(compactSamples, 0.95).toFixed(3)),
        },
        largeUniqueContextScan: {
          artifacts: count,
          uniqueTextValuesPerArtifact: 5,
          codeUnitsPerValue: 262_144,
          transformMsMedian: Number(percentile(uniqueContextSamples, 0.5).toFixed(3)),
          transformMsP95: Number(percentile(uniqueContextSamples, 0.95).toFixed(3)),
          representationChanged: false,
        },
        fullArtifactWriter: {
          inputBytes: fullBeforeBytes,
          storedBytes: fullAfterBytes,
          savedBytes: fullBeforeBytes - fullAfterBytes,
          savedPercent: Number(
            (((fullBeforeBytes - fullAfterBytes) / fullBeforeBytes) * 100).toFixed(2)
          ),
          writeMsMedian: Number(percentile(writeSamples, 0.5).toFixed(3)),
          writeMsP95: Number(percentile(writeSamples, 0.95).toFixed(3)),
        },
        note: "Synthetic repeated text only; sequential local writes, not request heap or production throughput.",
      },
      null,
      2
    )}\n`
  );
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalPipelineCap === undefined) delete process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
  else process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = originalPipelineCap;
}
