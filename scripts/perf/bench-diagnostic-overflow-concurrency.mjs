#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";

const [clientArg = "100", requestBytesArg = "4194304", responseBytesArg = "65536"] =
  process.argv.slice(2);
const clients = Number(clientArg);
const requestBytes = Number(requestBytesArg);
const responseBytes = Number(responseBytesArg);
const captureEnabled = process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED === "true";
const contentPayload = randomBytes(Math.ceil((requestBytes * 3) / 4) + 8).toString("base64");

for (const [name, value] of Object.entries({ clients, requestBytes, responseBytes })) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`);
}
if (clients > 150) throw new Error("clients is capped at 150 for this local synthetic benchmark");

let ownedDataDir = false;
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.homedir(), ".omni-diagnostic-bench-"));
  fs.chmodSync(process.env.DATA_DIR, 0o700);
  ownedDataDir = true;
}
process.env.APP_LOG_TO_FILE ||= "false";
process.env.OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES ??= String(requestBytes);
process.env.OMNI_DIAGNOSTIC_OVERFLOW_TOTAL_BYTES ??= String(2 * 1024 * 1024 * 1024);
process.env.OMNI_DIAGNOSTIC_OVERFLOW_FILE_BYTES ??= String(64 * 1024 * 1024);

const { createRequestLogger } = await import("../../open-sse/utils/requestLogger.ts");
const { createPreparedRequestLogger, runWithCapture } =
  await import("../../open-sse/utils/providerRequestLogging.ts");
const { readDiagnosticOverflowManifest } =
  await import("../../src/lib/usage/diagnosticOverflow.ts");

function requestBodyFor(sessionId) {
  const prefix = `session-${sessionId}:`;
  const skeleton = JSON.stringify({
    model: "gpt-6.1-sol",
    input: [{ role: "user", content: prefix }],
  });
  const fillerLength = requestBytes - Buffer.byteLength(skeleton);
  if (fillerLength < 0) throw new Error("requestBytes is too small for the JSON envelope");
  const body = JSON.stringify({
    model: "gpt-6.1-sol",
    input: [{ role: "user", content: `${prefix}${contentPayload.slice(0, fillerLength)}` }],
  });
  if (Buffer.byteLength(body) !== requestBytes) throw new Error("request envelope size mismatch");
  return body;
}

function dataDirectoryBytes(directory) {
  if (!fs.existsSync(directory)) return 0;
  let total = 0;
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile()) total += fs.statSync(target).size;
    }
  }
  return total;
}

const originalFetch = globalThis.fetch;
const streamGate = new Promise((resolve) => {
  globalThis.__diagnosticBenchmarkReleaseStreams = resolve;
});
let activeStreams = 0;
let peakActiveStreams = 0;
let gateReleased = false;
const providerDispatchAt = new Map();
const responsePayload = randomBytes(responseBytes);
const responseTail = Buffer.from("\n\ndata: [DONE]\n\n");
globalThis.fetch = async (_input, init) => {
  const sent = String(init?.body ?? "");
  const parsed = JSON.parse(sent);
  const sessionId = /^session-(\d+):/.exec(parsed.input?.[0]?.content ?? "")?.[1];
  if (sessionId !== undefined) providerDispatchAt.set(Number(sessionId), performance.now());
  const response = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < responsePayload.byteLength; offset += 64 * 1024)
        controller.enqueue(responsePayload.subarray(offset, offset + 64 * 1024));
    },
    async pull(controller) {
      if (!gateReleased) {
        await streamGate;
        gateReleased = true;
      }
      controller.enqueue(responseTail);
      controller.close();
    },
  });
  if (!parsed.model) throw new Error("mock upstream received a request without a model");
  return new Response(response, {
    status: 429,
    headers: {
      "content-type": "text/event-stream",
      "retry-after": "1",
      "x-request-id": "synthetic-overflow-benchmark",
    },
  });
};

const before = process.memoryUsage();
let peakRssBytes = before.rss;
let peakHeapUsedBytes = before.heapUsed;
const sampleTimer = setInterval(() => {
  const memory = process.memoryUsage();
  peakRssBytes = Math.max(peakRssBytes, memory.rss);
  peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
}, 10);
sampleTimer.unref();

const startedAt = performance.now();
const loggerSetupMs = [];
const requestPreDispatchMs = [];
const firstHeadersMs = [];
const completedMs = [];
const traces = [];
const finalizationPromises = [];
let pipelineSnapshotsObserved = 0;
try {
  const tasks = Array.from({ length: clients }, async (_, index) => {
    const requestBody = requestBodyFor(index);
    const clientBody = JSON.parse(requestBody);
    const started = performance.now();
    const logger = await createRequestLogger(undefined, undefined, undefined, {
      enabled: true,
      provider: "codex",
      diagnosticOverflowEligible: captureEnabled,
      diagnosticClientJson: () => requestBody,
      captureStreamChunks: false,
      model: "gpt-6.1-sol",
      requestId: `bench-${index}`,
    });
    logger.logClientRawRequest("/v1/responses", clientBody);
    const loggerReadyAt = performance.now();
    loggerSetupMs.push(loggerReadyAt - started);
    const trace = logger.getDiagnosticOverflowTrace();
    if (trace) traces.push(trace);
    const capture = createPreparedRequestLogger(
      logger,
      { id: `bench-${index}`, model: "gpt-6.1-sol", provider: "codex", connectionId: null },
      { enabled: true, provider: "codex" }
    );
    const response = await runWithCapture(capture, () =>
      fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      })
    );
    requestPreDispatchMs.push((providerDispatchAt.get(index) ?? performance.now()) - started);
    firstHeadersMs.push(performance.now() - started);
    logger.logProviderResponse(response.status, response.statusText, response.headers, null);
    const reader = response.body.getReader();
    let bytes = 0;
    const first = await reader.read();
    if (!first.done) bytes += first.value.byteLength;
    activeStreams++;
    peakActiveStreams = Math.max(peakActiveStreams, activeStreams);
    if (activeStreams === clients) {
      setTimeout(() => {
        gateReleased = true;
        globalThis.__diagnosticBenchmarkReleaseStreams?.();
      }, 100);
    }
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
    }
    activeStreams--;
    if (bytes < responseBytes) throw new Error(`mock response truncated for session ${index}`);
    if (trace) finalizationPromises.push(trace.finish());
    const elapsed = performance.now() - started;
    completedMs.push(elapsed);
    if (logger.getPipelinePayloads()) pipelineSnapshotsObserved++;
    return true;
  });
  await Promise.all(tasks);
  const allResponsesFinishedMs = performance.now() - startedAt;
  await Promise.all(finalizationPromises);
  const allCapturesFinalizedMs = performance.now() - startedAt;
  const manifests = await Promise.all(
    traces.map(async (trace) => readDiagnosticOverflowManifest(trace.traceId))
  );
  const traceSnapshots = traces.map((trace) => trace.snapshot());
  const after = process.memoryUsage();
  const sorted = (values) => [...values].sort((left, right) => left - right);
  const percentile = (values, ratio) =>
    sorted(values)[Math.min(values.length - 1, Math.floor(values.length * ratio))] ?? 0;
  const dataDir = process.env.DATA_DIR;
  console.log(
    JSON.stringify(
      {
        runtime: `node ${process.version}`,
        captureEnabled,
        clients,
        requestBytes,
        responseBytes,
        payloadEncoding: "base64-encoded random bytes; bounded 4 MiB JSON per request",
        startToHeadersMs: {
          p50: percentile(firstHeadersMs, 0.5),
          p95: percentile(firstHeadersMs, 0.95),
          max: Math.max(...firstHeadersMs),
        },
        loggerSetupMs: {
          p50: percentile(loggerSetupMs, 0.5),
          p95: percentile(loggerSetupMs, 0.95),
          max: Math.max(...loggerSetupMs),
        },
        requestPreDispatchMs: {
          p50: percentile(requestPreDispatchMs, 0.5),
          p95: percentile(requestPreDispatchMs, 0.95),
          max: Math.max(...requestPreDispatchMs),
        },
        endToEndMs: {
          p50: percentile(completedMs, 0.5),
          p95: percentile(completedMs, 0.95),
          max: Math.max(...completedMs),
        },
        totalMs: performance.now() - startedAt,
        allResponsesFinishedMs,
        allCapturesFinalizedMs,
        captureFinalizeTailMs: allCapturesFinalizedMs - allResponsesFinishedMs,
        peakActiveStreams,
        peakRssMiB: Math.round((peakRssBytes / 1024 / 1024) * 10) / 10,
        peakHeapUsedMiB: Math.round((peakHeapUsedBytes / 1024 / 1024) * 10) / 10,
        finalRssMiB: Math.round((after.rss / 1024 / 1024) * 10) / 10,
        finalHeapUsedMiB: Math.round((after.heapUsed / 1024 / 1024) * 10) / 10,
        diagnosticTraces: traces.length,
        unpersistedTraces: traceSnapshots.filter((snapshot) => snapshot.persisted === false).length,
        traceFailureReasons: traceSnapshots.reduce((counts, snapshot) => {
          if (snapshot.reason) counts[snapshot.reason] = (counts[snapshot.reason] ?? 0) + 1;
          return counts;
        }, {}),
        completeTraces: manifests.filter((manifest) => manifest?.state === "complete").length,
        incompleteTraces: manifests.filter((manifest) => manifest?.state === "incomplete").length,
        pipelineSnapshotsObserved,
        diagnosticDirectoryBytes: dataDir
          ? dataDirectoryBytes(path.join(dataDir, "diagnostic_overflow"))
          : 0,
      },
      null,
      2
    )
  );
} finally {
  clearInterval(sampleTimer);
  globalThis.fetch = originalFetch;
  delete globalThis.__diagnosticBenchmarkReleaseStreams;
  if (ownedDataDir && process.env.DATA_DIR)
    fs.rmSync(process.env.DATA_DIR, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
}
