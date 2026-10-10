import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import { Readable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { createGunzip, gunzipSync } from "node:zlib";
import { fetch as clientFetch } from "undici";
import {
  createProcessMemorySampler,
  snapshotCgroupMemory,
  snapshotProcessMemory,
} from "../fixtures/process-memory-snapshot.mjs";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-antigravity-parallel-e2e-"));
process.env.DATA_DIR = dataDir;
process.env.REQUIRE_API_KEY = "true";
process.env.API_KEY_SECRET = "synthetic-antigravity-e2e-signing-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.APP_LOG_LEVEL = "error";
// Preserve the conservative test default, but allow a higher-capacity diagnostic
// run to match production's direct-dispatcher default of 32 connections.
process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS ??= "8";
process.env.ANTIGRAVITY_CREDITS = "never";
const captureCallLogs = process.env.RUN_ANTIGRAVITY_CAPTURE_BENCH === "1";
const capturePrivateOverflow =
  captureCallLogs && process.env.ANTIGRAVITY_CAPTURE_OVERFLOW_BENCH === "1";
const captureAdmissionBench = process.env.ANTIGRAVITY_CAPTURE_ADMISSION_BENCH === "1";
const captureOverflowMinClientBytes = process.env.ANTIGRAVITY_CAPTURE_OVERFLOW_MIN_CLIENT_BYTES;
const captureContextBytes = Math.max(0, Number(process.env.ANTIGRAVITY_CAPTURE_CONTEXT_BYTES || 0));
const sessionAffinityTtlMs = Math.max(
  0,
  Number(process.env.ANTIGRAVITY_SESSION_AFFINITY_TTL_MS) || 60_000
);
const requestedSessionCounts = (process.env.ANTIGRAVITY_CAPTURE_SESSION_COUNTS || "")
  .split(",")
  .map(Number)
  .filter((count) => Number.isInteger(count) && count > 0);
const sessionCounts =
  requestedSessionCounts.length > 0
    ? requestedSessionCounts
    : captureCallLogs && process.env.ANTIGRAVITY_CAPTURE_SINGLE_SESSION === "1"
      ? [1]
      : [1, 30, 70, 100];
const expectedRequests = sessionCounts.reduce((total, count) => total + count * 2, 0);
if (captureCallLogs) {
  process.env.ENABLE_REQUEST_LOGS = "true";
  process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS = "true";
  process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "10240";
  process.env.CHAT_LOG_TEXT_LIMIT = "65536";
  process.env.CHAT_LOG_CLIENT_TEXT_LIMIT = "4194304";
}
if (capturePrivateOverflow) {
  process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "true";
  process.env.OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES = String(
    captureOverflowMinClientBytes !== undefined
      ? captureOverflowMinClientBytes
      : captureContextBytes > 0
        ? captureContextBytes * 4
        : 0
  );
}
// Leave the background quota timer outside this isolated test lifetime.
process.env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS = "3600000";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const settings = await import("../../src/lib/db/settings.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const route = await import("../../src/app/api/v1/chat/completions/route.ts");
const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
const { CALL_LOGS_DIR, readCallArtifact } = await import("../../src/lib/usage/callLogArtifacts.ts");
const versions = await import("../../open-sse/services/antigravityVersion.ts");
const routeRequestTimingContext = new AsyncLocalStorage<{
  bodyCompleteAtMs: number | null;
  providerFetchStartedAtMs: number[];
}>();

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function spawnFixture(scriptName: string, extraEnv: Record<string, string> = {}) {
  const fixturePath = path.resolve("tests/fixtures", scriptName);
  // Keep mock upstream/client runtimes independently selectable from the gateway runtime so
  // Bun-vs-Node route tests do not also change the load generator's HTTP stack.
  const fixtureRuntime = process.env.ANTIGRAVITY_FIXTURE_RUNTIME || process.execPath;
  const child = spawn(fixtureRuntime, [fixturePath], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.on("data", (chunk: string) => (stderr += chunk));
  return {
    child,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
  };
}

async function startMockUpstream() {
  const fixture = spawnFixture("antigravity-parallel-mock-upstream.mjs");
  const { child } = fixture;
  let buffered = "";
  const ready = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("mock upstream did not start within 10s")),
      10_000
    );
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      const match = buffered.match(/LISTENING (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (!buffered.includes("LISTENING ")) {
        clearTimeout(timeout);
        reject(
          new Error(`mock upstream exited before listening (${code ?? signal}): ${fixture.stderr}`)
        );
      }
    });
  });
  return {
    child,
    get stdout() {
      return fixture.stdout;
    },
    get stderr() {
      return fixture.stderr;
    },
    url: await ready,
  };
}

async function stopFixture(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function runFixture(fixture: ReturnType<typeof spawnFixture>): Promise<string> {
  const { child } = fixture;
  const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
  if (code !== 0) {
    throw new Error(`load fixture exited (${code ?? signal})\n${fixture.stderr}`);
  }
  return fixture.stdout;
}

async function readPrivateCapture(
  traceId: string,
  attemptId: string,
  kind: "client-request" | "request" | "response"
): Promise<Buffer> {
  const { openDiagnosticOverflowFile } = await import("../../src/lib/usage/diagnosticOverflow.ts");
  const opened = await openDiagnosticOverflowFile(traceId, attemptId, kind);
  assert.equal(opened.state, "ready", `${kind} trace file should be readable`);
  if (opened.state !== "ready") throw new Error(`private trace ${kind} file is unavailable`);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  return gunzipSync(Buffer.concat(chunks));
}

/** Validate every persisted capture without retaining each decompressed payload. */
async function verifyPrivateCaptureReadable(
  traceId: string,
  attemptId: string,
  kind: "client-request" | "request" | "response",
  expectedRawBytes: number
): Promise<number> {
  const { openDiagnosticOverflowFile } = await import("../../src/lib/usage/diagnosticOverflow.ts");
  const opened = await openDiagnosticOverflowFile(traceId, attemptId, kind);
  assert.equal(opened.state, "ready", `${kind} trace file should be readable`);
  if (opened.state !== "ready") throw new Error(`private trace ${kind} is unavailable`);

  const gunzip = createGunzip();
  opened.stream.pipe(gunzip);
  let rawBytes = 0;
  let prefix = Buffer.alloc(0);
  for await (const chunk of gunzip) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    rawBytes += bytes.byteLength;
    if (prefix.byteLength < 4096) {
      prefix = Buffer.concat([prefix, bytes.subarray(0, 4096 - prefix.byteLength)]);
    }
  }
  assert.equal(rawBytes, expectedRawBytes, `${kind} decompressed byte count should match manifest`);
  assert.ok(rawBytes > 0, `${kind} capture should not be empty`);
  if (kind !== "response") {
    assert.equal(prefix[0], 0x7b, `${kind} JSON should start with an object`);
  } else {
    assert.match(prefix.toString("utf8"), /data: /, "provider response should contain SSE data");
  }
  return rawBytes;
}

