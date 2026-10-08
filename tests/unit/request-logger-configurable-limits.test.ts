import test from "node:test";
import assert from "node:assert/strict";
import { cloneBoundedForLog, createRequestLogger } from "../../open-sse/utils/requestLogger.ts";

function withLimits(text: string | undefined, keys: string | undefined, run: () => void) {
  const priorText = process.env.CHAT_LOG_TEXT_LIMIT;
  const priorKeys = process.env.CHAT_LOG_MAX_OBJECT_KEYS;
  try {
    if (text === undefined) delete process.env.CHAT_LOG_TEXT_LIMIT;
    else process.env.CHAT_LOG_TEXT_LIMIT = text;
    if (keys === undefined) delete process.env.CHAT_LOG_MAX_OBJECT_KEYS;
    else process.env.CHAT_LOG_MAX_OBJECT_KEYS = keys;
    run();
  } finally {
    if (priorText === undefined) delete process.env.CHAT_LOG_TEXT_LIMIT;
    else process.env.CHAT_LOG_TEXT_LIMIT = priorText;
    if (priorKeys === undefined) delete process.env.CHAT_LOG_MAX_OBJECT_KEYS;
    else process.env.CHAT_LOG_MAX_OBJECT_KEYS = priorKeys;
  }
}
const record = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`field${i}`, i]));

test("pipeline clone retains a diagnostic tool result above the old 64K cap", () => {
  withLimits("131072", "120", () => {
    const result = "approved diagnostic result:" + "x".repeat(100000);
    assert.equal(cloneBoundedForLog(result), result);
    assert.deepEqual(cloneBoundedForLog(record), record);
  });
});

test("client request logs reference effectiveInput when it duplicates body.input", async () => {
  const logger = await createRequestLogger(undefined, undefined, "gpt-5.6", {
    captureStreamChunks: false,
  });
  const input = [{ type: "message", role: "user", content: "same logged input" }];
  const body = { model: "gpt-5.6", input, stream: true };
  logger.logClientRawRequest("/v1/responses", body, {}, input);

  const clientRawRequest = logger.getPipelinePayloads()?.clientRawRequest;
  assert.ok(clientRawRequest);
  assert.equal(clientRawRequest.effectiveInputRef, "body.input");
  assert.equal(Object.hasOwn(clientRawRequest, "effectiveInput"), false);
  assert.deepEqual(
    (clientRawRequest.body as Record<string, unknown>).input,
    input,
    "the raw request remains available for continuation reconstruction"
  );

  const deduplicatedBytes = Buffer.byteLength(JSON.stringify(clientRawRequest));
  const legacyBytes = Buffer.byteLength(
    JSON.stringify({ ...clientRawRequest, effectiveInput: input, effectiveInputRef: undefined })
  );
  assert.ok(deduplicatedBytes < legacyBytes);
});

test("large equal inputs are deduplicated before building a second bounded snapshot", async () => {
  const priorTextLimit = process.env.CHAT_LOG_TEXT_LIMIT;
  const priorClientLimit = process.env.CHAT_LOG_CLIENT_TEXT_LIMIT;
  try {
    process.env.CHAT_LOG_TEXT_LIMIT = "524288";
    delete process.env.CHAT_LOG_CLIENT_TEXT_LIMIT;
    const logger = await createRequestLogger(undefined, undefined, "gpt-5.6", {
      captureStreamChunks: false,
    });
    const input = [
      { type: "message", role: "user", content: "large repeated payload:" + "x".repeat(256_000) },
    ];
    logger.logClientRawRequest(
      "/v1/responses",
      { model: "gpt-5.6", input: structuredClone(input), stream: true },
      {},
      input
    );

    const clientRawRequest = logger.getPipelinePayloads()?.clientRawRequest;
    assert.ok(clientRawRequest);
    assert.equal(clientRawRequest.effectiveInputRef, "body.input");
    assert.equal(Object.hasOwn(clientRawRequest, "effectiveInput"), false);
    assert.ok(
      Buffer.byteLength(JSON.stringify(clientRawRequest)) <
        Buffer.byteLength(
          JSON.stringify({
            ...clientRawRequest,
            effectiveInput: input,
            effectiveInputRef: undefined,
          })
        )
    );
  } finally {
    if (priorTextLimit === undefined) delete process.env.CHAT_LOG_TEXT_LIMIT;
    else process.env.CHAT_LOG_TEXT_LIMIT = priorTextLimit;
    if (priorClientLimit === undefined) delete process.env.CHAT_LOG_CLIENT_TEXT_LIMIT;
    else process.env.CHAT_LOG_CLIENT_TEXT_LIMIT = priorClientLimit;
  }
});

