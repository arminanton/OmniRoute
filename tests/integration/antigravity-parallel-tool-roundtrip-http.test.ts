import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Readable } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { gunzipSync } from "node:zlib";
import { fetch as clientFetch } from "undici";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-antigravity-parallel-e2e-"));
process.env.DATA_DIR = dataDir;
process.env.REQUIRE_API_KEY = "true";
process.env.API_KEY_SECRET = "synthetic-antigravity-e2e-signing-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.APP_LOG_LEVEL = "error";
process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS = "8";
process.env.ANTIGRAVITY_CREDITS = "never";
const captureCallLogs = process.env.RUN_ANTIGRAVITY_CAPTURE_BENCH === "1";
const capturePrivateOverflow =
  captureCallLogs && process.env.ANTIGRAVITY_CAPTURE_OVERFLOW_BENCH === "1";
const captureContextBytes = Math.max(0, Number(process.env.ANTIGRAVITY_CAPTURE_CONTEXT_BYTES || 0));
const sessionCounts =
  captureCallLogs && process.env.ANTIGRAVITY_CAPTURE_SINGLE_SESSION === "1"
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
    captureContextBytes > 0 ? captureContextBytes * 4 : 0
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

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function spawnFixture(scriptName: string, extraEnv: Record<string, string> = {}) {
  const fixturePath = path.resolve("tests/fixtures", scriptName);
  const child = spawn(process.execPath, [fixturePath], {
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
    let upstreamFixture: Awaited<ReturnType<typeof startMockUpstream>> | null = null;
    let clientFixture: ReturnType<typeof spawnFixture> | null = null;
    const gateway = http.createServer(async (incoming, outgoing) => {
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
            },
          })
        );
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (typeof value === "string") headers.set(name, value);
        const response = await route.POST(
          new Request(
            `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/chat/completions`,
            {
              method: incoming.method,
              headers,
              body: countedBody,
              duplex: "half",
            } as RequestInit & {
              duplex: "half";
            }
          )
        );
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              if (!outgoing.write(next.value)) await once(outgoing, "drain");
            }
          } finally {
            reader.releaseLock();
          }
        }
        outgoing.end();
      } catch (error) {
        errors.push(String(error));
        outgoing.writeHead(500);
        outgoing.end('{"error":{"message":"isolated gateway test failed"}}');
      }
    });
    let restoreUrl = () => {};
    try {
      versions.seedAntigravityIdeVersionCache("2.5.5-test");
      versions.seedAntigravityCliVersionCache("1.2.16-test");
      await settings.updateSettings({
        requireLogin: false,
        call_log_pipeline_enabled: captureCallLogs,
        sessionAffinityTtlMs: 60000,
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
      clientFixture = spawnFixture("antigravity-parallel-client.mjs", {
        ANTIGRAVITY_GATEWAY_URL: gatewayUrl,
        ANTIGRAVITY_TEST_API_KEY: key.key,
        ANTIGRAVITY_CAPTURE_CONTEXT_BYTES: String(captureContextBytes),
        ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS:
          process.env.ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS || "30000",
        ANTIGRAVITY_CAPTURE_SINGLE_SESSION: process.env.ANTIGRAVITY_CAPTURE_SINGLE_SESSION || "0",
      });
      const clientOutput = await runFixture(clientFixture);
      const clientResult = JSON.parse(clientOutput.trim().split("\n").at(-1) ?? "{}");
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
      };
      assert.equal(upstreamStats.received, expectedRequests);
      assert.deepEqual(upstreamStats.errors, []);
      assert.deepEqual(upstreamStats.profiles, ["cli", "ide"]);
      for (const value of Object.values(upstreamStats.phases)) {
        assert.deepEqual(value, ["tool", "answer"]);
      }
      assert.equal(Object.keys(upstreamStats.identities).length, expectedRequests / 2);
      assert.deepEqual(errors, []);

      if (captureCallLogs) {
        const { closeCallLogArtifactWriter } =
          await import("../../src/lib/usage/callLogArtifactWriter.ts");
        await closeCallLogArtifactWriter();
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
        console.log(
          `ANTIGRAVITY_ARTIFACTS rows=${rows.length} stored=${artifactRows.length} full=${fullArtifacts.length} privateOnly=${capturePrivateOverflow ? artifactRows.length : 0} pointer=${pointerArtifacts} missing=${rows.length - artifactRows.length} stateCounts=${JSON.stringify(rows.reduce<Record<string, number>>((counts, row) => ((counts[row.detail_state] = (counts[row.detail_state] ?? 0) + 1), counts), {}))}`
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
          `ANTIGRAVITY_CAPTURE records=${rows.length} artifacts=${artifactRows.length} maxRequestBytes=${maxClientRequestBytes} capturedUserBytes=${capturedUserBytes} streamChannels=${Object.keys(streamChunks).join(",")}`
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
          assert.ok(manifests.every((manifest) => manifest?.state === "complete"));
          assert.ok(
            manifests.every(
              (manifest) =>
                manifest?.clientRequest?.complete === true &&
                manifest.attempts.length === 1 &&
                manifest.attempts[0].request.complete === true &&
                manifest.attempts[0].response.complete === true
            ),
            "every private overflow trace should contain a complete client/provider request and response"
          );
          const sample = manifests[0];
          assert.ok(sample);
          const clientBody = await readPrivateCapture(
            sample!.traceId,
            sample!.traceId,
            "client-request"
          );
          const providerBody = await readPrivateCapture(
            sample!.traceId,
            sample!.attempts[0].attemptId,
            "response"
          );
          assert.ok(clientBody.byteLength >= captureContextBytes * 5);
          assert.match(providerBody.toString("utf8"), /data: /);
          console.log(
            `ANTIGRAVITY_PRIVATE_OVERFLOW traces=${traceIds.size} complete=${manifests.length} sampleClientBytes=${clientBody.byteLength} sampleProviderBytes=${providerBody.byteLength}`
          );
        }
      }
    } finally {
      restoreUrl();
      await stopFixture(clientFixture?.child ?? null);
      gateway.closeAllConnections();
      if (gateway.listening) await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await stopFixture(upstreamFixture?.child ?? null);
      await new Promise((resolve) => setImmediate(resolve));
      flushProxyLogsSync();
      if (captureCallLogs) {
        const { closeCallLogArtifactWriter } =
          await import("../../src/lib/usage/callLogArtifactWriter.ts");
        await closeCallLogArtifactWriter();
      }
      core.closeDbInstance({ checkpointMode: null });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
);
