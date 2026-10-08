#!/usr/bin/env node
/**
 * Exercise the production request logger, call-log preparation, SQLite summary,
 * and artifact worker together. All state is isolated in a temporary DATA_DIR.
 * Run with: node --import tsx/esm scripts/perf/bench-call-log-lifecycle.mjs 100 262144 65536 65536
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clients = parsePositiveInt(process.argv[2], 100);
const requestBytes = parsePositiveInt(process.argv[3], 262_144);
const stageTextLimitBytes = parsePositiveInt(process.argv[4], 64 * 1024);
const clientTextLimitBytes = parsePositiveInt(process.argv[5], stageTextLimitBytes);
if (
  clients > 1_000 ||
  requestBytes > 4 * 1024 * 1024 ||
  stageTextLimitBytes > 4 * 1024 * 1024 ||
  clientTextLimitBytes > 4 * 1024 * 1024
) {
  throw new RangeError("benchmark limits are 1,000 clients and 4 MiB per body/text limit");
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-call-log-lifecycle-"));
process.env.DATA_DIR = dataDir;
process.env.OMNIROUTE_MIGRATIONS_DIR = path.join(root, "src/lib/db/migrations");
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "10240";
process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS = "true";
process.env.CALL_LOG_PIPELINE_STREAM_CHUNK_MAX_SIZE_KB = "256";
process.env.CHAT_LOG_TEXT_LIMIT = String(stageTextLimitBytes);
process.env.CHAT_LOG_CLIENT_TEXT_LIMIT = String(clientTextLimitBytes);
process.env.NODE_ENV = "test";

let closeCallLogSaves;
let getCallLogById;
let saveCallLog;
let createRequestLogger;
let resetDbInstance;
let ensureDbInitialized;
let callLogsDir;
let callLogArtifactWriter;
let loadSampler;
let peakLoadRssBytes = process.memoryUsage().rss;
const ids = [];

try {
  const setupStartedAt = performance.now();
  [
    { closeCallLogSaves, getCallLogById, saveCallLog },
    { CALL_LOGS_DIR: callLogsDir },
    callLogArtifactWriter,
    { resetDbInstance, ensureDbInitialized },
    { createRequestLogger },
  ] = await Promise.all([
    import("../../src/lib/usage/callLogs.ts"),
    import("../../src/lib/usage/callLogArtifacts.ts"),
    import("../../src/lib/usage/callLogArtifactWriter.ts"),
    import("../../src/lib/db/core.ts"),
    import("../../open-sse/utils/requestLogger.ts"),
  ]);

  await ensureDbInitialized();
  const setupMs = Math.round(performance.now() - setupStartedAt);

  const streamChunks = Array.from(
    { length: 100 },
    (_, index) =>
      `data: {"type":"response.output_text.delta","index":${index},"delta":"${"x".repeat(128)}"}\n\n`
  );
  const responseBody = {
    id: "resp_lifecycle_benchmark",
    output: [{ type: "message", content: [{ type: "output_text", text: "mock response" }] }],
  };
  peakLoadRssBytes = process.memoryUsage().rss;
  loadSampler = setInterval(() => {
    peakLoadRssBytes = Math.max(peakLoadRssBytes, process.memoryUsage().rss);
  }, 10);
  loadSampler.unref?.();
  const startedAt = performance.now();

  await Promise.all(
    Array.from({ length: clients }, async (_, index) => {
      const id = `call-log-lifecycle-${index}`;
      ids.push(id);
      const model = "codex/gpt-6.1-sol";
      const textBytes = Math.max(0, requestBytes - 2_048);
      const body = {
        model,
        input: [
          {
            role: "user",
            content: `session ${index} ${"agent context and completed tool results "
              .repeat(Math.ceil(textBytes / 38))
              .slice(0, textBytes)}`,
          },
          { type: "function_call", call_id: `tool-${index}`, name: "read_file", arguments: "{}" },
          { type: "function_call_output", call_id: `tool-${index}`, output: "mock tool result" },
        ],
      };
      const logger = await createRequestLogger("openai-responses", "openai-responses", model, {
        enabled: true,
        captureStreamChunks: true,
        maxStreamChunkBytes: 256 * 1024,
        provider: "codex",
      });
      logger.logClientRawRequest("/v1/responses", body, { "content-type": "application/json" });
      logger.logOpenAIRequest(body);
      logger.logTargetRequest("https://mock.invalid/v1/responses", {}, body);
      logger.logProviderResponse(200, "OK", { "content-type": "application/json" }, responseBody);
      logger.logConvertedResponse(responseBody);
      for (const chunk of streamChunks) {
        logger.appendProviderChunk(chunk);
        logger.appendOpenAIChunk(chunk);
        logger.appendConvertedChunk(chunk);
      }

      await saveCallLog({
        id,
        timestamp: new Date().toISOString(),
        method: "POST",
        path: "/v1/responses",
        status: 200,
        model,
        requestedModel: model,
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
        pipelinePayloads: logger.getPipelinePayloads(),
      });
    })
  );

  clearInterval(loadSampler);
  loadSampler = undefined;
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
      stageTextLimitBytes,
      clientTextLimitBytes,
      streamChunkCountPerTrack: streamChunks.length,
      completedSaves: ids.length,
      states,
      artifactBytes,
      setupMs,
      elapsedMs: Math.round(elapsedMs),
      peakLoadRssMiB: Math.round((peakLoadRssBytes / (1024 * 1024)) * 10) / 10,
      processHighWaterRssMiB: Math.round((process.resourceUsage().maxRSS / 1024) * 10) / 10,
      dataDirBytes: directoryBytes(dataDir),
      workerFileAvailable: callLogArtifactWriter.isCallLogArtifactWorkerAvailable(),
    })
  );
} finally {
  if (loadSampler) clearInterval(loadSampler);
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
