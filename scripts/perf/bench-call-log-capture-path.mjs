#!/usr/bin/env node
/**
 * Exercise the ordinary production request-capture and call-log path end to end:
 * request logger -> provider fetch capture hook -> streamed fake response taps ->
 * saveCallLog -> SQLite summary + artifact worker. No provider or server build is used.
 *
 * Run with:
 *   node --import tsx/esm scripts/perf/bench-call-log-capture-path.mjs [clients] [request-bytes] [response-bytes] [stream-chunks=true|false] [finalizer-dedup=true|false]
 *
 * Each invocation has an isolated temporary DATA_DIR and removes it on exit.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

function parsePositiveInt(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`invalid positive integer: ${raw}`);
  return value;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [clientsArg, requestBytesArg, responseBytesArg, streamChunksArg, finalizerDedupArg] =
  process.argv.slice(2);
const clients = parsePositiveInt(clientsArg, 24);
const requestBytes = parsePositiveInt(requestBytesArg, 131_072);
const responseBytes = parsePositiveInt(responseBytesArg, 32_768);
const captureStreamChunks = streamChunksArg !== "false";
const finalizerDedupEnabled = finalizerDedupArg !== "false";
if (clients > 70 || requestBytes > 4 * 1024 * 1024 || responseBytes > 256 * 1024) {
  throw new RangeError("limits are 70 clients, 4 MiB request, and 256 KiB response");
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-call-log-capture-path-"));
fs.chmodSync(dataDir, 0o700);
process.env.DATA_DIR = dataDir;
process.env.OMNIROUTE_MIGRATIONS_DIR = path.join(root, "src/lib/db/migrations");
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "10240";
process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS = String(captureStreamChunks);
process.env.CALL_LOG_PIPELINE_STREAM_CHUNK_MAX_SIZE_KB = "512";
process.env.CHAT_LOG_TEXT_LIMIT = String(requestBytes + 1024);
process.env.CHAT_LOG_CLIENT_TEXT_LIMIT = String(requestBytes + 1024);
process.env.NODE_ENV = "test";

let closeCallLogSaves;
let getCallLogById;
let saveCallLog;
let createRequestLogger;
let createPreparedRequestLogger;
let isPreparedProviderRequest;
let runWithCapture;
let captureCurrentProviderBody;
let resetDbInstance;
let ensureDbInitialized;
let callLogsDir;
let artifactWriter;
let sampler;
let peakRssBytes = process.memoryUsage().rss;
let peakHeapUsedBytes = process.memoryUsage().heapUsed;
const ids = [];
const originalFetch = globalThis.fetch;

function readProcessIoBytes() {
  try {
    const values = new Map(
      fs
        .readFileSync("/proc/self/io", "utf8")
        .split("\n")
        .map((line) => line.trim().split(/\s+/, 2))
        .filter(([key, value]) => key && value && /^\d+$/.test(value))
        .map(([key, value]) => [key.replace(/:$/, ""), Number(value)])
    );
    return {
      readBytes: values.get("read_bytes") ?? 0,
      writeBytes: values.get("write_bytes") ?? 0,
      cancelledWriteBytes: values.get("cancelled_write_bytes") ?? 0,
    };
  } catch {
    return null;
  }
}

function readLinuxPeakRssMiB() {
  try {
    const status = fs.readFileSync("/proc/self/status", "utf8");
    const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
    return match ? Math.round((Number(match[1]) / 1024) * 10) / 10 : null;
  } catch {
    return null;
  }
}

function directoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

function requestFor(index, filler) {
  const prefix = `session-${index}:`;
  const makeBody = (content) =>
    JSON.stringify({
      model: "gpt-6.1-sol",
      input: [
        { role: "user", content },
        { type: "function_call", call_id: `tool-${index}`, name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: `tool-${index}`, output: `result-${index}` },
      ],
    });
  const fillerLength = requestBytes - Buffer.byteLength(makeBody(prefix));
  if (fillerLength < 0 || fillerLength > filler.length)
    throw new Error("request body target or generated filler is invalid");
  const body = makeBody(prefix + filler.slice(0, fillerLength));
  if (Buffer.byteLength(body) !== requestBytes)
    throw new Error(`request body size mismatch: ${Buffer.byteLength(body)}/${requestBytes}`);
  return { body, parsed: JSON.parse(body) };
}

try {
  // Use random incompressible content to avoid unrealistically small persisted
  // artifacts. The filler tail is reused as a lightweight generator, while each
  // request and parsed body is independently serialized with session-specific fields.
  const filler = randomBytes(Math.ceil(((requestBytes + 1024) * 3) / 4) + 8).toString("base64");
  const streamUnit = Buffer.from(
    `data: {"type":"response.output_text.delta","delta":"${"x".repeat(900)}"}\n\n`
  );
  const chunkCount = Math.max(1, Math.ceil(responseBytes / streamUnit.byteLength));
  const responseChunks = Array.from({ length: chunkCount }, (_, index) => {
    const prefix = Buffer.from(`id:${index}\n`);
    const value = Buffer.concat([prefix, streamUnit]);
    return value.subarray(0, Math.min(value.length, responseBytes));
  });
  const totalResponseBytes = responseChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  let capturedProviderBodies = 0;
  let finalizerDuplicateLogsSkipped = 0;

  [
    { closeCallLogSaves, getCallLogById, saveCallLog },
    { CALL_LOGS_DIR: callLogsDir },
    artifactWriter,
    { resetDbInstance, ensureDbInitialized },
    { createRequestLogger },
    {
      createPreparedRequestLogger,
      isPreparedProviderRequest,
      runWithCapture,
      captureCurrentProviderBody,
    },
  ] = await Promise.all([
    import("../../src/lib/usage/callLogs.ts"),
    import("../../src/lib/usage/callLogArtifacts.ts"),
    import("../../src/lib/usage/callLogArtifactWriter.ts"),
    import("../../src/lib/db/core.ts"),
    import("../../open-sse/utils/requestLogger.ts"),
    import("../../open-sse/utils/providerRequestLogging.ts"),
  ]);
  await ensureDbInitialized();

  let fakeUpstreamRequests = 0;
  globalThis.fetch = async (_input, init) => {
    if (String(init?.method).toUpperCase() !== "POST")
      throw new Error("fake upstream expected a POST");
    const outgoing = String(init?.body ?? "");
    const parsed = JSON.parse(outgoing);
    if (parsed.model !== "gpt-6.1-sol") throw new Error("captured request model mismatch");
    fakeUpstreamRequests++;
    let index = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (index >= responseChunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(responseChunks[index++]);
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": `synthetic-${fakeUpstreamRequests}`,
      },
    });
  };

  const ioBefore = readProcessIoBytes();
  const startedAt = performance.now();
  sampler = setInterval(() => {
    const memory = process.memoryUsage();
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
  }, 10);
  sampler.unref?.();

  await Promise.all(
    Array.from({ length: clients }, async (_, index) => {
      const { body: requestBody, parsed } = requestFor(index, filler);
      const id = `capture-path-${index}`;
      ids.push(id);
      const logger = await createRequestLogger(
        "openai-responses",
        "openai-responses",
        "gpt-6.1-sol",
        {
          enabled: true,
          captureStreamChunks,
          maxStreamChunkBytes: 512 * 1024,
          provider: "codex",
          requestId: id,
          model: "gpt-6.1-sol",
        }
      );
      logger.logClientRawRequest("/v1/responses", parsed, { "content-type": "application/json" });
      const capture = createPreparedRequestLogger(
        logger,
        { id, model: "gpt-6.1-sol", provider: "codex", connectionId: null },
        { enabled: true, provider: "codex" }
      );
      const url = "https://mock.invalid/v1/responses";
      const headers = { "content-type": "application/json" };
      // Codex's HTTP executor calls this before fetch. The actual fetch wrapper
      // observes the same body a second time and should recognize the prepared capture.
      const response = await runWithCapture(capture, async () => {
        await captureCurrentProviderBody(url, headers, requestBody);
        return fetch(url, { method: "POST", headers, body: requestBody });
      });
      const finalBody = capture.body(parsed);
      if (finalizerDedupEnabled && isPreparedProviderRequest(capture, url, headers, finalBody)) {
        finalizerDuplicateLogsSkipped++;
      } else {
        // Mirrors ChatCore's post-executor log when the prepared wire capture
        // does not already represent the final URL/headers/body.
        logger.logTargetRequest(url, headers, finalBody);
      }
      logger.logProviderResponse(response.status, response.statusText, response.headers, null);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let receivedBytes = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        receivedBytes += item.value.byteLength;
        const text = decoder.decode(item.value, { stream: true });
        // These are the production RequestLogger taps called from stream.ts as
        // provider, OpenAI-projected, and client-converted frames pass through.
        logger.appendProviderChunk(text);
        logger.appendOpenAIChunk(text);
        logger.appendConvertedChunk(text);
      }
      logger.logConvertedResponse(null);
      if (receivedBytes !== totalResponseBytes)
        throw new Error(`fake upstream response truncated: ${receivedBytes}/${totalResponseBytes}`);

      const pipelinePayloads = logger.getPipelinePayloads();
      const providerRequestBody = pipelinePayloads?.providerRequest?.body;
      if (Array.isArray(providerRequestBody?.input)) capturedProviderBodies++;
      await saveCallLog({
        id,
        timestamp: new Date().toISOString(),
        method: "POST",
        path: "/v1/responses",
        status: response.status,
        model: "gpt-6.1-sol",
        requestedModel: "gpt-6.1-sol",
        provider: "codex",
        account: `benchmark-${index % 4}`,
        connectionId: null,
        duration: 1,
        tokens: { in: 1, out: 1, cacheRead: null, cacheCreation: null, reasoning: null },
        requestType: "responses",
        sourceFormat: "openai-responses",
        targetFormat: "openai-responses",
        requestBody: parsed,
        responseBody: null,
        error: null,
        pipelinePayloads,
      });
      capture.release?.();
    })
  );

  clearInterval(sampler);
  sampler = undefined;
  const elapsedMs = performance.now() - startedAt;
  const states = { ready: 0, missing: 0, corrupt: 0, other: 0 };
  let artifactBytes = 0;
  let artifactsWithStreamChunks = 0;
  let storedProviderBodies = 0;
  for (const id of ids) {
    const detail = await getCallLogById(id);
    const state = detail?.detailState ?? "other";
    if (state in states) states[state]++;
    else states.other++;
    if (!detail?.artifactRelPath || !callLogsDir) continue;
    const artifactPath = path.join(callLogsDir, detail.artifactRelPath);
    artifactBytes += fs.statSync(artifactPath).size;
    if (detail.pipelinePayloads?.streamChunks) artifactsWithStreamChunks++;
    const providerRequestBody = detail.pipelinePayloads?.providerRequest?.body;
    if (Array.isArray(providerRequestBody?.input)) storedProviderBodies++;
  }
  const ioAfter = readProcessIoBytes();
  const writer = artifactWriter.getCallLogArtifactWriterSnapshot();
  console.log(
    JSON.stringify(
      {
        runtime: process.versions.bun ? `bun-${process.versions.bun}` : `node-${process.version}`,
        workload:
          "production request logger + runWithCapture/fake fetch + logger stream taps + saveCallLog",
        clients,
        targetRequestBytes: requestBytes,
        actualSerializedRequestBytes: requestBytes,
        responseBytesPerClient: totalResponseBytes,
        streamChunksPerClient: responseChunks.length,
        captureStreamChunks,
        finalizerDedupEnabled,
        diagnosticOverflow: false,
        fakeUpstreamRequests,
        capturedProviderBodies,
        finalizerDuplicateLogsSkipped,
        elapsedMs: Math.round(elapsedMs),
        states,
        artifactsWithStreamChunks,
        storedProviderBodies,
        artifactBytes,
        peakSampledRssMiB: Math.round((peakRssBytes / 1024 / 1024) * 10) / 10,
        peakSampledHeapUsedMiB: Math.round((peakHeapUsedBytes / 1024 / 1024) * 10) / 10,
        kernelPeakRssMiB: readLinuxPeakRssMiB(),
        processIoBytes:
          ioBefore && ioAfter
            ? {
                readBytes: Math.max(0, ioAfter.readBytes - ioBefore.readBytes),
                writeBytes: Math.max(0, ioAfter.writeBytes - ioBefore.writeBytes),
                cancelledWriteBytes: Math.max(
                  0,
                  ioAfter.cancelledWriteBytes - ioBefore.cancelledWriteBytes
                ),
              }
            : null,
        processIoScope:
          "DB initialized to completed call-log readback; includes SQLite and artifact I/O",
        artifactWriter: {
          activeJobsHighWater: writer.activeJobsHighWater,
          queuedArtifactsHighWater: writer.queuedArtifactsHighWater,
          reservedArtifactBytesHighWater: writer.reservedArtifactBytesHighWater,
          detailOmissionsTotal: writer.detailOmissionsTotal,
          preparationRefusalsTotal: writer.preparationRefusalsTotal,
          preparationRefusalsSingleArtifactBudgetTotal:
            writer.preparationRefusalsSingleArtifactBudgetTotal,
          preparationRefusalsAggregateReservationBudgetTotal:
            writer.preparationRefusalsAggregateReservationBudgetTotal,
          workerFailuresTotal: writer.workerFailuresTotal,
        },
        tempDataDirBytes: directoryBytes(dataDir),
      },
      null,
      2
    )
  );
} finally {
  if (sampler) clearInterval(sampler);
  globalThis.fetch = originalFetch;
  if (closeCallLogSaves) await closeCallLogSaves();
  if (artifactWriter) await artifactWriter.closeCallLogArtifactWriter();
  if (resetDbInstance) resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
