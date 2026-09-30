import test from "node:test";
import assert from "node:assert/strict";
import { MaxAiExecutor } from "../../open-sse/executors/maxai.ts";
import { __setMaxaiConstantsForTest } from "../../open-sse/executors/maxai/constantsStore.ts";
import { MOCK_CONSTANTS } from "./helpers/maxaiMockConstants.ts";

const token = `mock.${Buffer.from(JSON.stringify({ sub: "mock-user", exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url")}.signature`;
const credentials = {
  connectionId: "conn-a",
  accessToken: token,
  providerSpecificData: { maxaiDeviceId: "mock-device", maxaiUserId: "mock-user" },
};
__setMaxaiConstantsForTest(MOCK_CONSTANTS);

test("executor refuses missing connection identity before any ambient send", async () => {
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response("data: [DONE]\n\n");
  };
  try {
    const result = await new MaxAiExecutor().execute({
      model: "gpt-5.6",
      body: { messages: [{ role: "user", content: "hello" }] },
      stream: false,
      credentials: { ...credentials, connectionId: undefined },
    });
    assert.ok("response" in result);
    assert.equal(result.response.status, 503);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("SSE consumer cancellation cancels upstream reader and releases its lock", async () => {
  let cancelled = false;
  const source = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  const executor = new MaxAiExecutor() as unknown as {
    buildStream: (
      source: ReadableStream<Uint8Array>,
      id: string,
      created: number,
      model: string,
      prompt: number
    ) => ReadableStream;
  };
  const stream = executor.buildStream(source, "id", 0, "gpt-5.6", 0);
  await stream.cancel("client gone");
  await Promise.resolve();
  assert.equal(cancelled, true);
  assert.equal(source.locked, false);
});

function injectedExecutor(send: typeof fetch, fresh = token) {
  return new MaxAiExecutor({
    runTransport: async (_connectionId, fn) => fn(),
    ensureCredential: async ({ credential }) => ({ ...credential, accessToken: fresh }),
    fetchImpl: send,
  });
}

test("current chat uses minted access token and never re-persists stale snapshot", async () => {
  let auth = "";
  let persist = 0;
  const executor = injectedExecutor(async (_url, init) => {
    auth = new Headers(init?.headers).get("authorization") || "";
    assert.equal(init?.redirect, "error");
    return new Response(
      'data: {"data_key":"text","need_merge":true,"text":"hello"}\n\ndata: [DONE]\n\n'
    );
  }, "fresh-current-token");
  const result = await executor.execute({
    model: "gpt-5.6",
    body: { messages: [{ role: "user", content: "hello" }] },
    stream: false,
    credentials,
    onCredentialsRefreshed: async () => {
      persist++;
    },
  });
  assert.ok("response" in result);
  assert.equal(result.response.status, 200);
  assert.equal(auth, "Bearer fresh-current-token");
  assert.equal(persist, 0);
});

test("malformed document fails without sending text-only chat", async () => {
  let sends = 0;
  const result = await injectedExecutor(async () => {
    sends++;
    return new Response("data: [DONE]\n\n");
  }).execute({
    model: "gpt-5.6",
    stream: false,
    credentials,
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read doc" },
            { type: "input_file", filename: "a.txt", file_data: "%%%" },
          ],
        },
      ],
    },
  });
  assert.ok("response" in result);
  assert.equal(result.response.status, 400);
  assert.equal(sends, 0);
});

test("tool retry keeps original current-turn images and uploaded documents, no duplicate upload", async () => {
  const bodies: Record<string, unknown>[] = [];
  let uploads = 0;
  const executor = injectedExecutor(async (url, init) => {
    if (String(url).endsWith("/app/upload_document")) {
      uploads++;
      return new Response('data: {"event":"upload_done"}\n\n');
    }
    bodies.push(JSON.parse(String(init?.body)));
    const text =
      bodies.length === 1
        ? "Let me call get_weather now."
        : '<tool name="get_weather">{"city":"Ghent"}</tool>';
    return new Response(
      `data: ${JSON.stringify({ data_key: "text", need_merge: true, text })}\n\ndata: [DONE]\n\n`
    );
  });
  const result = await executor.execute({
    model: "gpt-5.6",
    stream: false,
    credentials,
    body: {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "read this and get weather" },
            { type: "image_url", image_url: { url: "data:image/png;base64,YQ==" } },
            { type: "input_file", filename: "a.txt", file_data: "data:text/plain;base64,YQ==" },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
    },
  });
  assert.ok("response" in result);
  assert.equal(result.response.status, 200);
  assert.equal(uploads, 1);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].doc_list, bodies[1].doc_list);
  assert.deepEqual(
    (bodies[0].message_content as unknown[]).slice(1),
    (bodies[1].message_content as unknown[]).slice(1)
  );
});

test("caller extra headers cannot replace MaxAI credentials, signer, or Firefox identity", async () => {
  let headers = new Headers();
  const result = await injectedExecutor(async (_url, init) => {
    headers = new Headers(init?.headers);
    return new Response("data: [DONE]\n\n");
  }).execute({
    model: "gpt-5.6",
    stream: false,
    credentials,
    body: { messages: [{ role: "user", content: "hello" }] },
    upstreamExtraHeaders: {
      authorization: "Bearer override",
      cookie: "credential=override",
      "x-authorization": "override",
      "user-agent": "Chrome",
      "sec-ch-ua": "Chrome",
      "proxy-authorization": "proxy-secret",
      "x-extra-safe": "ok",
    },
  });
  assert.ok("response" in result);
  assert.equal(result.response.status, 200);
  assert.equal(headers.get("authorization"), `Bearer ${token}`);
  assert.notEqual(headers.get("x-authorization"), "override");
  assert.match(headers.get("user-agent") || "", /Firefox\/150\.0/);
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("sec-ch-ua"), null);
  assert.equal(headers.get("proxy-authorization"), null);
  assert.equal(headers.get("x-extra-safe"), "ok");
});
