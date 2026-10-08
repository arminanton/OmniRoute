import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { gunzipSync } from "node:zlib";
import { createRequestLogger } from "../../open-sse/utils/requestLogger.ts";
import {
  createPreparedRequestLogger,
  runWithCapture,
} from "../../open-sse/utils/providerRequestLogging.ts";
import { runWithDiagnosticCaptureLifecycle } from "../../open-sse/utils/diagnosticCaptureContext.ts";
import {
  DiagnosticOverflowAttempt,
  getActiveDiagnosticOverflowCount,
  openDiagnosticOverflowFile,
  readDiagnosticOverflowManifest,
} from "../../src/lib/usage/diagnosticOverflow.ts";

process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "true";
process.env.OMNI_DIAGNOSTIC_OVERFLOW_MIN_CLIENT_BYTES = "0";

async function readCapturedFile(
  traceId: string,
  attemptId: string,
  kind: "client-request" | "request" | "response"
): Promise<string> {
  const result = await openDiagnosticOverflowFile(traceId, attemptId, kind);
  assert.equal(result.state, "ready");
  if (result.state !== "ready") throw new Error("Expected a complete diagnostic file");
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  return gunzipSync(Buffer.concat(chunks)).toString("utf8");
}

async function createCodexLogger() {
  const clientBody = JSON.stringify({
    model: "cx/gpt-6.1-sol",
    input: [{ role: "user", content: "large synthetic prompt" }],
  });
  const log = await createRequestLogger(undefined, undefined, undefined, {
    enabled: true,
    provider: "codex",
    diagnosticOverflowEligible: true,
    diagnosticClientJson: () => clientBody,
  });
  const trace = log.getDiagnosticOverflowTrace();
  assert.ok(trace, "large Codex requests should get an opt-in overflow trace");
  return { clientBody, log, trace };
}

test("diagnostic capture finalization does not hold the client response open on disk fsync", async () => {
  const originalFsync = fs.fsync;
  let releaseFsync: (() => void) | undefined;
  let enteredFsync: (() => void) | undefined;
  const fsyncEntered = new Promise<void>((resolve) => {
    enteredFsync = resolve;
  });
  try {
    fs.fsync = ((fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      let isClientCapture = false;
      try {
        isClientCapture = fs.readlinkSync(`/proc/self/fd/${fd}`).includes(".client_request.gz");
      } catch {}
      if (!isClientCapture || releaseFsync) {
        originalFsync(fd, callback);
        return;
      }
      enteredFsync?.();
      releaseFsync = () => originalFsync(fd, callback);
    }) as typeof fs.fsync;

    const response = await runWithDiagnosticCaptureLifecycle(async () => {
      const log = await createRequestLogger(undefined, undefined, undefined, {
        enabled: true,
        provider: "codex",
        diagnosticOverflowEligible: true,
        diagnosticClientJson: () => JSON.stringify({ model: "gpt-6.1-sol", input: "fsync" }),
      });
      assert.ok(log.getDiagnosticOverflowTrace());
      return new Response("client response is available before capture fsync");
    });
    await fsyncEntered;

    const responseBodyPromise = response.text();
    const result = await Promise.race([
      responseBodyPromise.then((body) => ({ kind: "body" as const, body })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 100)
      ),
    ]);
    releaseFsync?.();
    assert.equal(result.kind, "body", "trace flushing must not gate response EOF");
    assert.equal(
      result.kind === "body" ? result.body : "",
      "client response is available before capture fsync"
    );
    await responseBodyPromise;

    const deadline = Date.now() + 2000;
    while (getActiveDiagnosticOverflowCount() > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      getActiveDiagnosticOverflowCount(),
      0,
      "background finalization must eventually drain"
    );
  } finally {
    releaseFsync?.();
    fs.fsync = originalFsync;
  }
});