test("deduplication preserves the separate effective-input text cap", async () => {
  const priorTextLimit = process.env.CHAT_LOG_TEXT_LIMIT;
  const priorClientLimit = process.env.CHAT_LOG_CLIENT_TEXT_LIMIT;
  try {
    process.env.CHAT_LOG_TEXT_LIMIT = "65536";
    process.env.CHAT_LOG_CLIENT_TEXT_LIMIT = "131072";
    const logger = await createRequestLogger(undefined, undefined, "gpt-5.6", {
      captureStreamChunks: false,
    });
    const input = [{ type: "message", role: "user", content: "x".repeat(100_000) }];
    logger.logClientRawRequest(
      "/v1/responses",
      { model: "gpt-5.6", input: structuredClone(input) },
      {},
      input
    );

    const clientRawRequest = logger.getPipelinePayloads()?.clientRawRequest;
    assert.ok(clientRawRequest);
    assert.equal(Object.hasOwn(clientRawRequest, "effectiveInputRef"), false);
    assert.equal(Object.hasOwn(clientRawRequest, "effectiveInput"), true);
    const effectiveInput = clientRawRequest.effectiveInput as Array<{ content: string }>;
    assert.ok(effectiveInput[0].content.length <= 65_536);
    assert.ok(
      (clientRawRequest.body as { input: Array<{ content: string }> }).input[0].content.length >
        effectiveInput[0].content.length
    );
  } finally {
    if (priorTextLimit === undefined) delete process.env.CHAT_LOG_TEXT_LIMIT;
    else process.env.CHAT_LOG_TEXT_LIMIT = priorTextLimit;
    if (priorClientLimit === undefined) delete process.env.CHAT_LOG_CLIENT_TEXT_LIMIT;
    else process.env.CHAT_LOG_CLIENT_TEXT_LIMIT = priorClientLimit;
  }
});

test("client request logs retain effectiveInput when continuation changes it", async () => {
  const logger = await createRequestLogger(undefined, undefined, "gpt-5.6", {
    captureStreamChunks: false,
  });
  const rawInput = [{ type: "message", role: "user", content: "current turn" }];
  const effectiveInput = [
    { type: "message", role: "system", content: "reconstructed prior context" },
    ...rawInput,
  ];
  logger.logClientRawRequest(
    "/v1/responses",
    { model: "gpt-5.6", input: rawInput, previous_response_id: "resp_previous" },
    {},
    effectiveInput
  );

  const clientRawRequest = logger.getPipelinePayloads()?.clientRawRequest;
  assert.ok(clientRawRequest);
  assert.equal(Object.hasOwn(clientRawRequest, "effectiveInputRef"), false);
  assert.deepEqual(clientRawRequest.effectiveInput, effectiveInput);
});

test("configured pipeline limits are bounded and idempotent", () => {
  withLimits("256", "3", () => {
    const input = { ...record, nested: "x".repeat(2000) };
    const cloned = cloneBoundedForLog(input) as Record<string, unknown>;
    assert.equal(cloned._omniroute_truncated_keys, 118);
    assert.equal(Object.keys(cloned).length, 4);
    const text = cloneBoundedForLog("x".repeat(2000)) as string;
    assert.ok(text.length <= 256);
    assert.deepEqual(cloneBoundedForLog(cloned), cloned);
    assert.equal(cloneBoundedForLog(text), text);
  });
});
test("zero object-key cap means all keys, matching the chatCore clone", () => {
  withLimits(undefined, "0", () => assert.deepEqual(cloneBoundedForLog(record), record));
});
test("defaults and invalid limits preserve 64K strings and 80 keys", () => {
  for (const [text, keys] of [
    [undefined, undefined],
    ["invalid", "-1"],
  ]) {
    withLimits(text, keys, () => {
      const str = cloneBoundedForLog("x".repeat(70000)) as string;
      assert.ok(str.length <= 65536);
      const obj = cloneBoundedForLog(record) as Record<string, unknown>;
      assert.equal(obj._omniroute_truncated_keys, 40);
      assert.equal(Object.keys(obj).length, 81);
    });
  }
});
test("even tiny configured string caps bound the truncation marker", () => {
  withLimits("8", undefined, () => {
    const result = cloneBoundedForLog("x".repeat(1000)) as string;
    assert.ok(result.length <= 8);
    assert.equal(cloneBoundedForLog(result), result);
  });
});
test("diagnostic limit changes preserve secret-header and binary redaction", async () => {
  const logger = await createRequestLogger(undefined, undefined, undefined, {
    captureStreamChunks: false,
  });
  withLimits("131072", "120", () => {
    const secret = "synthetic-private-authorization-credential";
    const content = "x".repeat(100000);
    logger.logTargetRequest(
      "https://synthetic.invalid",
      { authorization: secret, "x-api-key": secret },
      { opaque: new Uint8Array(500), content }
    );
    const payload = logger.getPipelinePayloads();
    assert.ok(payload);
    assert.ok(!JSON.stringify(payload).includes(secret));
    const body = payload.providerRequest?.body as Record<string, unknown>;
    assert.equal(body.opaque, "[binary 500 bytes]");
    assert.equal(body.content, content);
  });
});

test("provider attempt diagnostics are retained with a fixed per-request cap", async () => {
  const logger = await createRequestLogger(undefined, undefined, "gemini-3.8-flash-high", {
    provider: "antigravity",
    captureStreamChunks: false,
  });
  assert.equal(typeof logger.logProviderAttempt, "function");

  for (let index = 0; index < 25; index++) {
    logger.logProviderAttempt?.({
      kind: "http_error",
      status: 429,
      index,
      upstreamError: {
        status: "RESOURCE_EXHAUSTED",
        details: [{ reason: "RATE_LIMIT_EXCEEDED" }],
      },
    });
  }

  const payloads = logger.getPipelinePayloads();
  assert.equal(payloads?.providerAttemptDiagnostics?.length, 24);
  assert.equal(payloads?.providerAttemptDiagnosticsDropped, 1);
});