type AdmissionBenchmarkSnapshot = {
  activeHeavy: number;
  activeHealthyHeadroom: number;
  byteBudgetQueuedBytes: number;
  budgetSource: string;
  inflightBytes: number;
  maxInflightBytes: number;
  queuedBytes: number;
  shedTotal: number;
  shedsByReason: Record<string, number>;
  waiting: number;
};

/** Opt-in scalar-only sampler; never retain or emit the snapshot's opaque lane keys. */
function createAdmissionSampler(
  getSnapshot: () => AdmissionBenchmarkSnapshot,
  maxQueuedBytes: number
) {
  const startedAt = Date.now();
  const maxima = {
    inflightBytes: 0,
    maxInflightBytes: 0,
    waiting: 0,
    queuedBytes: 0,
    byteBudgetQueuedBytes: 0,
    activeHeavy: 0,
    activeHealthyHeadroom: 0,
    shedTotal: 0,
    shedsByReason: {} as Record<string, number>,
  };
  const budgetSources = new Set<string>();
  let samples = 0;
  let finalSnapshot:
    | (Omit<AdmissionBenchmarkSnapshot, "shedsByReason"> & {
        shedsByReason: Record<string, number>;
      })
    | null = null;

  const observe = () => {
    const snapshot = getSnapshot();
    samples++;
    budgetSources.add(snapshot.budgetSource);
    for (const key of [
      "inflightBytes",
      "maxInflightBytes",
      "waiting",
      "queuedBytes",
      "byteBudgetQueuedBytes",
      "activeHeavy",
      "activeHealthyHeadroom",
      "shedTotal",
    ] as const) {
      maxima[key] = Math.max(maxima[key], snapshot[key]);
    }
    for (const [reason, count] of Object.entries(snapshot.shedsByReason)) {
      maxima.shedsByReason[reason] = Math.max(maxima.shedsByReason[reason] ?? 0, count);
    }
    finalSnapshot = {
      activeHeavy: snapshot.activeHeavy,
      activeHealthyHeadroom: snapshot.activeHealthyHeadroom,
      byteBudgetQueuedBytes: snapshot.byteBudgetQueuedBytes,
      budgetSource: snapshot.budgetSource,
      inflightBytes: snapshot.inflightBytes,
      maxInflightBytes: snapshot.maxInflightBytes,
      queuedBytes: snapshot.queuedBytes,
      shedTotal: snapshot.shedTotal,
      shedsByReason: { ...snapshot.shedsByReason },
      waiting: snapshot.waiting,
    };
  };

  observe();
  const timer = setInterval(observe, 75);
  timer.unref?.();

  return {
    finish() {
      clearInterval(timer);
      observe();
      return {
        intervalMs: 75,
        samples,
        elapsedMs: Date.now() - startedAt,
        maxQueuedBytes,
        budgetSources: [...budgetSources].sort(),
        maxima,
        final: finalSnapshot,
        inflightSaturated: maxima.inflightBytes >= maxima.maxInflightBytes,
        structuralQueueSaturated: maxima.queuedBytes >= maxQueuedBytes,
        byteQueueSaturated: maxima.byteBudgetQueuedBytes >= maxQueuedBytes,
        maxInflightUtilization:
          maxima.maxInflightBytes > 0 ? maxima.inflightBytes / maxima.maxInflightBytes : 0,
        maxQueuedUtilization:
          maxQueuedBytes > 0
            ? Math.max(maxima.queuedBytes, maxima.byteBudgetQueuedBytes) / maxQueuedBytes
            : 0,
      };
    },
  };
}

