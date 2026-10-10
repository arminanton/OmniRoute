import test from "node:test";
import assert from "node:assert/strict";

import { buildClientRawRequest } from "../../src/sse/handlers/chat/clientRawRequest.ts";
import { logClientRawRequestRedacted } from "../../src/lib/guardrails/videoBridgeSnapshotRedaction.ts";
import { getChatLogClientTextLimit } from "../../src/lib/logEnv.ts";
import { cloneBoundedForLog, createRequestLogger } from "../../open-sse/utils/requestLogger.ts";

async function createLogger() {
  return createRequestLogger(undefined, undefined, "gpt-5.6", {
    captureStreamChunks: false,
  });
}

function requestFor(body: unknown): Request {
  return new Request("http://synthetic.invalid/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function withoutTimestamp(value: Record<string, unknown>) {
  const { timestamp: _timestamp, ...stable } = value;
  return stable;
}

test("chat-path logging reuses the bounded snapshot and retains the effective-input reference", async () => {
  const original = {
    model: "gpt-5.6",
    input: [{ type: "message", role: "user", content: "same input" }],
    stream: true,
  };
  const bounded = cloneBoundedForLog(
    original,
    0,
    null,
    getChatLogClientTextLimit()
  ) as typeof original;
  const clientRawRequest = {
    endpoint: "/v1/responses",
    body: bounded,
    headers: {},
    effectiveInput: original.input,
  };
  const logger = await createLogger();

  logClientRawRequestRedacted(logger, clientRawRequest, false, true);

  const captured = logger.getPipelinePayloads()?.clientRawRequest;
  assert.ok(captured);
  assert.strictEqual(captured.body, bounded, "the second bounded object tree is avoided");
  assert.equal(captured.effectiveInputRef, "body.input");
  assert.equal(Object.hasOwn(captured, "effectiveInput"), false);
  assert.deepEqual(bounded, original, "logging leaves the producer-owned snapshot unchanged");
  assert.deepEqual(original.input, [{ type: "message", role: "user", content: "same input" }]);
});

test("generic request-logger callers still receive a defensive bounded clone", async () => {
  const original = {
    model: "gpt-5.6",
    input: [
      {
        type: "message",
        role: "user",
        content: `generic caller ${"x".repeat(70_000)}`,
      },
    ],
  };
  const logger = await createLogger();

  logger.logClientRawRequest("/v1/responses", original, {}, original.input);

  const captured = logger.getPipelinePayloads()?.clientRawRequest;
  assert.ok(captured);
  assert.notStrictEqual(captured.body, original);
  const capturedBody = captured.body as typeof original;
  assert.ok(capturedBody.input[0].content.length <= 65_536);
  assert.match(capturedBody.input[0].content, /\[\.\.\.truncated \d+ chars\.\.\.\]/);
  assert.equal(captured.effectiveInputRef, "body.input");
  assert.equal(original.input[0].content.length, 70_015, "the source body stays unmodified");
});

test("error capture reuses bounded source snapshots without cloning request bodies again", async () => {
  let clientInputReads = 0;
  const clientBody = {
    model: "gpt-5.6",
    get input() {
      clientInputReads++;
      return [{ role: "user", content: "client input" }];
    },
  };
  const logger = await createLogger();

  logger.logClientRawRequest("/v1/responses", clientBody);
  const clientReadsAfterCapture = clientInputReads;
  logger.logError(new Error("upstream failed"), clientBody);
  assert.equal(clientInputReads, clientReadsAfterCapture);
  const clientPipeline = logger.getPipelinePayloads();
  assert.strictEqual(clientPipeline?.error?.requestBody, clientPipeline?.clientRawRequest?.body);

  let providerInputReads = 0;
  const providerBody = {
    model: "gpt-5.6",
    get input() {
      providerInputReads++;
      return [{ role: "user", content: "provider input" }];
    },
  };
  logger.logTargetRequest("https://synthetic.invalid/responses", {}, providerBody);
  const providerReadsAfterCapture = providerInputReads;
  logger.logError(new Error("provider rejected request"), providerBody);
  assert.equal(providerInputReads, providerReadsAfterCapture);
  const providerPipeline = logger.getPipelinePayloads();
  assert.strictEqual(providerPipeline?.error?.requestBody, providerPipeline?.providerRequest?.body);
});

test("prebounded and generic paths produce byte-identical request-stage payloads", async () => {
  const original = {
    model: "gpt-5.6",
    input: Array.from({ length: 1002 }, (_, index) => ({
      type: "message",
      role: index % 2 ? "assistant" : "user",
      content: `message-${index}`,
    })),
    stream: true,
  };
  const bounded = cloneBoundedForLog(original, 0, null, getChatLogClientTextLimit());
  const genericLogger = await createLogger();
  const preboundedLogger = await createLogger();

  genericLogger.logClientRawRequest("/v1/responses", original, {}, original.input);
  logClientRawRequestRedacted(
    preboundedLogger,
    { endpoint: "/v1/responses", body: bounded, headers: {}, effectiveInput: original.input },
    false,
    true
  );

  const generic = genericLogger.getPipelinePayloads()?.clientRawRequest;
  const prebounded = preboundedLogger.getPipelinePayloads()?.clientRawRequest;
  assert.ok(generic && prebounded);
  assert.equal(
    JSON.stringify(withoutTimestamp(generic)),
    JSON.stringify(withoutTimestamp(prebounded)),
    "bounded arrays, truncation markers, and effectiveInput references stay byte-identical"
  );
  assert.equal(prebounded.effectiveInputRef, "body.input");
  assert.deepEqual(original.input.at(-1), {
    type: "message",
    role: "assistant",
    content: "message-1001",
  });
});

test("video transcript redaction stays isolated when the redacted snapshot is reused", async () => {
  const secret = "synthetic private video transcript";
  const original = {
    model: "openai/gpt-x",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_video",
            video_url: "https://synthetic.invalid/video.mp4",
            transcript: secret,
          },
        ],
      },
    ],
  };
  const clientRawRequest = buildClientRawRequest(requestFor(original), original);
  const logger = await createLogger();

  logClientRawRequestRedacted(logger, clientRawRequest, true, true);

  const captured = logger.getPipelinePayloads()?.clientRawRequest;
  assert.ok(captured);
  const capturedJson = JSON.stringify(captured.body);
  assert.equal(capturedJson.includes(secret), false);
  assert.match(capturedJson, /\[redacted-video-transcript\]/);
  assert.ok(JSON.stringify(clientRawRequest.body).includes(secret));
  assert.ok(JSON.stringify(original).includes(secret));
});

test("changed continuation input remains a separate bounded snapshot", async () => {
  const rawInput = [{ type: "message", role: "user", content: "current turn" }];
  const effectiveInput = [
    { type: "message", role: "system", content: "reconstructed prior context" },
    ...rawInput,
  ];
  const rawBody = { model: "gpt-5.6", input: rawInput, previous_response_id: "resp_previous" };
  const bounded = cloneBoundedForLog(rawBody, 0, null, getChatLogClientTextLimit());
  const logger = await createLogger();

  logClientRawRequestRedacted(
    logger,
    { endpoint: "/v1/responses", body: bounded, headers: {}, effectiveInput },
    false,
    true
  );

  const captured = logger.getPipelinePayloads()?.clientRawRequest;
  assert.ok(captured);
  assert.equal(Object.hasOwn(captured, "effectiveInputRef"), false);
  assert.notStrictEqual(captured.effectiveInput, effectiveInput);
  assert.deepEqual(captured.effectiveInput, effectiveInput);
  assert.deepEqual(rawBody.input, rawInput, "the caller's request remains untouched");
});
