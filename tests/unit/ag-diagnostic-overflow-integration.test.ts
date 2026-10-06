import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { createRequestLogger } from "../../open-sse/utils/requestLogger.ts";
import {
  createPreparedRequestLogger,
  runWithCapture,
} from "../../open-sse/utils/providerRequestLogging.ts";
import {
  buildClientRawRequest,
  resolveDispatchClientRawRequest,
} from "../../src/sse/handlers/chat/clientRawRequest.ts";
import {
  getDiagnosticClientJson,
  runWithDiagnosticCaptureLifecycle,
} from "../../open-sse/utils/diagnosticCaptureContext.ts";
import {
  fetchAntigravityWithReadinessTimeout,
  sendAntigravityRequest,
  toSafeAntigravityLog,
  tryCreditsRetry,
} from "../../open-sse/executors/antigravity/executeAttempt.ts";
import {
  readAntigravityErrorBody,
  disposeAntigravityResponse,
} from "../../open-sse/executors/antigravity/lifecycle.ts";
import {
  createDiagnosticOverflowTrace,
  readDiagnosticOverflowManifest,
  openDiagnosticOverflowFile,
  listDiagnosticOverflowTraces,
  getActiveDiagnosticOverflowCount,
} from "../../src/lib/usage/diagnosticOverflow.ts";
import { writeCallArtifact, readCallArtifact } from "../../src/lib/usage/callLogArtifacts.ts";
const encoder = new TextEncoder();
process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "true";
process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "10240";
process.env.CHAT_LOG_TEXT_LIMIT = "262144";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
async function decoded(
  traceId: string,
  attemptId: string,
  kind: "client-request" | "request" | "response"
) {
  const result = await openDiagnosticOverflowFile(traceId, attemptId, kind);
  assert.equal(result.state, "ready");
  if (result.state !== "ready") throw new Error("capture missing");
  const chunks: Buffer[] = [];
  for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
  const value = gunzipSync(Buffer.concat(chunks));
  assert.equal(hash(value), result.metadata.sha256);
  return value;
}
async function logger(body: unknown, eligible = true) {
  const raw = buildClientRawRequest(
    new Request("http://synthetic.invalid/v1/chat/completions"),
    body,
    eligible
  );
  return {
    raw,
    log: await createRequestLogger(undefined, undefined, undefined, {
      enabled: true,
      provider: "antigravity",
      diagnosticOverflowEligible: eligible,
      diagnosticClientJson: () => getDiagnosticClientJson(raw),
    }),
  };
}
const source = (value: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });

