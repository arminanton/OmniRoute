import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createAntigravityRequestBody,
  sendAntigravityRequest,
  serializeAntigravityRequest,
  toSafeAntigravityLog,
} from "../../open-sse/executors/antigravity/executeAttempt.ts";

const MAX_REQUEST_CHUNK_BYTES = 64 * 1024;

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      assert.ok(
        item.value.byteLength <= MAX_REQUEST_CHUNK_BYTES,
        `request chunk exceeded ${MAX_REQUEST_CHUNK_BYTES} bytes: ${item.value.byteLength}`
      );
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

test("streaming request bodies are bounded on demand and preserve exact UTF-8 bytes", async () => {
  const body = `${"\u0800".repeat(21_844)}🙂${"€🙂".repeat(24_000)}\ud800`;
  const expected = Buffer.from(body, "utf8");

  const firstReader = (
    createAntigravityRequestBody(body, true) as ReadableStream<Uint8Array>
  ).getReader();
  const first = await firstReader.read();
  assert.equal(first.done, false);
  assert.ok(first.value);
  assert.ok(first.value.byteLength <= MAX_REQUEST_CHUNK_BYTES);
  assert.ok(
    first.value.byteLength < expected.byteLength,
    "the first pull must not encode the full body"
  );
  await firstReader.cancel("test only needs the first bounded pull");
  assert.equal((await firstReader.read()).done, true);

  const chunks: Buffer[] = [];
  const reader = (
    createAntigravityRequestBody(body, true) as ReadableStream<Uint8Array>
  ).getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      assert.ok(item.value.byteLength <= MAX_REQUEST_CHUNK_BYTES);
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  assert.deepEqual(Buffer.concat(chunks), expected);
  assert.ok(chunks.length > 2, "large requests should be emitted as multiple bounded chunks");
});

test("non-streaming Antigravity requests keep the existing serialized string body", () => {
  const body = JSON.stringify({ request: { contents: [{ parts: [{ text: "unchanged" }] }] } });
  assert.strictEqual(createAntigravityRequestBody(body, false), body);
});

test("a streamed 403 retry uses a fresh stream with identical wire bytes and duplex half", async () => {
  const received: Array<{ body: Buffer; projectHeader: string | undefined }> = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received.push({
        body: Buffer.concat(chunks),
        projectHeader: request.headers["x-goog-user-project"],
      });
      response.statusCode = received.length === 1 ? 403 : 200;
      response.setHeader("content-type", "text/event-stream");
      response.end(received.length === 1 ? 'data: {"error":"retry"}\n\n' : "data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/v1internal:streamGenerateContent?alt=sse`;

  const headers = {
    "content-type": "application/json",
    "x-goog-user-project": "synthetic-project",
  };
  const requestBody = {
    project: "synthetic-project",
    model: "gemini-3.8-flash-high",
    request: { contents: [{ role: "user", parts: [{ text: `${"prompt-".repeat(40_000)}🙂` }] }] },
  };
  const expected = Buffer.from(
    serializeAntigravityRequest("antigravity", headers, requestBody).bodyString,
    "utf8"
  );

  try {
    const result = await sendAntigravityRequest(
      "antigravity",
      url,
      "gemini-3.8-flash-high",
      headers,
      requestBody,
      { accessToken: "synthetic-token" } as never,
      true,
      null,
      toSafeAntigravityLog(null),
      0
    );
    assert.equal(result.response.status, 200);
    await result.response.body?.cancel();

    assert.equal(received.length, 2);
    assert.deepEqual(received[0].body, expected);
    assert.deepEqual(received[1].body, expected);
    assert.equal(received[0].projectHeader, "synthetic-project");
    assert.equal(received[1].projectHeader, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