test("Codex overflow capture retains exact provider request and 429 response bytes", async () => {
  const originalFetch = globalThis.fetch;
  const requestBody = JSON.stringify({
    model: "gpt-6.1-sol",
    input: [{ role: "user", content: "serialized Codex request sentinel" }],
  });
  const responseBody = JSON.stringify({
    error: { type: "rate_limit_error", message: "synthetic quota response sentinel" },
  });
  const bearerSecret = "Bearer SECRET_CODEX_TOKEN";
  const querySecret = "query-secret-do-not-persist";
  try {
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.body, requestBody);
      return new Response(responseBody, {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "17",
          "x-request-id": "provider-request-123",
        },
      });
    };

    const { clientBody, log, trace } = await createCodexLogger();
    const capture = createPreparedRequestLogger(
      log,
      { id: "codex-attempt", model: "gpt-6.1-sol", provider: "codex", connectionId: "conn" },
      { provider: "codex" }
    );
    const response = await runWithCapture(capture, () =>
      fetch(`https://chatgpt.com/backend-api/codex/responses?key=${querySecret}`, {
        method: "POST",
        headers: { authorization: bearerSecret, "content-type": "application/json" },
        body: requestBody,
      })
    );

    assert.equal(await response.text(), responseBody);
    await trace.finish();

    const manifest = await readDiagnosticOverflowManifest(trace.traceId);
    assert.ok(manifest);
    assert.equal(manifest.provider, "codex");
    assert.equal(manifest.state, "complete");
    assert.equal(manifest.attempts.length, 1);
    assert.equal(manifest.attempts[0].status, 429);
    assert.equal(manifest.attempts[0].headers["retry-after"], "17");
    assert.equal(manifest.attempts[0].url, "https://chatgpt.com/backend-api/codex/responses");
    assert.ok(!JSON.stringify(manifest).includes("SECRET_CODEX_TOKEN"));
    assert.ok(!JSON.stringify(manifest).includes(querySecret));
    assert.equal(
      await readCapturedFile(trace.traceId, trace.traceId, "client-request"),
      clientBody
    );
    assert.equal(
      await readCapturedFile(trace.traceId, manifest.attempts[0].attemptId, "request"),
      requestBody
    );
    assert.equal(
      await readCapturedFile(trace.traceId, manifest.attempts[0].attemptId, "response"),
      responseBody
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex overflow capture records response-start timeouts as incomplete attempts", async () => {
  const originalFetch = globalThis.fetch;
  const timeout = new Error("synthetic upstream response-start timeout");
  timeout.name = "TimeoutError";
  try {
    globalThis.fetch = async () => {
      throw timeout;
    };
    const { log, trace } = await createCodexLogger();
    const capture = createPreparedRequestLogger(
      log,
      { id: "codex-timeout", model: "gpt-6.1-sol", provider: "codex", connectionId: "conn" },
      { provider: "codex" }
    );

    await assert.rejects(
      runWithCapture(capture, () =>
        fetch("https://chatgpt.com/backend-api/codex/responses", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-6.1-sol", input: "timeout sentinel" }),
        })
      ),
      timeout
    );
    await trace.finish();

    const manifest = await readDiagnosticOverflowManifest(trace.traceId);
    assert.ok(manifest);
    assert.equal(manifest.state, "incomplete");
    assert.equal(manifest.attempts.length, 1);
    assert.equal(manifest.attempts[0].response.complete, false);
    assert.equal(manifest.attempts[0].response.reason, "timeout");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex overflow capture obeys detailed-log and no-payload eligibility gates", async () => {
  let serialized = 0;
  const log = await createRequestLogger(undefined, undefined, undefined, {
    enabled: false,
    provider: "codex",
    diagnosticOverflowEligible: true,
    diagnosticClientJson: () => {
      serialized++;
      return "must-not-be-read";
    },
  });
  assert.equal(log.getDiagnosticOverflowTrace(), null);
  assert.equal(serialized, 0);

  const noLog = await createRequestLogger(undefined, undefined, undefined, {
    enabled: true,
    provider: "codex",
    diagnosticOverflowEligible: false,
    diagnosticClientJson: () => {
      serialized++;
      return "no-log-payload";
    },
  });
  assert.equal(noLog.getDiagnosticOverflowTrace(), null);
  assert.equal(serialized, 0);
});

test("Codex stream delivery does not wait for a slow diagnostic file write", async () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = DiagnosticOverflowAttempt.prototype.writeResponse;
  let releaseWrite: (() => void) | undefined;
  let writeStarted: (() => void) | undefined;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const writeStartedPromise = new Promise<void>((resolve) => {
    writeStarted = resolve;
  });
  try {
    DiagnosticOverflowAttempt.prototype.writeResponse = async function (chunk) {
      const queued = originalWrite.call(this, chunk);
      writeStarted?.();
      await writeGate;
      await queued;
    };
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("stream-chunk-sentinel"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      );

    const { log, trace } = await createCodexLogger();
    const capture = createPreparedRequestLogger(
      log,
      { id: "codex-slow-disk", model: "gpt-6.1-sol", provider: "codex", connectionId: "conn" },
      { provider: "codex" }
    );
    const response = await runWithCapture(capture, () =>
      fetch("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6.1-sol", input: "streaming sentinel" }),
      })
    );
    const reader = response.body!.getReader();
    const pendingRead = reader.read();
    const firstRead = await Promise.race([
      pendingRead.then((value) => ({ kind: "read" as const, value })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), 100)
      ),
    ]);
    assert.equal(firstRead.kind, "read", "a delayed file write must not stall the live stream");
    if (firstRead.kind !== "read") throw new Error("provider stream was blocked by diagnostic I/O");
    assert.equal(new TextDecoder().decode(firstRead.value.value), "stream-chunk-sentinel");
    await writeStartedPromise;
    releaseWrite?.();
    assert.equal((await reader.read()).done, true);
    await trace.finish();
    const manifest = await readDiagnosticOverflowManifest(trace.traceId);
    assert.ok(manifest);
    assert.equal(manifest.state, "complete");
    assert.equal(manifest.attempts[0].response.complete, true);
  } finally {
    releaseWrite?.();
    DiagnosticOverflowAttempt.prototype.writeResponse = originalWrite;
    globalThis.fetch = originalFetch;
  }
});