test("originalparsedJSON outgoingserializer and >11MiB decodederror remain exact beyond preview bounds", async () => {
  const originalFetch = globalThis.fetch;
  const text =
    "BEGIN_ORIGINAL_" +
    "x".repeat(6 * 1024 * 1024) +
    "MIDDLE_ORIGINAL_" +
    "y".repeat(5 * 1024 * 1024) +
    "END_ORIGINAL";
  const body = {
    model: "agy/gemini-3.8-flash",
    messages: [
      { role: "user", content: text },
      ...Array.from({ length: 300 }, (_, i) => ({
        role: "user",
        content: `TAIL_HISTORY_${i}:` + "z".repeat(40000),
      })),
    ],
  };
  const originalJSON = JSON.stringify(body);
  let traceId = "",
    wireJSON = "";
  let capturedPipeline:
    import("../../open-sse/utils/requestLogger.ts").RequestPipelinePayloads | null = null;
  const responseJSON = JSON.stringify({
    error: {
      code: 400,
      message: text,
      details: [{ reason: "SYNTHETIC_FAILURE", sentinel: "LAST_ERROR_DETAIL" }],
    },
  });
  try {
    globalThis.fetch = async (_url, init) => {
      wireJSON = String(init?.body);
      return new Response(source(encoder.encode(responseJSON)), {
        status: 400,
        headers: { "content-type": "application/json", "x-request-id": "synthetic-native-id" },
      });
    };
    const result = await runWithDiagnosticCaptureLifecycle(async () => {
      const { raw, log } = await logger(body);
      body.messages[0].content = "mutated after original snapshot";
      const copied = resolveDispatchClientRawRequest(raw, new AbortController().signal);
      assert.equal(hash(getDiagnosticClientJson(copied)!), hash(originalJSON));
      log.logClientRawRequest("/v1/chat/completions", raw.body);
      assert.ok(
        !JSON.stringify(log.getPipelinePayloads()?.clientRawRequest).includes("MIDDLE_ORIGINAL")
      );
      traceId = log.getDiagnosticOverflowTrace()!.traceId;
      const prepared = JSON.stringify({
        project: "synthetic-project",
        request: { contents: [{ role: "user", parts: [{ text }] }] },
      });
      const response = await runWithCapture(
        createPreparedRequestLogger(log, {
          id: "synthetic",
          model: "gemini-3.8-flash",
          provider: "antigravity",
        }),
        () =>
          fetchAntigravityWithReadinessTimeout(
            "https://synthetic.invalid/generation",
            {
              method: "POST",
              body: prepared,
              headers: { authorization: "Bearer SECRET_HEADER_NEVER_STORED" },
            },
            1000,
            1000,
            prepared
          )
      );
      const preview = await readAntigravityErrorBody(response);
      assert.ok(preview.length <= 256 * 1024);
      log.logProviderResponse(400, "Bad Request", response.headers, preview);
      log.logError(new Error("synthetic native HTTP400 failure"));
      capturedPipeline = log.getPipelinePayloads();
      return { response: new Response(preview, { status: 400 }) };
    });
    assert.equal(result.response.status, 400);
    await result.response.text();
    const manifest = await readDiagnosticOverflowManifest(traceId);
    assert.ok(manifest);
    assert.equal(manifest.state, "complete");
    assert.equal(manifest.attempts.length, 1);
    const attempt = manifest.attempts[0];
    assert.equal(attempt.status, 400);
    assert.equal(attempt.response.complete, true);
    assert.ok(!JSON.stringify(manifest).includes("SECRET_HEADER_NEVER_STORED"));
    assert.equal(hash(await decoded(traceId, traceId, "client-request")), hash(originalJSON));
    assert.equal(hash(await decoded(traceId, attempt.attemptId, "request")), hash(wireJSON));
    assert.equal(hash(await decoded(traceId, attempt.attemptId, "response")), hash(responseJSON));
    assert.ok(capturedPipeline);
    const artifact = writeCallArtifact({
      schemaVersion: 5,
      summary: {
        id: traceId,
        timestamp: new Date().toISOString(),
        method: "POST",
        path: "/v1/chat/completions",
        status: 400,
        model: "synthetic",
        requestedModel: null,
        provider: "antigravity",
        account: "synthetic",
        connectionId: null,
        duration: 1,
        tokens: {
          in: 0,
          out: 0,
          cacheRead: null,
          cacheWrite: null,
          reasoning: null,
          compressed: null,
        },
        requestType: "chat",
        sourceFormat: "openai",
        targetFormat: "gemini",
        apiKeyId: null,
        apiKeyName: null,
        comboName: null,
        comboStepId: null,
        comboExecutionKey: null,
      },
      requestBody: JSON.parse(originalJSON),
      responseBody: { error: "synthetic native HTTP400 failure" },
      error: "synthetic native HTTP400 failure",
      pipeline: capturedPipeline,
    });
    assert.ok(artifact);
    assert.ok(artifact.sizeBytes <= 10 * 1024 * 1024);
    const saved = readCallArtifact(artifact.relPath).artifact;
    assert.ok(saved);
    assert.equal(saved.pipeline?.diagnosticOverflow?.traceId, traceId);
    assert.match(
      JSON.stringify(saved),
      /call_log_artifact_size_limit_exceeded|omitted: call log artifact size limit exceeded/
    );
    assert.equal(getActiveDiagnosticOverflowCount(), 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("403 removal and regional disposal retain independent complete attempt responses", async () => {
  const originalFetch = globalThis.fetch;
  let sends = 0,
    traceId = "";
  const responses = [
    JSON.stringify({ error: { code: 403, message: "remove project header" } }),
    JSON.stringify({ error: { code: 503, message: "regional capacity" } }),
    JSON.stringify({
      response: { candidates: [{ content: { parts: [{ text: "OK" }] }, finishReason: "STOP" }] },
    }),
  ];
  try {
    globalThis.fetch = async () =>
      new Response(responses[sends++], {
        status: sends === 1 ? 403 : sends === 2 ? 503 : 200,
        headers: { "content-type": "application/json" },
      });
    const result = await runWithDiagnosticCaptureLifecycle(async () => {
      const { log } = await logger({ messages: [{ role: "user", content: "synthetic" }] });
      traceId = log.getDiagnosticOverflowTrace()!.traceId;
      return runWithCapture(
        createPreparedRequestLogger(log, {
          id: "regional",
          model: "synthetic",
          provider: "antigravity",
        }),
        async () => {
          const first = await sendAntigravityRequest(
            "antigravity",
            "https://synthetic.invalid/region-one",
            "synthetic",
            { authorization: "Bearer private", "x-goog-user-project": "synthetic" },
            { project: "synthetic", model: "synthetic", request: { contents: [] } },
            {} as never,
            false,
            null,
            toSafeAntigravityLog(null),
            0
          );
          await disposeAntigravityResponse(first.response);
          const next = await fetchAntigravityWithReadinessTimeout(
            "https://synthetic.invalid/region-two",
            { method: "POST", body: '{"request":{}}' },
            1000,
            1000,
            '{"request":{}}'
          );
          return { response: next };
        }
      );
    });
    await result.response.text();
    const manifest = await readDiagnosticOverflowManifest(traceId);
    assert.ok(manifest);
    assert.equal(sends, 3);
    assert.equal(manifest.attempts.length, 3);
    assert.deepEqual(
      manifest.attempts.map((x) => x.status),
      [403, 503, 200]
    );
    for (let i = 0; i < 3; i++) {
      assert.equal(manifest.attempts[i].response.complete, true);
      assert.equal(
        (await decoded(traceId, manifest.attempts[i].attemptId, "response")).toString(),
        responses[i]
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("supported response text/json/arrayBuffer consume the captured reader exactly once", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const method of ["text", "json", "arrayBuffer"] as const) {
      let traceId = "",
        reads = 0;
      const json = '{"sentinel":"exact method body"}';
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              reads++;
              controller.enqueue(encoder.encode(json));
              controller.close();
            },
          })
        );
      const { log } = await logger({ messages: [] });
      traceId = log.getDiagnosticOverflowTrace()!.traceId;
      const response = await runWithCapture(
        createPreparedRequestLogger(log, {
          id: method,
          model: "synthetic",
          provider: "antigravity",
        }),
        () =>
          fetchAntigravityWithReadinessTimeout(
            "https://synthetic.invalid",
            { method: "POST", body: '{"request":{}}' },
            1000,
            1000,
            '{"request":{}}'
          )
      );
      const value = await response[method]();
      if (method === "text") assert.equal(value, json);
      if (method === "json") assert.deepEqual(value, { sentinel: "exact method body" });
      if (method === "arrayBuffer")
        assert.equal(Buffer.from(value as ArrayBuffer).toString(), json);
      await log.getDiagnosticOverflowTrace()!.finish();
      const manifest = await readDiagnosticOverflowManifest(traceId);
      assert.ok(manifest);
      assert.equal(reads, 1);
      assert.equal(manifest.attempts[0].response.complete, true);
      assert.equal(
        (await decoded(traceId, manifest.attempts[0].attemptId, "response")).toString(),
        json
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cancel and unsupported clone seal incomplete rather than claiming full capture", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("prefix"));
          },
        })
      );
    const { log } = await logger({ messages: [] });
    const response = await runWithCapture(
      createPreparedRequestLogger(log, {
        id: "cancel",
        model: "synthetic",
        provider: "antigravity",
      }),
      () =>
        fetchAntigravityWithReadinessTimeout(
          "https://synthetic.invalid",
          { method: "POST", body: '{"request":{}}' },
          1000,
          1000,
          '{"request":{}}'
        )
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await log.getDiagnosticOverflowTrace()!.finish();
    const manifest = await readDiagnosticOverflowManifest(
      log.getDiagnosticOverflowTrace()!.traceId
    );
    assert.ok(manifest);
    assert.equal(manifest.state, "incomplete");
    assert.equal(manifest.attempts[0].response.complete, false);
    globalThis.fetch = async () => new Response("clone source");
    const next = await logger({ messages: [] });
    const cloneResponse = await runWithCapture(
      createPreparedRequestLogger(next.log, {
        id: "clone",
        model: "synthetic",
        provider: "antigravity",
      }),
      () =>
        fetchAntigravityWithReadinessTimeout(
          "https://synthetic.invalid",
          { method: "POST", body: '{"request":{}}' },
          1000,
          1000,
          '{"request":{}}'
        )
    );
    assert.equal(await cloneResponse.clone().text(), "clone source");
    await next.log.getDiagnosticOverflowTrace()!.finish();
    assert.equal(
      (await readDiagnosticOverflowManifest(next.log.getDiagnosticOverflowTrace()!.traceId))?.state,
      "incomplete"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("noLog/video eligibility false creates no payload files and defaultoff does not touch body getter", async () => {
  const before = (await listDiagnosticOverflowTraces({ limit: 100 })).length;
  for (const reason of ["noLog", "video-redaction"]) {
    const { log } = await logger({ messages: [{ role: "user", content: reason }] }, false);
    assert.equal(log.getDiagnosticOverflowTrace(), null);
  }
  assert.equal((await listDiagnosticOverflowTraces({ limit: 100 })).length, before);
  const original = process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
  process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "false";
  let enumerated = false;
  const body = {
    toJSON() {
      enumerated = true;
      return {};
    },
  };
  const raw = buildClientRawRequest(new Request("http://synthetic.invalid"), body, true);
  assert.equal(getDiagnosticClientJson(raw), undefined);
  assert.equal(enumerated, false);
  assert.equal(
    await createDiagnosticOverflowTrace({ eligible: true, provider: "antigravity" }),
    null
  );
  process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = original;
});

test("credits retry has its own exact serialized body and complete captured response", async () => {
  const originalFetch = globalThis.fetch;
  let traceId = "",
    wire = "";
  const responseText =
    "data: " +
    JSON.stringify({
      response: {
        candidates: [{ content: { parts: [{ text: "credits" }] }, finishReason: "STOP" }],
      },
    }) +
    "\n\ndata: [DONE]\n\n";
  try {
    globalThis.fetch = async (_url, init) => {
      wire = String(init?.body);
      return new Response(responseText, { headers: { "content-type": "text/event-stream" } });
    };
    const result = await runWithDiagnosticCaptureLifecycle(async () => {
      const { log } = await logger({ messages: [] });
      traceId = log.getDiagnosticOverflowTrace()!.traceId;
      return runWithCapture(
        createPreparedRequestLogger(log, {
          id: "credits",
          model: "synthetic",
          provider: "antigravity",
        }),
        async () => {
          const result = await tryCreditsRetry(
            "antigravity",
            "https://synthetic.invalid/credits",
            {},
            { project: "synthetic", model: "synthetic", request: { contents: [] } },
            {} as never,
            false,
            null,
            toSafeAntigravityLog(null),
            "synthetic",
            () => {}
          );
          assert.ok(result);
          return result;
        }
      );
    });
    assert.equal(await result.response.text(), responseText);
    const manifest = await readDiagnosticOverflowManifest(traceId);
    assert.ok(manifest);
    assert.equal(manifest.attempts.length, 1);
    assert.ok(wire.includes("GOOGLE_ONE_AI"));
    assert.equal(
      hash(await decoded(traceId, manifest.attempts[0].attemptId, "request")),
      hash(wire)
    );
    assert.equal(
      hash(await decoded(traceId, manifest.attempts[0].attemptId, "response")),
      hash(responseText)
    );
    assert.equal(manifest.attempts[0].response.complete, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an aborted pre-response attempt is retained as incomplete without adding a request", async () => {
  const originalFetch = globalThis.fetch;
  let sends = 0;
  try {
    globalThis.fetch = async (_url, init) => {
      sends++;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };
    const { log } = await logger({ messages: [] });
    const signal = new AbortController();
    const pending = runWithCapture(
      createPreparedRequestLogger(log, {
        id: "abort",
        model: "synthetic",
        provider: "antigravity",
      }),
      () =>
        fetchAntigravityWithReadinessTimeout(
          "https://synthetic.invalid",
          { method: "POST", body: '{"request":{}}', signal: signal.signal },
          1000,
          1000,
          '{"request":{}}'
        )
    );
    setTimeout(() => signal.abort(new Error("synthetic caller")), 30);
    await assert.rejects(pending);
    await log.getDiagnosticOverflowTrace()!.finish();
    const manifest = await readDiagnosticOverflowManifest(
      log.getDiagnosticOverflowTrace()!.traceId
    );
    assert.ok(manifest);
    assert.equal(sends, 1);
    assert.equal(manifest.state, "incomplete");
    assert.equal(manifest.attempts.length, 1);
    assert.equal(manifest.attempts[0].response.complete, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