async function finalPrivateManifest(traceId: string) {
  const { readDiagnosticOverflowManifest } =
    await import("../../src/lib/usage/diagnosticOverflow.ts");
  for (let attempt = 0; attempt < 40; attempt++) {
    const manifest = await readDiagnosticOverflowManifest(traceId);
    if (manifest?.state !== "capturing") return manifest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return readDiagnosticOverflowManifest(traceId);
}

test(
  "authenticated Antigravity HTTP isolates 1/30/70/100 conversations and tool signatures",
  { timeout: captureContextBytes > 0 ? 600_000 : 120_000 },
  async () => {
    let maxClientRequestBytes = 0;
    const errors: string[] = [];
    const routeReadyLatenciesMs: number[] = [];
    const clientToGatewayDelaysMs: number[] = [];
    const bodyCompleteToProviderFetchMs: number[] = [];
    const providerFetchAttemptCounts: number[] = [];
    let routeHeadersPendingAt25s = 0;
    const routeHeadersPendingSessions = new Set<string>();
    const gatewayCounts = {
      accepted: 0,
      bodyComplete: 0,
      routeResolved: 0,
      headersWritten: 0,
      errors: 0,
      active: 0,
      maxActive: 0,
      clientDisconnects: 0,
      firstBodyChunks: 0,
      responseCompleted: 0,
      responseBytes: 0,
      backpressureWaits: 0,
    };
    const gatewaySessions = new Map<
      string,
      {
        accepted: number;
        bodyComplete: number;
        routeResolved: number;
        headersWritten: number;
        active: number;
        firstBodyChunk: boolean;
        responseCompleted: number;
        responseBytes: number;
        headersFlushedAtMs: number | null;
        firstBodyChunkAtMs: number | null;
        responseCompletedAtMs: number | null;
        clientToGatewayDelayMs: number | null;
        startedAtEpochMs: number[];
        bodyCompleteMs: number[];
        routeReadyMs: number[];
      }
    >();
    let upstreamFixture: Awaited<ReturnType<typeof startMockUpstream>> | null = null;
    let clientFixture: ReturnType<typeof spawnFixture> | null = null;
    const captureMemoryBench = process.env.ANTIGRAVITY_CAPTURE_MEMORY_BENCH === "1";
    const memorySampler = captureMemoryBench ? createProcessMemorySampler(1_000) : null;
    const eventLoopDelay = captureMemoryBench ? monitorEventLoopDelay({ resolution: 20 }) : null;
    eventLoopDelay?.enable();
    let admissionSampler: ReturnType<typeof createAdmissionSampler> | null = null;
    let clientMemorySnapshot: Record<string, unknown> | null = null;
    let upstreamMemorySnapshot: Record<string, unknown> | null = null;
    let upstreamStatsForDiagnostics: Record<string, unknown> | null = null;
    let instrumentedUpstreamUrl: string | null = null;
    let restoreFetch = () => {};
    const gateway = http.createServer(async (incoming, outgoing) => {
      const routeStartedAt = performance.now();
      const sessionId =
        typeof incoming.headers["x-omniroute-session-id"] === "string"
          ? incoming.headers["x-omniroute-session-id"]
          : "unknown";
      const clientStartedAt = Number(incoming.headers["x-omniroute-fixture-started-at"]);
      const clientToGatewayDelayMs = Number.isFinite(clientStartedAt)
        ? Math.max(0, Date.now() - clientStartedAt)
        : null;
      if (clientToGatewayDelayMs !== null) clientToGatewayDelaysMs.push(clientToGatewayDelayMs);
      const sessionCounts = gatewaySessions.get(sessionId) ?? {
        accepted: 0,
        bodyComplete: 0,
        routeResolved: 0,
        headersWritten: 0,
        active: 0,
        firstBodyChunk: false,
        responseCompleted: 0,
        responseBytes: 0,
        headersFlushedAtMs: null,
        firstBodyChunkAtMs: null,
        responseCompletedAtMs: null,
        clientToGatewayDelayMs: null,
        startedAtEpochMs: [],
        bodyCompleteMs: [],
        routeReadyMs: [],
      };
      sessionCounts.clientToGatewayDelayMs ??= clientToGatewayDelayMs;
      sessionCounts.startedAtEpochMs.push(Date.now());
      sessionCounts.accepted++;
      sessionCounts.active++;
      gatewaySessions.set(sessionId, sessionCounts);
      gatewayCounts.accepted++;
      gatewayCounts.active++;
      gatewayCounts.maxActive = Math.max(gatewayCounts.maxActive, gatewayCounts.active);
      const routeAbort = new AbortController();
      const routeRequestTiming = {
        bodyCompleteAtMs: null as number | null,
        providerFetchStartedAtMs: [] as number[],
      };
      let clientDisconnectRecorded = false;
      const abortForClientDisconnect = () => {
        if (!clientDisconnectRecorded) {
          clientDisconnectRecorded = true;
          gatewayCounts.clientDisconnects++;
        }
        if (!routeAbort.signal.aborted)
          routeAbort.abort(new Error("synthetic_client_disconnected"));
      };
      const onClientResponseClosed = () => {
        if (!outgoing.writableEnded) abortForClientDisconnect();
      };
      incoming.once("aborted", abortForClientDisconnect);
      outgoing.once("close", onClientResponseClosed);
      const routePendingTimer = setTimeout(() => {
        routeHeadersPendingAt25s++;
        routeHeadersPendingSessions.add(sessionId);
        process.stderr.write(
          `ANTIGRAVITY_ROUTE_HEADERS_PENDING session=${sessionId} activeAt25s=${routeHeadersPendingAt25s}\n`
        );
      }, 25_000);
      routePendingTimer.unref?.();
      try {
        let requestBytes = 0;
        const incomingBody = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        const countedBody = incomingBody.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              requestBytes += chunk.byteLength;
              controller.enqueue(chunk);
            },
            flush() {
              maxClientRequestBytes = Math.max(maxClientRequestBytes, requestBytes);
              sessionCounts.bodyComplete++;
              gatewayCounts.bodyComplete++;
              sessionCounts.bodyCompleteMs.push(performance.now() - routeStartedAt);
              routeRequestTiming.bodyCompleteAtMs = performance.now();
            },
          })
        );
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (typeof value === "string" && name !== "x-omniroute-fixture-started-at")
            headers.set(name, value);
        const response = await routeRequestTimingContext.run(routeRequestTiming, () =>
          route.POST(
            new Request(
              `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/chat/completions`,
              {
                method: incoming.method,
                headers,
                body: countedBody,
                signal: routeAbort.signal,
                duplex: "half",
              } as RequestInit & {
                duplex: "half";
              }
            )
          )
        );
        clearTimeout(routePendingTimer);
        routeReadyLatenciesMs.push(performance.now() - routeStartedAt);
        sessionCounts.routeReadyMs.push(performance.now() - routeStartedAt);
        sessionCounts.routeResolved++;
        gatewayCounts.routeResolved++;
        if (outgoing.destroyed) return;
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        outgoing.flushHeaders();
        sessionCounts.headersFlushedAtMs = Math.round(performance.now() - routeStartedAt);
        sessionCounts.headersWritten++;
        gatewayCounts.headersWritten++;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              if (next.value.byteLength > 0) {
                if (!sessionCounts.firstBodyChunk) {
                  sessionCounts.firstBodyChunk = true;
                  gatewayCounts.firstBodyChunks++;
                  sessionCounts.firstBodyChunkAtMs = Math.round(performance.now() - routeStartedAt);
                }
                sessionCounts.responseBytes += next.value.byteLength;
                gatewayCounts.responseBytes += next.value.byteLength;
              }
              if (!outgoing.write(next.value)) {
                gatewayCounts.backpressureWaits++;
                await once(outgoing, "drain");
              }
            }
          } finally {
            reader.releaseLock();
          }
        }
        outgoing.end();
        sessionCounts.responseCompleted++;
        sessionCounts.responseCompletedAtMs = Math.round(performance.now() - routeStartedAt);
        gatewayCounts.responseCompleted++;
      } catch (error) {
        clearTimeout(routePendingTimer);
        sessionCounts.routeResolved++;
        gatewayCounts.routeResolved++;
        gatewayCounts.errors++;
        errors.push(String(error));
        if (!outgoing.destroyed && !outgoing.headersSent) {
          outgoing.writeHead(500);
          sessionCounts.headersWritten++;
          gatewayCounts.headersWritten++;
          outgoing.end('{"error":{"message":"isolated gateway test failed"}}');
        }
      } finally {
        if (
          routeRequestTiming.bodyCompleteAtMs !== null &&
          routeRequestTiming.providerFetchStartedAtMs.length > 0
        ) {
          bodyCompleteToProviderFetchMs.push(
            routeRequestTiming.providerFetchStartedAtMs[0] - routeRequestTiming.bodyCompleteAtMs
          );
        }
        providerFetchAttemptCounts.push(routeRequestTiming.providerFetchStartedAtMs.length);
        if (sessionCounts.active > 0) {
          sessionCounts.active--;
          gatewayCounts.active--;
        }
        incoming.removeListener("aborted", abortForClientDisconnect);
        outgoing.removeListener("close", onClientResponseClosed);
      }
    });
    let restoreUrl = () => {};
    try {
      versions.seedAntigravityIdeVersionCache("2.5.5-test");
      versions.seedAntigravityCliVersionCache("1.2.16-test");
      await settings.updateSettings({
        requireLogin: false,
        call_log_pipeline_enabled: captureCallLogs,
        sessionAffinityTtlMs,
        compression: { enabled: false },
        resilienceSettings: {
          quotaPreflight: { enabled: false },
          requestQueue: {
            autoEnableApiKeyProviders: false,
            globalConcurrentRequests: 0,
            maxWaitMs: 90000,
            maxQueueDepth: 256,
          },
        },
      });
      for (const profile of ["cli", "ide"])
        await providers.createProviderConnection({
          provider: "antigravity",
          authType: "oauth",
          name: `isolated-${profile}`,
          accessToken: `synthetic-${profile}`,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          isActive: true,
          testStatus: "active",
          providerSpecificData: { projectId: "synthetic-project", clientProfile: profile },
        });
      const key = await apiKeys.createApiKey("isolated-antigravity-http", "synthetic-test-machine");
      await apiKeys.updateApiKeyPermissions(key.id, {
        noLog: !captureCallLogs,
        compressionEnabled: false,
      });
      upstreamFixture = await startMockUpstream();
      const upstreamUrl = upstreamFixture.url;
      const gatewayUrl = await listen(gateway);
      const executor = await getExecutor("antigravity");
      const originalUrl = executor.buildUrl;
      restoreUrl = () => {
        executor.buildUrl = originalUrl;
      };
      executor.buildUrl = () => `${upstreamUrl}/generate`;
      instrumentedUpstreamUrl = upstreamUrl;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = function instrumentedFetch(input, init) {
        const timing = routeRequestTimingContext.getStore();
        const requestUrl =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (timing && instrumentedUpstreamUrl && requestUrl.startsWith(instrumentedUpstreamUrl))
          timing.providerFetchStartedAtMs.push(performance.now());
        return originalFetch.call(globalThis, input, init);
      };
      restoreFetch = () => {
        globalThis.fetch = originalFetch;
        instrumentedUpstreamUrl = null;
      };
      if (captureAdmissionBench) {
        const admission = await import("../../src/shared/middleware/chatBodyAdmission.ts");
        admissionSampler = createAdmissionSampler(
          () => admission.perConnectionAdmissionController.snapshot(),
          admission.CHAT_ADMISSION_MAX_QUEUED_BYTES
        );
      }
      clientFixture = spawnFixture("antigravity-parallel-client.mjs", {
        ANTIGRAVITY_GATEWAY_URL: gatewayUrl,
        ANTIGRAVITY_TEST_API_KEY: key.key,
        ANTIGRAVITY_CAPTURE_CONTEXT_BYTES: String(captureContextBytes),
        ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS:
          process.env.ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS || "30000",
        ANTIGRAVITY_CAPTURE_SINGLE_SESSION: process.env.ANTIGRAVITY_CAPTURE_SINGLE_SESSION || "0",
        ANTIGRAVITY_CAPTURE_SESSION_COUNTS: process.env.ANTIGRAVITY_CAPTURE_SESSION_COUNTS || "",
      });
      const clientOutput = await runFixture(clientFixture);
      const clientResult = JSON.parse(clientOutput.trim().split("\n").at(-1) ?? "{}");
      clientMemorySnapshot = clientResult.processMemory ?? null;
      assert.equal(clientResult.completedRequests, expectedRequests);
      assert.equal(maxClientRequestBytes, clientResult.maxClientRequestBytes);
      assert.deepEqual(errors, []);
      const upstreamStats = (await clientFetch(`${upstreamUrl}/__stats`).then((response) =>
        response.json()
      )) as {
        received: number;
        identities: Record<string, string>;
        phases: Record<string, string[]>;
        profiles: string[];
        errors: string[];
        receivedAtBySession: Record<string, number[]>;
        completedAtBySession: Record<string, number[]>;
        processMemory?: Record<string, unknown>;
      };
      upstreamStatsForDiagnostics = upstreamStats;
      upstreamMemorySnapshot = upstreamStats.processMemory ?? null;
      assert.equal(upstreamStats.received, expectedRequests);
      assert.deepEqual(upstreamStats.errors, []);
      if (captureCallLogs && process.env.ANTIGRAVITY_CAPTURE_SINGLE_SESSION === "1") {
        assert.equal(
          upstreamStats.profiles.length,
          1,
          "single-session capture mode exercises exactly one selected client profile"
        );
      } else {
        assert.deepEqual(upstreamStats.profiles, ["cli", "ide"]);
      }
      for (const value of Object.values(upstreamStats.phases)) {
        assert.deepEqual(value, ["tool", "answer"]);
      }
      assert.equal(Object.keys(upstreamStats.identities).length, expectedRequests / 2);
      assert.deepEqual(errors, []);

      if (captureCallLogs) {
        const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
        await closeCallLogSaves(60_000);
        const { getCallLogArtifactWriterSnapshot } =
          await import("../../src/lib/usage/callLogArtifactWriter.ts");
        const writerSnapshot = getCallLogArtifactWriterSnapshot();
        console.log(`ANTIGRAVITY_ARTIFACT_WRITER ${JSON.stringify(writerSnapshot)}`);
        if (process.env.ANTIGRAVITY_CAPTURE_REFUSAL_GAUGE_BENCH === "1") {
          const refusalGauges = {
            total: writerSnapshot.preparationRefusalsTotal,
            invalidEstimate: writerSnapshot.preparationRefusalsInvalidEstimateTotal,
            singleArtifactBudget: writerSnapshot.preparationRefusalsSingleArtifactBudgetTotal,
            aggregateReservationBudget:
              writerSnapshot.preparationRefusalsAggregateReservationBudgetTotal,
          };
          assert.equal(
            refusalGauges.total,
            refusalGauges.invalidEstimate +
              refusalGauges.singleArtifactBudget +
              refusalGauges.aggregateReservationBudget,
            "preparation refusal total must equal the sum of its reason-specific counters"
          );
          console.log(`ANTIGRAVITY_PREPARATION_REFUSAL_GAUGES ${JSON.stringify(refusalGauges)}`);
        }
        assert.equal(writerSnapshot.activeJobs, 0, "artifact writer should have no active jobs");
        assert.equal(writerSnapshot.queuedArtifacts, 0, "artifact writer queue should drain");
        assert.equal(writerSnapshot.queuedDiagnosticStubs, 0, "diagnostic stub queue should drain");
        assert.equal(
          writerSnapshot.reservedArtifactBytes,
          0,
          "artifact reservations should be released after the write drain"
        );
        if (capturePrivateOverflow) {
          assert.equal(writerSnapshot.preparationRefusalsTotal, 0);
          assert.equal(writerSnapshot.detailOmissionsTotal, 0);
          assert.equal(writerSnapshot.workerFailuresTotal, 0);
          assert.equal(writerSnapshot.pointerFallbackFailuresTotal, 0);
        }
        const rows = core
          .getDbInstance()
          .prepare(
            "SELECT id, artifact_relpath, detail_state, error_summary FROM call_logs ORDER BY timestamp ASC"
          )
          .all() as Array<{
          id: string;
          artifact_relpath: string | null;
          detail_state: string;
          error_summary: string | null;
        }>;
        const artifactRows = rows.filter((row) => row.artifact_relpath);
        assert.equal(
          rows.length,
          expectedRequests,
          "one call-log summary row should exist per client turn"
        );
        const fullArtifacts =
          captureContextBytes === 0
            ? artifactRows
            : artifactRows.filter(
                (row) =>
                  CALL_LOGS_DIR &&
                  fs.statSync(path.join(CALL_LOGS_DIR, row.artifact_relpath!)).size >= 64 * 1024
              );
        const pointerArtifacts = capturePrivateOverflow
          ? 0
          : artifactRows.length - fullArtifacts.length;
        const missingArtifactErrors = rows.reduce<Record<string, number>>((counts, row) => {
          if (row.artifact_relpath) return counts;
          const label = row.error_summary || row.detail_state || "unknown";
          counts[label] = (counts[label] ?? 0) + 1;
          return counts;
        }, {});
        console.log(
          `ANTIGRAVITY_ARTIFACTS rows=${rows.length} stored=${artifactRows.length} full=${fullArtifacts.length} privateOnly=${capturePrivateOverflow ? artifactRows.length : 0} pointer=${pointerArtifacts} missing=${rows.length - artifactRows.length} stateCounts=${JSON.stringify(rows.reduce<Record<string, number>>((counts, row) => ((counts[row.detail_state] = (counts[row.detail_state] ?? 0) + 1), counts), {}))} missingArtifactErrors=${JSON.stringify(missingArtifactErrors)}`
        );
        if (capturePrivateOverflow) {
          assert.equal(
            artifactRows.length,
            expectedRequests,
            "private-overflow references should keep an artifact row for every client turn"
          );
        } else if (captureContextBytes === 0) {
          assert.equal(
            artifactRows.length,
            expectedRequests,
            "detailed capture should persist every tool and answer leg for small requests"
          );
        }
        assert.ok(CALL_LOGS_DIR);
        const candidates = capturePrivateOverflow ? artifactRows : fullArtifacts;
        let detailedArtifact: ReturnType<typeof readCallArtifact> | null = null;
        let pipeline: Record<string, unknown> | undefined;
        let streamChunks: Record<string, unknown> | undefined;
        for (const candidate of [...candidates].reverse()) {
          const current = readCallArtifact(candidate.artifact_relpath);
          const currentPipeline = current.artifact?.pipeline as Record<string, unknown> | undefined;
          const currentChunks = currentPipeline?.streamChunks as
            Record<string, unknown> | undefined;
          if (currentChunks && Object.keys(currentChunks).length > 0) {
            detailedArtifact = current;
            pipeline = currentPipeline;
            streamChunks = currentChunks;
            break;
          }
        }
        assert.ok(detailedArtifact, "at least one streamed detail artifact should be retained");
        assert.equal(detailedArtifact!.state, "ready");
        if (capturePrivateOverflow) {
          assert.equal(pipeline?.diagnosticOverflowOnly, true);
          assert.equal(
            (pipeline?.clientRawRequest as { body?: unknown } | undefined)?.body,
            undefined
          );
          assert.equal(
            (pipeline?.providerRequest as { body?: unknown } | undefined)?.body,
            undefined
          );
          assert.equal(
            (pipeline?.providerResponse as { body?: unknown } | undefined)?.body,
            undefined
          );
        }
        const clientRequest = pipeline?.clientRawRequest as
          { body?: { messages?: Array<{ content?: unknown }> } } | undefined;
        const capturedUserBytes = (clientRequest?.body?.messages ?? []).reduce(
          (total, message) =>
            total + (typeof message.content === "string" ? Buffer.byteLength(message.content) : 0),
          0
        );
        if (captureContextBytes > 0 && !capturePrivateOverflow) {
          assert.ok(
            maxClientRequestBytes >= captureContextBytes * 5,
            `largest client request should include the five-turn body: ${maxClientRequestBytes}`
          );
          assert.ok(
            capturedUserBytes >= captureContextBytes * 5,
            `latest artifact should retain the five user-context bodies: ${capturedUserBytes}`
          );
        }
        console.log(
          `ANTIGRAVITY_CAPTURE records=${rows.length} artifacts=${artifactRows.length} maxRequestBytes=${maxClientRequestBytes} capturedUserBytes=${capturedUserBytes} dispatcherConnections=${process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS} streamChannels=${Object.keys(streamChunks).join(",")}`
        );
        if (capturePrivateOverflow) {
          const { projectDiagnosticOverflowReference } =
            await import("../../src/lib/usage/diagnosticOverflowTypes.ts");
          const { getActiveDiagnosticOverflowCount } =
            await import("../../src/lib/usage/diagnosticOverflow.ts");
          for (
            let attempt = 0;
            attempt < 400 && getActiveDiagnosticOverflowCount() > 0;
            attempt++
          ) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          assert.equal(getActiveDiagnosticOverflowCount(), 0, "private trace writers must drain");
          const traceIds = new Set<string>();
          const traceRows = artifactRows;
          for (const row of traceRows) {
            const artifact = readCallArtifact(row.artifact_relpath);
            const reference = projectDiagnosticOverflowReference(
              artifact.artifact?.pipeline?.diagnosticOverflow
            );
            assert.ok(reference, `artifact ${row.id} must carry a private trace reference`);
            traceIds.add(reference!.traceId);
          }
          assert.equal(traceIds.size, traceRows.length);
          const manifests = await Promise.all(
            [...traceIds].map((traceId) => finalPrivateManifest(traceId))
          );
          const fileDiagnostic = (
            file:
              | { state?: string; complete?: boolean; reason?: string; rawBytes?: number }
              | null
              | undefined
          ) =>
            file
              ? {
                  state: file.state,
                  complete: file.complete,
                  reason: file.reason,
                  rawBytes: file.rawBytes,
                }
              : null;
          const traceDiagnostics = manifests
            .filter(
              (manifest) =>
                manifest?.state !== "complete" ||
                manifest.clientRequest?.complete !== true ||
                manifest.attempts.length !== 1 ||
                manifest.attempts[0]?.request.complete !== true ||
                manifest.attempts[0]?.response.complete !== true
            )
            .map((manifest) => ({
              state: manifest?.state,
              reasons: manifest?.reasons,
              clientRequest: fileDiagnostic(manifest?.clientRequest),
              attempts: manifest?.attempts.map((attempt) => ({
                attemptId: attempt.attemptId,
                state: attempt.state,
                reason: attempt.reason,
                request: fileDiagnostic(attempt.request),
                response: fileDiagnostic(attempt.response),
              })),
            }));
          const manifestStateCounts = manifests.reduce<Record<string, number>>(
            (counts, manifest) => {
              const state = manifest?.state ?? "missing";
              counts[state] = (counts[state] ?? 0) + 1;
              return counts;
            },
            {}
          );
          console.log(
            `ANTIGRAVITY_TRACE_DIAGNOSTICS ${JSON.stringify({
              traceCount: manifests.length,
              manifestStateCounts,
              incompleteTraceCount: manifests.filter((manifest) => manifest?.state === "incomplete")
                .length,
              diagnosticTraceCount: traceDiagnostics.length,
              additionalDiagnosticTraceCount: Math.max(0, traceDiagnostics.length - 20),
              diagnosticTraces: traceDiagnostics.slice(0, 20),
            })}`
          );
          assert.ok(
            manifests.every(
              (manifest) =>
                manifest?.clientRequest?.complete === true &&
                manifest.attempts.length >= 1 &&
                manifest.attempts.every(
                  (attempt) =>
                    attempt.request.complete === true &&
                    (attempt.response.complete === true ||
                      typeof attempt.response.reason === "string")
                ) &&
                manifest.attempts.at(-1)?.response.complete === true
            ),
            "each trace must retain the full client/provider request and a complete final provider response"
          );
          assert.ok(
            manifests.every(
              (manifest) =>
                manifest?.state === "complete" ||
                (manifest?.state === "incomplete" &&
                  manifest.reasons.length > 0 &&
                  manifest.reasons.every((reason) => reason === "upstream_error") &&
                  manifest.attempts.some(
                    (attempt) =>
                      attempt.response.complete === false &&
                      attempt.response.reason === "upstream_error"
                  ))
            ),
            "only provider attempts that failed upstream may leave a trace explicitly incomplete"
          );
          const completeTraceCount = manifests.filter(
            (manifest) => manifest?.state === "complete"
          ).length;
          const retryTraceCount = manifests.filter(
            (manifest) => (manifest?.attempts.length ?? 0) > 1
          ).length;
          const sample =
            manifests.find((manifest) => manifest?.state === "complete") ??
            manifests.find((manifest) =>
              manifest?.attempts.some((attempt) => attempt.response.complete)
            );
          assert.ok(sample);
          const privateByteTotals = manifests.reduce(
            (total, manifest) => {
              if (!manifest) return total;
              const files = [
                manifest.clientRequest,
                ...manifest.attempts.flatMap((attempt) => [attempt.request, attempt.response]),
              ];
              for (const file of files) {
                if (!file) continue;
                total.rawBytes += file.rawBytes;
                total.compressedBytes += file.compressedBytes;
              }
              return total;
            },
            { rawBytes: 0, compressedBytes: 0 }
          );
          let readableRawBytes = 0;
          for (const manifest of manifests) {
            assert.ok(manifest, "every call-log reference should resolve to a manifest");
            if (!manifest) continue;
            assert.ok(manifest.clientRequest, "every trace should include its client request");
            readableRawBytes += await verifyPrivateCaptureReadable(
              manifest.traceId,
              manifest.traceId,
              "client-request",
              manifest.clientRequest!.rawBytes
            );
            for (const attempt of manifest.attempts) {
              assert.ok(attempt.request, "every provider attempt should include its request");
              assert.ok(attempt.response, "every provider attempt should include its response");
              readableRawBytes += await verifyPrivateCaptureReadable(
                manifest.traceId,
                attempt.attemptId,
                "request",
                attempt.request.rawBytes
              );
              readableRawBytes += await verifyPrivateCaptureReadable(
                manifest.traceId,
                attempt.attemptId,
                "response",
                attempt.response.rawBytes
              );
            }
          }
          const clientBody = await readPrivateCapture(
            sample!.traceId,
            sample!.traceId,
            "client-request"
          );
          const successfulAttempt = sample!.attempts.findLast(
            (attempt) => attempt.response.complete === true
          );
          assert.ok(successfulAttempt);
          const providerBody = await readPrivateCapture(
            sample!.traceId,
            successfulAttempt!.attemptId,
            "response"
          );
          assert.ok(clientBody.byteLength >= captureContextBytes * 5);
          assert.match(providerBody.toString("utf8"), /data: /);
          console.log(
            `ANTIGRAVITY_PRIVATE_OVERFLOW traces=${traceIds.size} complete=${completeTraceCount} retried=${retryTraceCount} incomplete=${manifests.length - completeTraceCount} rawBytes=${privateByteTotals.rawBytes} compressedBytes=${privateByteTotals.compressedBytes} readableRawBytes=${readableRawBytes} sampleClientBytes=${clientBody.byteLength} sampleProviderBytes=${providerBody.byteLength} minClientBytes=${process.env.OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES}`
          );
        }
      }
    } finally {
      restoreUrl();
      restoreFetch();
      if (admissionSampler) {
        console.log(
          `ANTIGRAVITY_ADMISSION_DIAGNOSTICS ${JSON.stringify(admissionSampler.finish())}`
        );
      }
      if (captureMemoryBench) {
        eventLoopDelay?.disable();
        if (!upstreamStatsForDiagnostics && upstreamFixture) {
          try {
            upstreamStatsForDiagnostics = (await clientFetch(`${upstreamFixture.url}/__stats`).then(
              (response) => response.json()
            )) as Record<string, unknown>;
          } catch {
            upstreamStatsForDiagnostics = null;
          }
        }
        const sorted = [...routeReadyLatenciesMs].sort((left, right) => left - right);
        const percentile = (value: number) =>
          Math.round(sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)] ?? 0);
        const unresolvedSessions = [...gatewaySessions.entries()]
          .filter(([, counts]) => counts.active > 0 || counts.routeResolved < counts.accepted)
          .map(([sessionId, counts]) => ({
            sessionId,
            accepted: counts.accepted,
            bodyComplete: counts.bodyComplete,
            routeResolved: counts.routeResolved,
            headersWritten: counts.headersWritten,
            firstBodyChunk: counts.firstBodyChunk,
            responseCompleted: counts.responseCompleted,
            responseBytes: counts.responseBytes,
            headersFlushedAtMs: counts.headersFlushedAtMs,
            firstBodyChunkAtMs: counts.firstBodyChunkAtMs,
            responseCompletedAtMs: counts.responseCompletedAtMs,
            clientToGatewayDelayMs: counts.clientToGatewayDelayMs,
            active: counts.active,
          }))
          .slice(0, 12);
        const eventLoopMs = (value: number | undefined) =>
          typeof value === "number" && Number.isFinite(value) ? Math.round(value / 1_000_000) : 0;
        const sortedIngressDelays = [...clientToGatewayDelaysMs].sort((a, b) => a - b);
        const ingressPercentile = (value: number) =>
          Math.round(
            sortedIngressDelays[Math.max(0, Math.ceil(sortedIngressDelays.length * value) - 1)] ?? 0
          );
        const clientFailures = [
          ...(clientFixture?.stderr.matchAll(
            /conversation=([^\s]+) turn=(\d+) stage=([a-z_]+) elapsedMs=(\d+)/g
          ) ?? []),
        ];
        const clientDiagnosticsJson = clientFixture?.stderr.match(
          /ANTIGRAVITY_CLIENT_DIAGNOSTICS (\{[^\n]+\})/
        )?.[1];
        let clientDiagnostics: Record<string, unknown> | null = null;
        if (clientDiagnosticsJson) {
          try {
            clientDiagnostics = JSON.parse(clientDiagnosticsJson) as Record<string, unknown>;
          } catch {
            clientDiagnostics = null;
          }
        }
        const clientFailure =
          clientFailures.find((failure) => Number(failure[4]) >= 30_000) ?? clientFailures.at(-1);
        const timedOutSession = clientFailure?.[1];
        const timedOutSessionCounts = timedOutSession
          ? gatewaySessions.get(timedOutSession)
          : undefined;
        const upstreamTelemetry = upstreamStatsForDiagnostics as {
          received?: number;
          errors?: string[];
          receivedAtBySession?: Record<string, number[]>;
        } | null;
        const upstreamReceiptsBySession = upstreamTelemetry?.receivedAtBySession ?? {};
        const gatewayToProviderDelaysMs: number[] = [];
        const bodyCompleteDelaysMs: number[] = [];
        const providerDelayAfterBodyMs: number[] = [];
        for (const [sessionId, receipts] of Object.entries(upstreamReceiptsBySession)) {
          const sessionMetrics = gatewaySessions.get(sessionId);
          const starts = sessionMetrics?.startedAtEpochMs ?? [];
          for (let index = 0; index < Math.min(starts.length, receipts.length); index++)
            gatewayToProviderDelaysMs.push(receipts[index] - starts[index]);
          for (const elapsedMs of sessionMetrics?.bodyCompleteMs ?? [])
            bodyCompleteDelaysMs.push(elapsedMs);
          const pairCount = Math.min(
            starts.length,
            receipts.length,
            sessionMetrics?.bodyCompleteMs.length ?? 0
          );
          for (let index = 0; index < pairCount; index++)
            providerDelayAfterBodyMs.push(
              receipts[index] - starts[index] - sessionMetrics!.bodyCompleteMs[index]
            );
        }
        const sortedGatewayToProviderDelays = gatewayToProviderDelaysMs.sort((a, b) => a - b);
        const sortedBodyCompleteDelays = bodyCompleteDelaysMs.sort((a, b) => a - b);
        const sortedProviderDelayAfterBody = providerDelayAfterBodyMs.sort((a, b) => a - b);
        const sortedBodyCompleteToFetchDelays = bodyCompleteToProviderFetchMs.sort((a, b) => a - b);
        const bodyCompleteToFetchPercentile = (value: number) =>
          Math.round(
            sortedBodyCompleteToFetchDelays[
              Math.max(0, Math.ceil(sortedBodyCompleteToFetchDelays.length * value) - 1)
            ] ?? 0
          );
        const gatewayToProviderPercentile = (value: number) =>
          Math.round(
            sortedGatewayToProviderDelays[
              Math.max(0, Math.ceil(sortedGatewayToProviderDelays.length * value) - 1)
            ] ?? 0
          );
        const timedOutProviderReceipts = timedOutSession
          ? (upstreamReceiptsBySession[timedOutSession] ?? [])
          : [];
        const timedOutGatewayStarts = timedOutSessionCounts?.startedAtEpochMs ?? [];
        process.stderr.write(
          `ANTIGRAVITY_GATEWAY_DIAGNOSTICS ${JSON.stringify({
            accepted: gatewayCounts.accepted,
            bodyComplete: gatewayCounts.bodyComplete,
            routeResolved: gatewayCounts.routeResolved,
            headersWritten: gatewayCounts.headersWritten,
            errors: gatewayCounts.errors,
            activeAtFailure: gatewayCounts.active,
            maxActive: gatewayCounts.maxActive,
            clientDisconnects: gatewayCounts.clientDisconnects,
            firstBodyChunks: gatewayCounts.firstBodyChunks,
            responseCompleted: gatewayCounts.responseCompleted,
            responseBytes: gatewayCounts.responseBytes,
            backpressureWaits: gatewayCounts.backpressureWaits,
            pendingAt25s: routeHeadersPendingAt25s,
            pendingSessionsAt25s: [...routeHeadersPendingSessions].slice(0, 12),
            routeReadyCount: sorted.length,
            routeReadyP50Ms: percentile(0.5),
            routeReadyP95Ms: percentile(0.95),
            routeReadyMaxMs: Math.round(sorted.at(-1) ?? 0),
            clientToGatewayDelayCount: sortedIngressDelays.length,
            clientToGatewayDelayP50Ms: ingressPercentile(0.5),
            clientToGatewayDelayP95Ms: ingressPercentile(0.95),
            clientToGatewayDelayMaxMs: Math.round(sortedIngressDelays.at(-1) ?? 0),
            eventLoopDelayMaxMs: eventLoopMs(eventLoopDelay?.max),
            eventLoopDelayP95Ms: eventLoopMs(eventLoopDelay?.percentile(95)),
            clientDiagnostics,
            upstream: {
              received: upstreamTelemetry?.received ?? null,
              errorCount: upstreamTelemetry?.errors?.length ?? null,
              gatewayToProviderDelayCount: sortedGatewayToProviderDelays.length,
              gatewayToProviderDelayP50Ms: gatewayToProviderPercentile(0.5),
              gatewayToProviderDelayP95Ms: gatewayToProviderPercentile(0.95),
              gatewayToProviderDelayMaxMs: Math.round(sortedGatewayToProviderDelays.at(-1) ?? 0),
              bodyCompleteToFetchCount: sortedBodyCompleteToFetchDelays.length,
              bodyCompleteToFetchP50Ms: bodyCompleteToFetchPercentile(0.5),
              bodyCompleteToFetchP95Ms: bodyCompleteToFetchPercentile(0.95),
              bodyCompleteToFetchMaxMs: Math.round(sortedBodyCompleteToFetchDelays.at(-1) ?? 0),
              providerFetchAttemptCount: providerFetchAttemptCounts.reduce(
                (total, count) => total + count,
                0
              ),
              bodyCompleteP50Ms: Math.round(
                sortedBodyCompleteDelays[
                  Math.max(0, Math.ceil(sortedBodyCompleteDelays.length * 0.5) - 1)
                ] ?? 0
              ),
              bodyCompleteP95Ms: Math.round(
                sortedBodyCompleteDelays[
                  Math.max(0, Math.ceil(sortedBodyCompleteDelays.length * 0.95) - 1)
                ] ?? 0
              ),
              providerDelayAfterBodyP50Ms: Math.round(
                sortedProviderDelayAfterBody[
                  Math.max(0, Math.ceil(sortedProviderDelayAfterBody.length * 0.5) - 1)
                ] ?? 0
              ),
              providerDelayAfterBodyP95Ms: Math.round(
                sortedProviderDelayAfterBody[
                  Math.max(0, Math.ceil(sortedProviderDelayAfterBody.length * 0.95) - 1)
                ] ?? 0
              ),
            },
            unresolvedSessions,
            clientFailure: clientFailure
              ? {
                  sessionId: clientFailure[1],
                  turn: Number(clientFailure[2]),
                  stage: clientFailure[3],
                  elapsedMs: Number(clientFailure[4]),
                  gateway: timedOutSessionCounts
                    ? {
                        accepted: timedOutSessionCounts.accepted,
                        bodyComplete: timedOutSessionCounts.bodyComplete,
                        bodyCompleteMs: timedOutSessionCounts.bodyCompleteMs,
                        routeResolved: timedOutSessionCounts.routeResolved,
                        headersWritten: timedOutSessionCounts.headersWritten,
                        firstBodyChunk: timedOutSessionCounts.firstBodyChunk,
                        responseCompleted: timedOutSessionCounts.responseCompleted,
                        responseBytes: timedOutSessionCounts.responseBytes,
                        headersFlushedAtMs: timedOutSessionCounts.headersFlushedAtMs,
                        firstBodyChunkAtMs: timedOutSessionCounts.firstBodyChunkAtMs,
                        responseCompletedAtMs: timedOutSessionCounts.responseCompletedAtMs,
                        clientToGatewayDelayMs: timedOutSessionCounts.clientToGatewayDelayMs,
                        routeReadyMs: timedOutSessionCounts.routeReadyMs,
                        gatewayToProviderDelayMs: timedOutProviderReceipts.map(
                          (receivedAt, index) =>
                            receivedAt - (timedOutGatewayStarts[index] ?? receivedAt)
                        ),
                        active: timedOutSessionCounts.active,
                      }
                    : null,
                }
              : null,
            dispatcherConnections: process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS,
          })}\n`
        );
      }
      if (memorySampler) {
        console.log(
          `ANTIGRAVITY_MEMORY gateway=${JSON.stringify(snapshotProcessMemory())} testRunner=${JSON.stringify(snapshotProcessMemory(process.ppid))} client=${JSON.stringify(clientMemorySnapshot)} upstream=${JSON.stringify(upstreamMemorySnapshot)} cgroup=${JSON.stringify(snapshotCgroupMemory())} series=${JSON.stringify(memorySampler.finish())}`
        );
      }
      await stopFixture(clientFixture?.child ?? null);
      gateway.closeAllConnections();
      if (gateway.listening) await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await stopFixture(upstreamFixture?.child ?? null);
      await new Promise((resolve) => setImmediate(resolve));
      flushProxyLogsSync();
      if (captureCallLogs) {
        const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
        await closeCallLogSaves(60_000);
      }
      core.closeDbInstance({ checkpointMode: null });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
);
