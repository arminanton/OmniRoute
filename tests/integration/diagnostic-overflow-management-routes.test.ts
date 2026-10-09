import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { gunzipSync } from "node:zlib";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-diagnostic-overflow-http-"));
const previousDataDir = process.env.DATA_DIR;
const previousJwtSecret = process.env.JWT_SECRET;
const previousOverflowEnabled = process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
const previousAppLogToFile = process.env.APP_LOG_TO_FILE;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "synthetic-diagnostic-overflow-route-session-secret";
process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "true";
process.env.APP_LOG_TO_FILE = "false";

const overflow = await import("../../src/lib/usage/diagnosticOverflow.ts");
const listRoute = await import("../../src/app/api/usage/diagnostic-overflow/route.ts");
const traceRoute = await import("../../src/app/api/usage/diagnostic-overflow/[traceId]/route.ts");
const clientRequestRoute =
  await import("../../src/app/api/usage/diagnostic-overflow/[traceId]/client-request/route.ts");
const attemptFileRoute =
  await import("../../src/app/api/usage/diagnostic-overflow/[traceId]/[attemptId]/[kind]/route.ts");

after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousJwtSecret;
  if (previousOverflowEnabled === undefined) delete process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
  else process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = previousOverflowEnabled;
  if (previousAppLogToFile === undefined) delete process.env.APP_LOG_TO_FILE;
  else process.env.APP_LOG_TO_FILE = previousAppLogToFile;
});

function routeRequest(pathname: string): Request {
  return new Request(`http://localhost${pathname}`);
}

async function managementRequest(pathname: string): Promise<Request> {
  return makeManagementSessionRequest(`http://localhost${pathname}`);
}

async function assertGzipDownload(
  response: Response,
  expected: Buffer,
  storedPath: string,
  filename: string
): Promise<void> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/gzip");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-diagnostic-capture-state"), "complete");
  assert.equal(response.headers.get("x-diagnostic-capture-complete"), "true");
  assert.equal(response.headers.get("content-disposition"), `attachment; filename="${filename}"`);

  const compressed = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(
    compressed,
    fs.readFileSync(storedPath),
    "HTTP body must equal stored gzip bytes"
  );
  assert.deepEqual(gunzipSync(compressed), expected, "gzip body must decode to the captured bytes");
}

test("private overflow management routes list, inspect, and download complete captures", async () => {
  const clientPayload = Buffer.from(
    JSON.stringify({ source: "synthetic-client", text: "café 雪 🛰".repeat(800) }),
    "utf8"
  );
  const providerRequest = Buffer.from(
    JSON.stringify({ model: "gemini-test", input: "synthetic-provider-request".repeat(800) }),
    "utf8"
  );
  const providerResponse = Buffer.from(
    `data: ${JSON.stringify({ text: "synthetic-provider-response".repeat(800) })}\n\ndata: [DONE]\n\n`,
    "utf8"
  );

  const trace = await overflow.createDiagnosticOverflowTrace({
    eligible: true,
    provider: "antigravity",
    requestId: "synthetic-management-route-test",
  });
  assert.ok(trace, "synthetic private trace should be created");
  await trace.writeClientRequest(clientPayload);
  const attempt = await trace.beginAttempt({
    requestBody: providerRequest,
    method: "POST",
    url: "http://127.0.0.1/synthetic-provider",
    headers: { "content-type": "application/json" },
    transport: "http",
  });
  await attempt.writeResponse(providerResponse);
  await attempt.finish({ status: 200 });
  await trace.finish();

  const anonymous = await listRoute.GET(routeRequest("/api/usage/diagnostic-overflow"));
  assert.equal(anonymous.status, 401, "private trace list must deny unauthenticated access");
  const anonymousDownload = await clientRequestRoute.GET(
    routeRequest(`/api/usage/diagnostic-overflow/${trace.traceId}/client-request`),
    { params: Promise.resolve({ traceId: trace.traceId }) }
  );
  assert.equal(anonymousDownload.status, 401, "private payload must deny unauthenticated reads");

  const listed = await listRoute.GET(await managementRequest("/api/usage/diagnostic-overflow"));
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get("cache-control"), "private, no-store");
  const listPayload = (await listed.json()) as { traces: Array<{ traceId: string }> };
  assert.ok(listPayload.traces.some((item) => item.traceId === trace.traceId));

  const inspected = await traceRoute.GET(
    await managementRequest(`/api/usage/diagnostic-overflow/${trace.traceId}`),
    { params: Promise.resolve({ traceId: trace.traceId }) }
  );
  assert.equal(inspected.status, 200);
  assert.equal(inspected.headers.get("cache-control"), "private, no-store");
  const manifest = (await inspected.json()) as {
    state: string;
    traceId: string;
    clientRequest: { complete: boolean };
    attempts: Array<{
      attemptId: string;
      request: { complete: boolean };
      response: { complete: boolean };
    }>;
  };
  assert.equal(manifest.traceId, trace.traceId);
  assert.equal(manifest.state, "complete");
  assert.equal(manifest.clientRequest.complete, true);
  assert.equal(manifest.attempts.length, 1);
  assert.equal(manifest.attempts[0]?.attemptId, attempt.id);
  assert.equal(manifest.attempts[0]?.request.complete, true);
  assert.equal(manifest.attempts[0]?.response.complete, true);

  const clientDownload = await clientRequestRoute.GET(
    await managementRequest(`/api/usage/diagnostic-overflow/${trace.traceId}/client-request`),
    { params: Promise.resolve({ traceId: trace.traceId }) }
  );
  await assertGzipDownload(
    clientDownload,
    clientPayload,
    path.join(
      TEST_DATA_DIR,
      "diagnostic_overflow",
      trace.traceId,
      `${trace.traceId}.client_request.gz`
    ),
    `${trace.traceId}-${trace.traceId}-client-request.gz`
  );

  for (const [kind, expected, fileSuffix] of [
    ["request", providerRequest, "provider_request"],
    ["response", providerResponse, "provider_response"],
  ] as const) {
    const download = await attemptFileRoute.GET(
      await managementRequest(
        `/api/usage/diagnostic-overflow/${trace.traceId}/${attempt.id}/${kind}`
      ),
      { params: Promise.resolve({ traceId: trace.traceId, attemptId: attempt.id, kind }) }
    );
    await assertGzipDownload(
      download,
      expected,
      path.join(
        TEST_DATA_DIR,
        "diagnostic_overflow",
        trace.traceId,
        `${attempt.id}.${fileSuffix}.gz`
      ),
      `${trace.traceId}-${attempt.id}-${kind}.gz`
    );
  }
});
