import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  createProcessMemorySampler,
  snapshotCgroupMemory,
} from "../fixtures/process-memory-snapshot.mjs";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-codex-parallel-http-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.REQUIRE_API_KEY = "false";
process.env.API_KEY_SECRET = "synthetic-codex-parallel-capture-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.APP_LOG_LEVEL = "error";
process.env.ENABLE_REQUEST_LOGS = "true";
process.env.CALL_LOG_PIPELINE_CAPTURE_STREAM_CHUNKS = "true";
process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "10240";
process.env.CALL_LOG_PIPELINE_STREAM_CHUNK_MAX_SIZE_KB = "1024";
process.env.CHAT_LOG_TEXT_LIMIT = "65536";
process.env.CHAT_LOG_CLIENT_TEXT_LIMIT = "4194304";
process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "true";
process.env.OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES = "400000";
process.env.OMNI_DIAGNOSTIC_OVERFLOW_TOTAL_BYTES = "2147483648";
process.env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS = "3600000";
process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS = "8";

const CODEX_RESPONSES_PATH = "/backend-api/codex/responses";
const CONTEXT_BYTES = Number(process.env.CODEX_CAPTURE_CONTEXT_BYTES || 200_000);
const MOCK_INPUT_TOKENS = Number(process.env.CODEX_CAPTURE_MOCK_INPUT_TOKENS || CONTEXT_BYTES * 4);
const CONTEXT_ENTROPY = process.env.CODEX_CAPTURE_CONTEXT_ENTROPY || "repeated";
const EXTERNAL_CLIENT_READY_FILE = process.env.CODEX_CAPTURE_EXTERNAL_CLIENT_READY_FILE || null;
const EXTERNAL_CLIENT_RESULT_FILE = process.env.CODEX_CAPTURE_EXTERNAL_CLIENT_RESULT_FILE || null;
const PHASE_COUNTS = (process.env.CODEX_CAPTURE_PHASES || "1,30,70,100")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const EXPECTED_SESSIONS = PHASE_COUNTS.reduce((sum, count) => sum + count, 0);
const EXPECTED_REQUESTS = EXPECTED_SESSIONS * 2;

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const settings = await import("../../src/lib/db/settings.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
const { CALL_LOGS_DIR, readCallArtifact } = await import("../../src/lib/usage/callLogArtifacts.ts");
const { projectDiagnosticOverflowReference } =
  await import("../../src/lib/usage/diagnosticOverflowTypes.ts");
const diagnosticOverflow = await import("../../src/lib/usage/diagnosticOverflow.ts");

type CodexParallelClientResult = {
  phases: Array<{
    conversations: number;
    completed: number;
    chatRequests: number;
    wallMs: number;
    conversationsPerSecond: number;
    roundTripMsP50: number;
    roundTripMsP95: number;
    firstBodyByteMsP50: number;
    firstBodyByteMsP95: number;
  }>;
  aggregate: { conversations: number; chatRequests: number };
};

function sseEvent(type: string, payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function responseSse(requestBody: Record<string, unknown>, ordinal: number): string {
  const input = Array.isArray(requestBody.input) ? requestBody.input : [];
  const isToolResult = input.some(
    (item) =>
      item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "function_call_output"
  );
  const responseId = `resp_codex_parallel_${ordinal}`;
  const model = typeof requestBody.model === "string" ? requestBody.model : "gpt-6.1-sol-medium";
  const base = {
    id: responseId,
    object: "response",
    status: "in_progress",
    model,
    output: [],
  };
  const events = [sseEvent("response.created", { response: base })];

  if (!isToolResult) {
    const itemId = `fc_codex_parallel_${ordinal}`;
    const callId = `call_codex_parallel_${ordinal}`;
    const args = JSON.stringify({ query: "synthetic lookup" });
    events.push(
      sseEvent("response.output_item.added", {
        output_index: 0,
        item: {
          id: itemId,
          type: "function_call",
          call_id: callId,
          name: "lookup",
          arguments: "",
          status: "in_progress",
        },
      }),
      sseEvent("response.function_call_arguments.delta", {
        item_id: itemId,
        output_index: 0,
        delta: args,
      }),
      sseEvent("response.function_call_arguments.done", {
        item_id: itemId,
        output_index: 0,
        arguments: args,
      })
    );
    const item = {
      id: itemId,
      type: "function_call",
      call_id: callId,
      name: "lookup",
      arguments: args,
      status: "completed",
    };
    events.push(
      sseEvent("response.output_item.done", { output_index: 0, item }),
      sseEvent("response.completed", {
        response: {
          ...base,
          status: "completed",
          output: [item],
          usage: {
            input_tokens: MOCK_INPUT_TOKENS,
            output_tokens: 16,
            total_tokens: MOCK_INPUT_TOKENS + 16,
          },
        },
      })
    );
    return events.join("");
  }

  const itemId = `msg_codex_parallel_${ordinal}`;
  const text = "mocked Codex tool round-trip complete";
  events.push(
    sseEvent("response.output_item.added", {
      output_index: 0,
      item: { id: itemId, type: "message", role: "assistant", content: [] },
    }),
    sseEvent("response.content_part.added", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
    sseEvent("response.output_text.delta", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: text,
    }),
    sseEvent("response.output_text.done", {
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      text,
    })
  );
  const item = {
    id: itemId,
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  events.push(
    sseEvent("response.output_item.done", { output_index: 0, item }),
    sseEvent("response.completed", {
      response: {
        ...base,
        status: "completed",
        output: [item],
        usage: {
          input_tokens: MOCK_INPUT_TOKENS,
          output_tokens: 8,
          total_tokens: MOCK_INPUT_TOKENS + 8,
        },
      },
    })
  );
  return events.join("");
}

async function readIncomingBody(request: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function bridgeResponse(response: Response, outgoing: http.ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!outgoing.write(next.value)) await once(outgoing, "drain");
    }
    outgoing.end();
  } finally {
    reader.releaseLock();
  }
}

async function startGateway() {
  const gateway = http.createServer(async (incoming, outgoing) => {
    try {
      const body = await readIncomingBody(incoming);
      const address = gateway.address();
      assert(address && typeof address !== "string");
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const request = new Request(`http://127.0.0.1:${address.port}${incoming.url}`, {
        method: incoming.method,
        headers,
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      await bridgeResponse(await chatRoute.POST(request), outgoing);
    } catch {
      outgoing.writeHead(500, { "content-type": "text/plain" });
      outgoing.end("isolated Codex test gateway error");
    }
  });
  await new Promise<void>((resolve, reject) => {
    gateway.once("error", reject);
    gateway.listen(0, "127.0.0.1", resolve);
  });
  const address = gateway.address();
  assert(address && typeof address !== "string");
  return { gateway, url: `http://127.0.0.1:${address.port}/v1/chat/completions` };
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function runCodexClient(url: string, key: string): Promise<CodexParallelClientResult> {
  const client = spawn(
    process.execPath,
    [path.resolve("tests/fixtures/codex-parallel-tool-client.mjs")],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_GATEWAY_URL: url,
        CODEX_TEST_API_KEY: key,
        CODEX_TEST_MODEL: "codex/gpt-6.1-sol-medium",
        CODEX_CAPTURE_CONTEXT_BYTES: String(CONTEXT_BYTES),
        CODEX_CAPTURE_CONTEXT_ENTROPY: CONTEXT_ENTROPY,
        CODEX_CAPTURE_MOCK_INPUT_TOKENS: String(MOCK_INPUT_TOKENS),
        CODEX_CAPTURE_REQUEST_TIMEOUT_MS: "120000",
        CODEX_CAPTURE_PHASES: PHASE_COUNTS.join(","),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stdout = "";
  let stderr = "";
  client.stdout?.setEncoding("utf8");
  client.stderr?.setEncoding("utf8");
  client.stdout?.on("data", (chunk: string) => (stdout += chunk));
  client.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const [code, signal] = (await once(client, "close")) as [number | null, NodeJS.Signals | null];
  if (code !== 0)
    throw new Error(`Codex HTTP client exited (${code ?? signal}): ${stderr.slice(-4000)}`);
  return JSON.parse(stdout);
}

async function waitForExternalCodexClient(
  url: string,
  key: string
): Promise<CodexParallelClientResult> {
  if (!EXTERNAL_CLIENT_READY_FILE || !EXTERNAL_CLIENT_RESULT_FILE) {
    throw new Error("Both external Codex client ready/result files are required");
  }
  fs.mkdirSync(path.dirname(EXTERNAL_CLIENT_READY_FILE), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(EXTERNAL_CLIENT_RESULT_FILE), { recursive: true, mode: 0o700 });
  const readyPath = `${EXTERNAL_CLIENT_READY_FILE}.tmp`;
  fs.writeFileSync(
    readyPath,
    JSON.stringify({
      gatewayUrl: url,
      apiKey: key,
      contextBytes: CONTEXT_BYTES,
      contextEntropy: CONTEXT_ENTROPY,
      mockInputTokens: MOCK_INPUT_TOKENS,
      phases: PHASE_COUNTS,
    }),
    { mode: 0o600 }
  );
  fs.renameSync(readyPath, EXTERNAL_CLIENT_READY_FILE);

  const deadline = Date.now() + 210_000;
  while (!fs.existsSync(EXTERNAL_CLIENT_RESULT_FILE) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!fs.existsSync(EXTERNAL_CLIENT_RESULT_FILE)) {
    throw new Error("Timed out waiting for the external Codex load client");
  }
  const result = JSON.parse(fs.readFileSync(EXTERNAL_CLIENT_RESULT_FILE, "utf8")) as {
    clientResult?: CodexParallelClientResult;
    error?: string;
    exitCode?: number | null;
  };
  fs.rmSync(EXTERNAL_CLIENT_READY_FILE, { force: true });
  fs.rmSync(EXTERNAL_CLIENT_RESULT_FILE, { force: true });
  if (!result.clientResult) {
    throw new Error(
      `External Codex load client failed (${result.exitCode ?? "unknown"}): ${result.error ?? "no result"}`
    );
  }
  return result.clientResult;
}

async function readPrivateFile(
  traceId: string,
  attemptId: string,
  kind: "client-request" | "request" | "response"
): Promise<Buffer> {
  const opened = await diagnosticOverflow.openDiagnosticOverflowFile(traceId, attemptId, kind);
  assert.equal(opened.state, "ready", `expected ready ${kind} data for ${traceId}`);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  return gunzipSync(Buffer.concat(chunks));
}

function percentile(values: number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.ceil(quantile * sorted.length) - 1].toFixed(2));
}

let gateway: http.Server | null = null;
let upstream: http.Server | null = null;
let restoreBuildUrl: (() => void) | null = null;
let memorySampler: ReturnType<typeof createProcessMemorySampler> | null = null;
let clientResult: Record<string, unknown> | null = null;
let upstreamRequests = 0;
let upstreamToolFollowups = 0;

test(
  "Codex OAuth runs 1/30/70/100 isolated tool conversations with complete private capture",
  {
    timeout: 240_000,
  },
  async () => {
    try {
      await settings.updateSettings({
        requireLogin: false,
        call_log_pipeline_enabled: true,
        sessionAffinityTtlMs: 60_000,
        compression: { enabled: false },
        resilienceSettings: {
          quotaPreflight: { enabled: false },
          requestQueue: {
            autoEnableApiKeyProviders: false,
            globalConcurrentRequests: 0,
            maxWaitMs: 120_000,
            maxQueueDepth: 256,
          },
        },
      });
      await providers.createProviderConnection({
        provider: "codex",
        authType: "oauth",
        name: "isolated-parallel-codex",
        email: "parallel-codex@example.test",
        accessToken: "synthetic-codex-oauth-access-token",
        refreshToken: "synthetic-codex-oauth-refresh-token",
        tokenType: "Bearer",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: {
          workspaceId: "synthetic-parallel-workspace",
          chatgptUserId: "synthetic-parallel-user",
        },
      });
      const apiKey = await apiKeys.createApiKey("isolated Codex parallel", "synthetic-codex-agent");
      await apiKeys.updateApiKeyPermissions(apiKey.id, {
        noLog: false,
        compressionEnabled: false,
      });

      upstream = http.createServer(async (incoming, outgoing) => {
        try {
          const bodyBytes = await readIncomingBody(incoming);
          const body = JSON.parse(bodyBytes.toString("utf8")) as Record<string, unknown>;
          upstreamRequests++;
          const input = Array.isArray(body.input) ? body.input : [];
          const isToolResult = input.some(
            (item) =>
              item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).type === "function_call_output"
          );
          if (isToolResult) upstreamToolFollowups++;
          outgoing.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          outgoing.end(responseSse(body, upstreamRequests));
        } catch {
          outgoing.writeHead(400, { "content-type": "application/json" });
          outgoing.end('{"error":{"message":"synthetic upstream fixture error"}}');
        }
      });
      await new Promise<void>((resolve, reject) => {
        upstream!.once("error", reject);
        upstream!.listen(0, "127.0.0.1", resolve);
      });
      const upstreamAddress = upstream.address();
      assert(upstreamAddress && typeof upstreamAddress !== "string");
      const executor = (await getExecutor("codex")) as { buildUrl: (...args: unknown[]) => string };
      const priorBuildUrl = executor.buildUrl;
      executor.buildUrl = () => `http://127.0.0.1:${upstreamAddress.port}${CODEX_RESPONSES_PATH}`;
      restoreBuildUrl = () => {
        executor.buildUrl = priorBuildUrl;
      };

      const gatewayInfo = await startGateway();
      gateway = gatewayInfo.gateway;
      memorySampler = createProcessMemorySampler(1000);
      const startedAt = performance.now();
      if (EXTERNAL_CLIENT_READY_FILE || EXTERNAL_CLIENT_RESULT_FILE) {
        clientResult = await waitForExternalCodexClient(gatewayInfo.url, apiKey.key);
      } else {
        clientResult = await runCodexClient(gatewayInfo.url, apiKey.key);
      }
      const wallMs = performance.now() - startedAt;
      assert.equal(clientResult.aggregate?.conversations, EXPECTED_SESSIONS);
      assert.equal(clientResult.aggregate?.chatRequests, EXPECTED_REQUESTS);
      assert.equal(upstreamRequests, EXPECTED_REQUESTS);
      assert.equal(upstreamToolFollowups, EXPECTED_SESSIONS);

      await closeCallLogSaves(60_000);
      const rows = core
        .getDbInstance()
        .prepare(
          "SELECT id, artifact_relpath, detail_state, error_summary, artifact_size_bytes FROM call_logs ORDER BY timestamp ASC"
        )
        .all() as Array<{
        id: string;
        artifact_relpath: string | null;
        detail_state: string;
        error_summary: string | null;
        artifact_size_bytes: number | null;
      }>;
      assert.equal(rows.length, EXPECTED_REQUESTS);
      const artifactRows = rows.filter((row) => row.artifact_relpath);
      assert.equal(artifactRows.length, EXPECTED_REQUESTS);
      assert.ok(CALL_LOGS_DIR);
      const fullArtifactRows = artifactRows.filter(
        (row) =>
          CALL_LOGS_DIR &&
          fs.statSync(path.join(CALL_LOGS_DIR, row.artifact_relpath!)).size >= 64 * 1024
      );
      const artifactBytes = artifactRows.reduce(
        (sum, row) => sum + (row.artifact_size_bytes ?? 0),
        0
      );
      const largestArtifactBytes = artifactRows.reduce(
        (largest, row) => Math.max(largest, row.artifact_size_bytes ?? 0),
        0
      );

      let active = diagnosticOverflow.getActiveDiagnosticOverflowCount();
      const drainDeadline = Date.now() + 20_000;
      while (active > 0 && Date.now() < drainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        active = diagnosticOverflow.getActiveDiagnosticOverflowCount();
      }
      assert.equal(
        active,
        0,
        "Codex private trace writers should drain after all response bodies close"
      );

      const traceIds = new Set<string>();
      for (const row of artifactRows) {
        assert.equal(
          row.detail_state,
          "ready",
          `call-log detail missing for ${row.id}: ${row.error_summary}`
        );
        const stored = readCallArtifact(row.artifact_relpath);
        assert.equal(stored.state, "ready");
        const reference = projectDiagnosticOverflowReference(
          stored.artifact?.pipeline?.diagnosticOverflow
        );
        assert.ok(reference, `Codex artifact ${row.id} should reference its private trace`);
        traceIds.add(reference!.traceId);
      }
      assert.equal(traceIds.size, EXPECTED_REQUESTS);

      const manifests = await Promise.all(
        [...traceIds].map((traceId) => diagnosticOverflow.readDiagnosticOverflowManifest(traceId))
      );
      assert.ok(manifests.every((manifest) => manifest?.state === "complete"));
      assert.ok(
        manifests.every(
          (manifest) =>
            manifest?.clientRequest?.complete === true &&
            manifest.attempts.length === 1 &&
            manifest.attempts[0].request.complete === true &&
            manifest.attempts[0].response.complete === true
        )
      );

      const rawBytes = manifests.reduce((sum, manifest) => {
        if (!manifest) return sum;
        const files = [
          manifest.clientRequest,
          ...manifest.attempts.flatMap((attempt) => [attempt.request, attempt.response]),
        ].filter(Boolean);
        return sum + files.reduce((total, file) => total + file!.rawBytes, 0);
      }, 0);
      const compressedBytes = manifests.reduce((sum, manifest) => {
        if (!manifest) return sum;
        const files = [
          manifest.clientRequest,
          ...manifest.attempts.flatMap((attempt) => [attempt.request, attempt.response]),
        ].filter(Boolean);
        return sum + files.reduce((total, file) => total + file!.compressedBytes, 0);
      }, 0);
      const sample = manifests[0];
      assert.ok(sample);
      const clientRequest = await readPrivateFile(
        sample!.traceId,
        sample!.traceId,
        "client-request"
      );
      const providerRequest = await readPrivateFile(
        sample!.traceId,
        sample!.attempts[0].attemptId,
        "request"
      );
      const providerResponse = await readPrivateFile(
        sample!.traceId,
        sample!.attempts[0].attemptId,
        "response"
      );
      assert.ok(clientRequest.length >= CONTEXT_BYTES * 4);
      assert.match(providerRequest.toString("utf8"), /Historical request/);
      assert.match(providerResponse.toString("utf8"), /data:/);

      const cgroup = snapshotCgroupMemory();
      console.log(
        `CODEX_PARALLEL_CAPTURE sessions=${EXPECTED_SESSIONS} requests=${EXPECTED_REQUESTS} contextCharsPerHistoricalTurn=${CONTEXT_BYTES} contextEntropy=${CONTEXT_ENTROPY} mockReportedInputTokens=${MOCK_INPUT_TOKENS} details=${artifactRows.length} fullArtifacts=${fullArtifactRows.length} privatePointerArtifacts=${artifactRows.length - fullArtifactRows.length} artifactBytes=${artifactBytes} largestArtifactBytes=${largestArtifactBytes} traces=${traceIds.size} complete=${manifests.length} rawBytes=${rawBytes} compressedBytes=${compressedBytes} sampleClientBytes=${clientRequest.length} sampleProviderRequestBytes=${providerRequest.length} sampleProviderResponseBytes=${providerResponse.length} wallMs=${Math.round(wallMs)} gatewayRss=${process.resourceUsage().maxRSS * 1024} cgroupPeak=${cgroup.peakBytes} cgroupMax=${cgroup.maxBytes}`
      );
      console.log(`CODEX_PARALLEL_PHASES ${JSON.stringify(clientResult.phases)}`);
    } finally {
      restoreBuildUrl?.();
      if (memorySampler) {
        const series = memorySampler.finish();
        const cgroup = snapshotCgroupMemory();
        console.log(
          `CODEX_PARALLEL_MEMORY sampledRssPeak=${series.peaks.rssBytes} sampledHeapPeak=${series.peaks.heapUsedBytes} sampledExternalPeak=${series.peaks.externalBytes} processMaxRssBytes=${series.processMaxRssBytes} sampleCount=${series.samples.length} cgroupCurrent=${cgroup.currentBytes} cgroupPeak=${cgroup.peakBytes} cgroupMax=${cgroup.maxBytes} oom=${cgroup.events?.oom ?? 0}`
        );
      }
      if (gateway) await closeServer(gateway);
      if (upstream) await closeServer(upstream);
      if (EXTERNAL_CLIENT_READY_FILE) {
        fs.rmSync(EXTERNAL_CLIENT_READY_FILE, { force: true });
        fs.rmSync(`${EXTERNAL_CLIENT_READY_FILE}.tmp`, { force: true });
      }
      if (EXTERNAL_CLIENT_RESULT_FILE) fs.rmSync(EXTERNAL_CLIENT_RESULT_FILE, { force: true });
      await closeCallLogSaves(60_000).catch(() => {});
      core.closeDbInstance({ checkpointMode: null });
      fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
);

test.after(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});
