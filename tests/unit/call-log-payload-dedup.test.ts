import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-dedup-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const ORIGINAL_PIPELINE_MAX_KB = process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;

const { CALL_LOGS_DIR, compactCallLogRepeatedText, readCallArtifact, writeCallArtifact } =
  await import("../../src/lib/usage/callLogArtifacts.ts");
const callLogs = await import("../../src/lib/usage/callLogs.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { closeCallLogArtifactWriter } = await import("../../src/lib/usage/callLogArtifactWriter.ts");

function artifact(
  requestBody: unknown,
  responseBody: unknown,
  options: { schemaVersion?: 5 | 6; clientRequestBody?: unknown; clientResponseBody?: unknown } = {}
) {
  return {
    schemaVersion: options.schemaVersion ?? 6,
    summary: {
      id: `dedup-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      method: "POST",
      path: "/v1/responses",
      status: 200,
      model: "codex/gpt-6.1-sol",
      requestedModel: "codex/gpt-6.1-sol",
      provider: "codex",
      account: "test",
      connectionId: null,
      duration: 1,
      tokens: {
        in: 1,
        out: 1,
        cacheRead: null,
        cacheWrite: null,
        reasoning: null,
        compressed: null,
      },
      requestType: null,
      sourceFormat: "openai-responses",
      targetFormat: "openai-responses",
      apiKeyId: null,
      apiKeyName: null,
      comboName: null,
      comboStepId: null,
      comboExecutionKey: null,
    },
    requestBody,
    responseBody,
    error: null,
    pipeline: {
      clientRawRequest: {
        endpoint: "/v1/responses",
        headers: {},
        body: options.clientRequestBody ?? requestBody,
      },
      clientResponse: {
        timestamp: new Date().toISOString(),
        body: options.clientResponseBody ?? responseBody,
      },
    },
  };
}

function writeAndRead(input: ReturnType<typeof artifact>) {
  const relativePath = `payload-dedup/${input.summary.id}.json`;
  const writeResult = writeCallArtifact(input as never, relativePath);
  assert.ok(writeResult, "artifact should be written");
  const filePath = path.join(CALL_LOGS_DIR!, relativePath);
  const storedJson = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const result = readCallArtifact(relativePath);
  assert.equal(result.state, "ready");
  assert.ok(result.artifact);
  return { storedJson, artifact: result.artifact, sizeBytes: writeResult.sizeBytes };
}

test("identical top-level and pipeline request/response payloads are stored once and expanded on read", () => {
  const requestBody = {
    model: "codex/gpt-6.1-sol",
    input: [{ role: "user", content: "repeated request content ".repeat(20_000) }],
  };
  const responseBody = {
    id: "resp_123",
    output: [{ type: "message", content: [{ type: "output_text", text: "generated text" }] }],
  };
  const input = artifact(requestBody, responseBody);
  const { storedJson, artifact: roundTripped, sizeBytes } = writeAndRead(input);

  assert.equal(storedJson.schemaVersion, 6);
  assert.equal(storedJson.requestBodyRef, "pipeline.clientRawRequest.body");
  assert.equal(storedJson.responseBodyRef, "pipeline.clientResponse.body");
  assert.equal(Object.hasOwn(storedJson, "requestBody"), false);
  assert.equal(Object.hasOwn(storedJson, "responseBody"), false);
  assert.deepEqual(roundTripped.requestBody, requestBody);
  assert.deepEqual(roundTripped.responseBody, responseBody);
  assert.equal(Object.hasOwn(roundTripped, "requestBodyRef"), false);
  assert.equal(Object.hasOwn(roundTripped, "responseBodyRef"), false);
  const legacyBytes = Buffer.byteLength(JSON.stringify(input));
  assert.ok(
    sizeBytes <= 512 * 1024,
    "the deduplicated artifact should fit the default 512 KiB cap"
  );
  assert.ok(
    legacyBytes - sizeBytes > 450_000,
    `the on-disk artifact should omit the duplicate payload copies (saved ${legacyBytes - sizeBytes} bytes)`
  );
});

test("identical client, OpenAI, provider, and response payloads share one stored body", () => {
  const requestBody = { model: "codex/gpt-6.1-sol", input: "x".repeat(100_000) };
  const responseBody = { output: "y".repeat(30_000) };
  const input = artifact(requestBody, responseBody);
  Object.assign(input.pipeline, {
    openaiRequest: { body: requestBody },
    providerRequest: { body: requestBody },
    providerResponse: { body: responseBody },
  });

  const { storedJson, artifact: roundTripped, sizeBytes } = writeAndRead(input);
  const storedPipeline = storedJson.pipeline as Record<string, Record<string, unknown>>;

  assert.equal(storedJson.schemaVersion, 7);
  assert.equal(storedPipeline.openaiRequest.bodyRef, "pipeline.clientRawRequest.body");
  assert.equal(storedPipeline.providerRequest.bodyRef, "pipeline.clientRawRequest.body");
  assert.equal(storedPipeline.providerResponse.bodyRef, "pipeline.clientResponse.body");
  assert.equal(Object.hasOwn(storedPipeline.openaiRequest, "body"), false);
  assert.equal(Object.hasOwn(storedPipeline.providerRequest, "body"), false);
  assert.deepEqual(roundTripped.requestBody, requestBody);
  assert.deepEqual(roundTripped.responseBody, responseBody);
  assert.deepEqual(
    (roundTripped.pipeline?.openaiRequest as Record<string, unknown>).body,
    requestBody
  );
  assert.deepEqual(
    (roundTripped.pipeline?.providerRequest as Record<string, unknown>).body,
    requestBody
  );
  assert.deepEqual(
    (roundTripped.pipeline?.providerResponse as Record<string, unknown>).body,
    responseBody
  );
  const savedBytes = Buffer.byteLength(JSON.stringify(input)) - sizeBytes;
  assert.ok(savedBytes > 300_000, `expected at least 300 KB saved, got ${savedBytes} bytes`);
});

test("pipeline error request body is stored by reference and expanded for readers", () => {
  const requestBody = { model: "codex/gpt-6.1-sol", input: "large request ".repeat(12_000) };
  const input = artifact(requestBody, { output: "ok" });
  Object.assign(input.pipeline, {
    error: {
      error: "upstream rejected the request",
      requestBody: structuredClone(requestBody),
    },
  });

  const { storedJson, artifact: roundTripped, sizeBytes } = writeAndRead(input);
  const storedPipeline = storedJson.pipeline as Record<string, Record<string, unknown>>;
  const storedError = storedPipeline.error;

  assert.equal(storedJson.schemaVersion, 10);
  assert.equal(storedError.requestBodyRef, "pipeline.clientRawRequest.body");
  assert.equal(Object.hasOwn(storedError, "requestBody"), false);
  assert.deepEqual(
    (roundTripped.pipeline?.error as Record<string, unknown>).requestBody,
    requestBody
  );
  assert.equal(
    Object.hasOwn(roundTripped.pipeline?.error as Record<string, unknown>, "requestBodyRef"),
    false
  );
  assert.ok(sizeBytes < Buffer.byteLength(JSON.stringify(input)) - 100_000);
});

test("distinct and legacy pipeline error request bodies keep their stored shape", () => {
  const requestBody = { input: "stage request" };
  const differentErrorBody = { input: "error snapshot" };
  const current = artifact(requestBody, { output: "ok" });
  Object.assign(current.pipeline, { error: { requestBody: differentErrorBody } });
  const currentResult = writeAndRead(current);
  const currentError = (
    currentResult.storedJson.pipeline as Record<string, Record<string, unknown>>
  ).error;
  assert.equal(Object.hasOwn(currentError, "requestBodyRef"), false);
  assert.deepEqual(currentError.requestBody, differentErrorBody);

  const legacy = artifact(requestBody, { output: "ok" }, { schemaVersion: 5 });
  Object.assign(legacy.pipeline, { error: { requestBody } });
  const legacyResult = writeAndRead(legacy);
  const legacyError = (legacyResult.storedJson.pipeline as Record<string, Record<string, unknown>>)
    .error;
  assert.equal(legacyResult.storedJson.schemaVersion, 5);
  assert.equal(Object.hasOwn(legacyError, "requestBodyRef"), false);
  assert.deepEqual(legacyError.requestBody, requestBody);
});

test("repeated exact stream chunk text is stored once and expanded for log consumers", () => {
  const chunkText = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(8_000) })}\n\n`;
  const input = artifact({ input: "request" }, { output: "response" });
  Object.assign(input.pipeline, {
    streamChunks: {
      provider: [chunkText, "data: [DONE]\n\n"],
      openai: [chunkText, "data: [DONE]\n\n"],
      client: [chunkText, "data: [DONE]\n\n"],
    },
  });

  const { storedJson, artifact: roundTripped, sizeBytes } = writeAndRead(input);
  const storedPipeline = storedJson.pipeline as Record<string, Record<string, unknown>>;
  const encoded = storedPipeline.streamChunks;
  assert.equal(storedJson.schemaVersion, 8);
  assert.equal(encoded.encoding, "omni-stream-chunk-text-table/v1");
  assert.deepEqual(encoded.dictionary, [chunkText, "data: [DONE]\n\n"]);
  assert.deepEqual(encoded.provider, [0, 1]);
  assert.deepEqual(encoded.openai, [0, 1]);
  assert.deepEqual(encoded.client, [0, 1]);
  assert.deepEqual(roundTripped.pipeline?.streamChunks, {
    provider: [chunkText, "data: [DONE]\n\n"],
    openai: [chunkText, "data: [DONE]\n\n"],
    client: [chunkText, "data: [DONE]\n\n"],
  });

  const legacyBytes = Buffer.byteLength(JSON.stringify(input));
  assert.ok(legacyBytes - sizeBytes > 16_000, "repeated chunk text should be stored once");
});

test("repeated long request and response text is stored once and expanded on read", () => {
  const repeatedText = `Shared system policy and tool instructions for this session. ${"Keep the result exact. ".repeat(1800)}`;
  const requestBody = {
    model: "codex/gpt-6.1-sol",
    input: [
      { role: "system", content: repeatedText },
      { role: "developer", content: repeatedText },
      { role: "user", content: "Please inspect this change." },
    ],
    opaqueUserObject: {
      __omniroute_exact_text_ref_v1: { token: "caller-supplied", index: 0 },
    },
  };
  const responseBody = { output: [{ type: "message", content: repeatedText }] };
  const input = artifact(requestBody, responseBody);

  const { storedJson, artifact: roundTripped, sizeBytes } = writeAndRead(input);
  assert.equal(storedJson.schemaVersion, 9);
  assert.equal(
    (storedJson.textDedupTable as Record<string, unknown>).encoding,
    "omni-exact-text-table/v1"
  );
  assert.equal((storedJson.textDedupTable as { dictionary: string[] }).dictionary.length, 1);
  assert.equal(JSON.stringify(storedJson).split(repeatedText).length - 1, 1);
  assert.deepEqual(roundTripped.requestBody, requestBody);
  assert.deepEqual(roundTripped.responseBody, responseBody);
  assert.deepEqual(
    (roundTripped.pipeline?.clientRawRequest as Record<string, unknown>).body,
    requestBody
  );
  assert.equal(Object.hasOwn(roundTripped, "textDedupTable"), false);

  const originalBytes = Buffer.byteLength(JSON.stringify(input));
  assert.ok(
    originalBytes - sizeBytes > 50_000,
    `the artifact should save duplicate prompt/output text (saved ${originalBytes - sizeBytes} bytes)`
  );
});

test("exact-text compaction fails open on accessors without evaluating them", () => {
  let getterCalls = 0;
  const requestBody = Object.defineProperty({ content: "ordinary user content" }, "computed", {
    enumerable: true,
    get() {
      getterCalls++;
      return "x".repeat(1_000);
    },
  });
  const input = artifact(requestBody, { output: "x".repeat(1_000) });

  assert.equal(compactCallLogRepeatedText(input as never), input);
  assert.equal(getterCalls, 0);
});

test("exact-text compaction leaves very large strings out of its hash table", () => {
  const largeText = "x".repeat(128 * 1024);
  const input = artifact({ input: largeText }, { output: largeText });
  input.pipeline = undefined;

  assert.equal(compactCallLogRepeatedText(input as never), input);
  assert.equal(Object.hasOwn(input, "textDedupTable"), false);
});

test("exact-text compaction fails open on a huge sparse array before scanning its length", () => {
  const sparse = new Array(100_000_000);
  const input = artifact(sparse, { output: "ordinary response" });
  input.pipeline = undefined;

  const started = process.hrtime.bigint();
  assert.equal(compactCallLogRepeatedText(input as never), input);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 1_000, `sparse-array guard should return promptly, took ${elapsedMs}ms`);
});

test("exact-text compaction rejects a dense oversized array before materializing its descriptors", () => {
  const dense = new Array(100_001).fill(null);
  const input = artifact(dense, { output: "ordinary response" });
  input.pipeline = undefined;

  assert.ok(compactCallLogRepeatedText(input as never) === input);
});

test("exact-text compaction preserves non-enumerable array indices JSON would serialize", () => {
  const repeatedText = `non-enumerable array entry ${"same exact text ".repeat(30)}`;
  const requestBody: unknown[] = [];
  Object.defineProperty(requestBody, "0", {
    value: repeatedText,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  requestBody.length = 1;
  const input = artifact(requestBody, { output: repeatedText });
  input.pipeline = undefined;

  const { artifact: roundTripped } = writeAndRead(input);
  assert.ok(roundTripped.requestBody);
  assert.equal(JSON.stringify(roundTripped.requestBody), JSON.stringify(requestBody));
});

test("exact-text compaction stops hashing when cumulative candidate text exceeds its budget", () => {
  const repeated = "x".repeat(64 * 1024);
  const input = artifact(
    Array.from({ length: 129 }, () => repeated),
    { output: "response" }
  );
  input.pipeline = undefined;

  assert.equal(compactCallLogRepeatedText(input as never), input);
  assert.equal(Object.hasOwn(input, "textDedupTable"), false);
});

test("exact-text compaction fails open on custom-prototype values the reader would project to JSON", () => {
  const repeated = `repeated prompt value ${"word ".repeat(300)}`;
  const custom = Object.assign(Object.create({ inherited: "not serialized" }), {
    payload: "x".repeat(64 * 1024),
  });
  const input = artifact({ custom, prompt: repeated }, { output: repeated });
  input.pipeline = undefined;

  assert.ok(compactCallLogRepeatedText(input as never) === input);
  assert.equal(Object.hasOwn(input, "textDedupTable"), false);
});

test("exact-text compaction stops a wide plain-object walk at the visited-value budget", () => {
  const wide = Object.create(null) as Record<string, string>;
  for (let index = 0; index < 100_001; index++) wide[`key-${index}`] = "value";
  const input = artifact({ wide, prompt: "repeated content ".repeat(100) }, { output: "response" });
  input.pipeline = undefined;

  assert.ok(compactCallLogRepeatedText(input as never) === input);
  assert.equal(Object.hasOwn(input, "textDedupTable"), false);
});

test("exact-text compaction refuses a candidate that could exceed the reader expansion budget", () => {
  const repeatedCandidate = "x".repeat(64 * 1024);
  const repeatedShortText = "s".repeat(255);
  const input = artifact(
    [
      ...Array.from({ length: 100 }, () => repeatedCandidate),
      ...Array.from({ length: 42_000 }, () => repeatedShortText),
    ],
    { output: "response" }
  );
  input.pipeline = undefined;

  assert.ok(compactCallLogRepeatedText(input as never) === input);
  assert.equal(Object.hasOwn(input, "textDedupTable"), false);
});

test("exact-text compaction leaves pathological JSON-escaped dictionaries inline", () => {
  const strings = Array.from({ length: 15 }, (_, index) =>
    String.fromCharCode(index + 1).repeat(64 * 1024)
  );
  const input = artifact(
    strings,
    strings.map((value) => value)
  );
  input.pipeline = undefined;

  assert.ok(compactCallLogRepeatedText(input as never) === input);
  assert.equal(Object.hasOwn(input, "textDedupTable"), false);
});

test("exact-text compaction does not evaluate pipeline accessors or retain a broken partial table", () => {
  let getterCalls = 0;
  const pipeline = Object.defineProperty({}, "clientRawRequest", {
    enumerable: true,
    get() {
      getterCalls++;
      throw new Error("must not run during optional compaction");
    },
  });
  const input = artifact({ content: "repeated value ".repeat(100) }, { output: "response" });
  input.pipeline = pipeline as never;

  assert.equal(compactCallLogRepeatedText(input as never), input);
  assert.equal(getterCalls, 0);
  assert.equal(Object.hasOwn(input, "textDedupTable"), false);
});

test("reader rejects a text table whose expanded payload exceeds the fixed safety budget", () => {
  const repeated = "x".repeat(64 * 1024);
  const reference = {
    __omniroute_exact_text_ref_v1: { token: "oversized", index: 0 },
  };
  const input = artifact(
    Array.from({ length: 300 }, () => reference),
    { output: "response" }
  );
  Object.assign(input, {
    textDedupTable: {
      encoding: "omni-exact-text-table/v1",
      token: "oversized",
      dictionary: [repeated],
    },
  });

  const relativePath = `payload-dedup/oversized-${input.summary.id}.json`;
  assert.ok(writeCallArtifact(input as never, relativePath));
  assert.equal(readCallArtifact(relativePath).state, "corrupt");
});

test("short repeated stream chunks stay inline when a dictionary would increase storage", () => {
  const input = artifact({ input: "request" }, { output: "response" });
  Object.assign(input.pipeline, {
    streamChunks: { provider: ["x"], client: ["x"] },
  });

  const { storedJson, artifact: roundTripped } = writeAndRead(input);
  const storedPipeline = storedJson.pipeline as Record<string, Record<string, unknown>>;
  assert.equal(storedJson.schemaVersion, 6);
  assert.deepEqual(storedPipeline.streamChunks, { provider: ["x"], client: ["x"] });
  assert.deepEqual(roundTripped.pipeline?.streamChunks, {
    provider: ["x"],
    client: ["x"],
  });
});

test("stream chunk extension channels are preserved without table conversion", () => {
  const chunkText = `data: ${"x".repeat(2_000)}\n\n`;
  const input = artifact({ input: "request" }, { output: "response" });
  Object.assign(input.pipeline, {
    streamChunks: {
      provider: [chunkText],
      client: [chunkText],
      extension: ["opaque extension frame"],
    },
  });

  const { storedJson, artifact: roundTripped } = writeAndRead(input);
  const storedPipeline = storedJson.pipeline as Record<string, unknown>;
  assert.equal(storedJson.schemaVersion, 6);
  assert.deepEqual(storedPipeline.streamChunks, {
    provider: [chunkText],
    client: [chunkText],
    extension: ["opaque extension frame"],
  });
  assert.deepEqual(roundTripped.pipeline?.streamChunks, storedPipeline.streamChunks);
});

test("size-limit fallback clears payload references when it removes their pipeline targets", () => {
  const previousLimit = process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
  process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "1";
  try {
    const requestBody = { input: "x".repeat(100_000) };
    const responseBody = { output: "y".repeat(30_000) };
    const input = artifact(requestBody, responseBody);
    Object.assign(input.pipeline, {
      openaiRequest: { body: requestBody },
      providerRequest: { body: requestBody },
      providerResponse: { body: responseBody },
    });

    const { storedJson, artifact: roundTripped } = writeAndRead(input);
    assert.equal(Object.hasOwn(storedJson, "requestBodyRef"), false);
    assert.equal(Object.hasOwn(storedJson, "responseBodyRef"), false);
    assert.equal(roundTripped.requestBody, "[omitted: call log artifact size limit exceeded]");
    assert.equal(roundTripped.responseBody, "[omitted: call log artifact size limit exceeded]");
  } finally {
    if (previousLimit === undefined) delete process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
    else process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = previousLimit;
  }
});

test("undefined stage bodies are not turned into references to omitted JSON properties", () => {
  const requestBody = { input: "top-level request" };
  const responseBody = { output: "top-level response" };
  const input = artifact(requestBody, responseBody);
  Object.assign(input.pipeline, {
    clientRawRequest: { body: undefined },
    openaiRequest: { body: undefined },
    providerRequest: { body: undefined },
    clientResponse: { body: undefined },
    providerResponse: { body: undefined },
  });

  const { storedJson, artifact: roundTripped } = writeAndRead(input);
  const storedPipeline = storedJson.pipeline as Record<string, Record<string, unknown>>;
  assert.equal(Object.hasOwn(storedPipeline.openaiRequest, "bodyRef"), false);
  assert.equal(Object.hasOwn(storedPipeline.providerRequest, "bodyRef"), false);
  assert.equal(Object.hasOwn(storedPipeline.providerResponse, "bodyRef"), false);
  assert.deepEqual(roundTripped.requestBody, requestBody);
  assert.deepEqual(roundTripped.responseBody, responseBody);
});

test("different payloads and legacy schema-v5 artifacts retain their original fields", () => {
  const requestBody = { input: "top-level request" };
  const responseBody = { output: "top-level response" };
  const { storedJson, artifact: roundTripped } = writeAndRead(
    artifact(requestBody, responseBody, {
      schemaVersion: 5,
      clientRequestBody: { input: "different pipeline request" },
      clientResponseBody: { output: "different pipeline response" },
    })
  );

  assert.equal(Object.hasOwn(storedJson, "requestBodyRef"), false);
  assert.equal(Object.hasOwn(storedJson, "responseBodyRef"), false);
  assert.deepEqual(roundTripped.requestBody, requestBody);
  assert.deepEqual(roundTripped.responseBody, responseBody);
});

test("saveCallLog reserves and protects a shared client request body only once", async () => {
  const requestBody = {
    model: "codex/gpt-6.1-sol",
    input: [{ role: "user", content: "shared request body ".repeat(20_000) }],
  };
  const responseBody = { id: "resp_saved", output: [{ type: "message", content: "done" }] };
  process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "512";
  await callLogs.saveCallLog({
    id: "dedup-save-call-log",
    timestamp: new Date().toISOString(),
    method: "POST",
    path: "/v1/responses",
    status: 200,
    model: requestBody.model,
    provider: "codex",
    requestBody,
    responseBody,
    pipelinePayloads: {
      clientRawRequest: {
        endpoint: "/v1/responses",
        headers: {},
        body: structuredClone(requestBody),
      },
      error: {
        error: "upstream failed after request dispatch",
        requestBody: structuredClone(requestBody),
      },
      clientResponse: {
        timestamp: new Date().toISOString(),
        body: structuredClone(responseBody),
      },
    },
  });

  const detail = await callLogs.getCallLogById("dedup-save-call-log");
  assert.ok(detail?.artifactRelPath);
  assert.equal(detail?.hasRequestBody, true);
  assert.equal(detail?.hasResponseBody, true);
  assert.deepEqual(detail?.requestBody, requestBody);
  assert.deepEqual(detail?.responseBody, responseBody);
  const diskArtifact = JSON.parse(
    fs.readFileSync(path.join(CALL_LOGS_DIR!, detail.artifactRelPath), "utf8")
  ) as Record<string, unknown>;
  assert.equal(diskArtifact.requestBodyRef, "pipeline.clientRawRequest.body");
  assert.equal(diskArtifact.responseBodyRef, "pipeline.clientResponse.body");
  assert.equal(Object.hasOwn(diskArtifact, "requestBody"), false);
  assert.equal(Object.hasOwn(diskArtifact, "responseBody"), false);
  const storedPipeline = diskArtifact.pipeline as Record<string, Record<string, unknown>>;
  assert.equal(storedPipeline.error.requestBodyRef, "pipeline.clientRawRequest.body");
  assert.equal(Object.hasOwn(storedPipeline.error, "requestBody"), false);
  const expanded = readCallArtifact(detail.artifactRelPath).artifact;
  assert.ok(expanded);
  assert.deepEqual(
    (expanded.pipeline?.error as Record<string, unknown>).requestBody,
    (expanded.pipeline?.clientRawRequest as Record<string, unknown>).body
  );
});

test("saveCallLog skips payload traversal when the artifact worker is missing", async () => {
  let traversals = 0;
  const largeText = "payload that cannot be persisted without the worker ".repeat(5_000);
  const entries = Array.from({ length: 100 }, (_, index) => {
    const requestBody = new Proxy(
      { content: largeText },
      {
        ownKeys(target) {
          traversals++;
          return Reflect.ownKeys(target);
        },
      }
    );
    return {
      id: `dedup-save-call-log-worker-missing-${index}`,
      timestamp: new Date().toISOString(),
      method: "POST",
      path: "/v1/responses",
      status: 200,
      model: "codex/gpt-6.1-sol",
      provider: "codex",
      requestBody,
      responseBody: { output: "response" },
      pipelinePayloads: {
        clientRawRequest: { endpoint: "/v1/responses", headers: {}, body: requestBody },
        ...(index === 0
          ? {
              diagnosticOverflow: {
                schema: "omni-diagnostic-overflow/v1" as const,
                traceId: "11111111-1111-4111-8111-111111111111",
                state: "complete" as const,
              },
            }
          : {}),
      },
    };
  });
  const originalExistsSync = fs.existsSync;
  fs.existsSync = ((candidate: fs.PathLike) => {
    const normalized = String(candidate).replaceAll("\\", "/");
    if (
      normalized.endsWith("/callLogArtifactWorker.js") ||
      normalized.endsWith("/callLogArtifactWorker.ts")
    ) {
      return false;
    }
    return originalExistsSync.call(fs, candidate);
  }) as typeof fs.existsSync;

  try {
    await Promise.all(entries.map((entry) => callLogs.saveCallLog(entry)));
  } finally {
    fs.existsSync = originalExistsSync;
  }

  assert.equal(traversals, 0, "unwritable payload objects should not be traversed");
  const details = await Promise.all(
    entries.map((entry) => callLogs.getCallLogById(String(entry.id)))
  );
  assert.equal(details.length, 100);
  for (const [index, detail] of details.entries()) {
    assert.equal(detail?.hasRequestBody, true);
    assert.equal(detail?.hasPipelineDetails, true);
    if (index === 0) {
      assert.equal(detail?.detailState, "ready");
      assert.ok(detail?.artifactRelPath);
      assert.equal(detail?.requestBody, "[omitted: call log artifact worker unavailable]");
      assert.equal(
        (detail?.pipelinePayloads?.error as Record<string, unknown>)?.reason,
        "call_log_artifact_worker_missing"
      );
      assert.equal(
        detail?.pipelinePayloads?.diagnosticOverflow?.traceId,
        "11111111-1111-4111-8111-111111111111"
      );
    } else {
      assert.equal(detail?.detailState, "missing");
      assert.equal(detail?.artifactRelPath, null);
    }
  }
});

test.after(async () => {
  await closeCallLogArtifactWriter();
  resetDbInstance();
  if (ORIGINAL_PIPELINE_MAX_KB === undefined) delete process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
  else process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = ORIGINAL_PIPELINE_MAX_KB;
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
