#!/usr/bin/env node
/**
 * Exercise the production call-log save/worker path without a provider or Next build.
 * All artifacts are written under a fresh temporary DATA_DIR and removed on exit.
 * Run with: node --import tsx/esm scripts/perf/bench-call-log-artifact-capacity.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clients = parsePositiveInt(process.argv[2], 100);
const requestBytes = parsePositiveInt(process.argv[3], 262_144);
if (clients > 1_000 || requestBytes > 4 * 1024 * 1024) {
  throw new RangeError("benchmark limits are 1,000 clients and 4 MiB per request");
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-call-log-capacity-"));
process.env.DATA_DIR = dataDir;
process.env.OMNIROUTE_MIGRATIONS_DIR = path.join(root, "src/lib/db/migrations");
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "10240";
process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS = "true";
process.env.CALL_LOG_PIPELINE_STREAM_CHUNK_MAX_SIZE_KB = "256";
process.env.NODE_ENV = "test";

let closeCallLogSaves;
let getCallLogById;
let saveCallLog;
let resetDbInstance;
let callLogsDir;
let callLogArtifactWriter;
const ids = [];

try {
  [
    { closeCallLogSaves, getCallLogById, saveCallLog },
    { CALL_LOGS_DIR: callLogsDir },
    callLogArtifactWriter,
    { resetDbInstance },
  ] = await Promise.all([
    import("../../src/lib/usage/callLogs.ts"),
    import("../../src/lib/usage/callLogArtifacts.ts"),
    import("../../src/lib/usage/callLogArtifactWriter.ts"),
    import("../../src/lib/db/core.ts"),
  ]);

  const textBytes = Math.max(0, requestBytes - 2_048);
  const sharedHistory = "agent context with prior tool calls and results "
    .repeat(Math.ceil(textBytes / 48))
    .slice(0, textBytes);
  const responseBody = {
    id: "resp_benchmark",
    output: [{ type: "message", content: [{ type: "output_text", text: "mock response" }] }],
  };
  const streamChunks = Array.from(
    { length: 100 },
    (_, index) =>
      `data: {"type":"response.output_text.delta","index":${index},"delta":"${"x".repeat(128)}"}\n\n`
  );
  const startedAt = performance.now();

  await Promise.all(
    Array.from({ length: clients }, async (_, index) => {
      const id = `call-log-capacity-${index}`;
      ids.push(id);
      const body = {
        model: "codex/gpt-6.1-sol",
        input: [
          { role: "user", content: `session ${index} ${sharedHistory}` },
          { type: "function_call", call_id: `tool-${index}`, name: "read_file", arguments: "{}" },
          { type: "function_call_output", call_id: `tool-${index}`, output: "mock tool result" },
        ],
      };
      const pipelineBodySnapshot = structuredClone(body);
      const pipelineResponseSnapshot = structuredClone(responseBody);
      const providerResponse = {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: pipelineResponseSnapshot,
      };

      await saveCallLog({
        id,
        timestamp: new Date().toISOString(),
        method: "POST",
        path: "/v1/responses",
        status: 200,
        model: body.model,
        requestedModel: body.model,
        provider: "codex",
        account: `benchmark-${index % 4}`,
        connectionId: null,
        duration: 1000,
        tokens: { in: 1, out: 1, cacheRead: null, cacheCreation: null, reasoning: null },
        requestType: "responses",
        sourceFormat: "openai-responses",
        targetFormat: "openai-responses",
        apiKeyId: null,
        apiKeyName: null,
        requestBody: body,
        responseBody,
        error: null,
        pipelinePayloads: {
          clientRawRequest: {
            endpoint: "/v1/responses",
            headers: { "content-type": "application/json" },
            body: pipelineBodySnapshot,
          },
          openaiRequest: { body: pipelineBodySnapshot },
          providerRequest: { body: pipelineBodySnapshot },
          providerResponse,
          clientResponse: {
            timestamp: new Date().toISOString(),
            body: pipelineResponseSnapshot,
          },
          streamChunks: {
            provider: streamChunks,
            openai: streamChunks.slice(),
            client: streamChunks.slice(),
          },
        },
      });
    })
  );

  const elapsedMs = performance.now() - startedAt;
  const states = { ready: 0, missing: 0, corrupt: 0, other: 0 };
  let artifactBytes = 0;
  for (const id of ids) {
    const detail = await getCallLogById(id);
    const state = detail?.detailState ?? "other";
    if (state in states) states[state]++;
    else states.other++;
    if (detail?.artifactRelPath && callLogsDir) {
      artifactBytes += fs.statSync(path.join(callLogsDir, detail.artifactRelPath)).size;
    }
  }

  console.log(
    JSON.stringify({
      runtime: process.versions.bun ? `bun-${process.versions.bun}` : process.version,
      clients,
      targetRequestBytes: requestBytes,
      streamChunkCount: streamChunks.length,
      completedSaves: ids.length,
      states,
      artifactBytes,
      elapsedMs: Math.round(elapsedMs),
      peakRssMiB: Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10,
      dataDirBytes: directoryBytes(dataDir),
      workerFileAvailable: callLogArtifactWriter.isCallLogArtifactWorkerAvailable(),
    })
  );
} finally {
  if (closeCallLogSaves) await closeCallLogSaves();
  if (callLogArtifactWriter) await callLogArtifactWriter.closeCallLogArtifactWriter();
  if (resetDbInstance) resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`invalid positive integer: ${raw}`);
  return value;
}

function directoryBytes(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}
