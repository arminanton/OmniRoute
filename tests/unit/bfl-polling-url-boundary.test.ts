import test from "node:test";
import assert from "node:assert/strict";
import { handleImageGeneration } from "../../open-sse/handlers/imageGeneration.ts";
import { executeImageWithCredentialFallback } from "../../src/sse/services/imageCredentialRetry.ts";
import { installPinnedTransport } from "../helpers/pinnedTransport.ts";

const GENERATE = "https://api.bfl.ai/v1/flux-kontext-pro";
const POLL = "https://api.bfl.ai/result/123";
const TOKEN = "test-private-bfl-key";
const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function runBfl() {
  let selections = 0;
  const execution = await executeImageWithCredentialFallback({
    provider: "black-forest-labs",
    requestedModel: "black-forest-labs/flux-kontext-pro",
    credentials: { apiKey: TOKEN, authType: "apikey", connectionId: "bfl-fake-account" },
    selectNextCredentials: async () => {
      selections++;
      return null;
    },
    execute: (credentials) =>
      handleImageGeneration({
        body: { model: "black-forest-labs/flux-kontext-pro", prompt: "test" },
        credentials,
        log: null,
      }),
  });
  return { ...execution, selections };
}

for (const pollingUrl of [
  "http://127.0.0.1/internal",
  "https://169.254.169.254/latest",
  "https://[::ffff:127.0.0.1]/",
  "https://unknown.example/v1/get_result?id=job-123",
  "https://api.bfl.ai.evil.example/v1/get_result?id=job-123",
  "https://evil.api.bfl.ai/v1/get_result?id=job-123",
  "https://api.bfl.ai:444/v1/get_result?id=job-123",
  "https://user:pass@api.bfl.ai/v1/get_result?id=job-123",
  "https://api.us1.bfl.ai/result/123",
  "https://api.eu1.bfl.ai/result/123",
  "https://api.bfl.ai/result/123#other",
  "https://api.bfl.ai/result/123#",
  "https://@api.bfl.ai/result/123",
  "https://api.bfl.ai/\\result/123",
  "https://api.bfl.ai/result/123\n",
  "/result/123",
  "ftp://api.bfl.ai/result/123",
  `https://api.bfl.ai/result/${"a".repeat(4096)}`,
]) {
  test(`BFL blocks unapproved polling URL before X-Key send: ${pollingUrl.slice(0, 100)}`, async (t) => {
    const transport = installPinnedTransport(t.mock);
    t.after(transport.restore);
    const calls: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(new Headers(init?.headers).get("x-key"), TOKEN);
      if (url === GENERATE) return Response.json({ id: "job-123", polling_url: pollingUrl });
      return Response.json({
        status: "Ready",
        result: { sample: "https://cdn.example/image.png" },
      });
    };
    const { result, selections } = await runBfl();
    assert.equal(result.success, false);
    assert.equal(result.retryable, false);
    assert.equal(selections, 0);
    assert.deepEqual(calls, [GENERATE]);
    assert.equal(transport.dials.length, 0);
  });
}

for (const location of [
  "https://unknown.example/steal",
  "http://169.254.169.254/latest",
  "/v1/credits",
]) {
  test(`BFL never follows a polling redirect or regenerates: ${location}`, async (t) => {
    const transport = installPinnedTransport(t.mock);
    t.after(transport.restore);
    const calls: string[] = [];
    let canceled = 0;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      assert.equal(init?.redirect, "manual", "provider and polling sends must not auto-follow");
      if (url === GENERATE) return Response.json({ id: "job-123", polling_url: POLL });
      if (url === POLL)
        return new Response(
          new ReadableStream({
            cancel() {
              canceled++;
            },
          }),
          {
            status: 307,
            headers: { location },
          }
        );
      throw new Error("redirect target must never receive X-Key");
    };
    const { result, selections } = await runBfl();
    assert.equal(result.success, false);
    assert.equal(result.retryable, false);
    assert.equal(selections, 0);
    assert.deepEqual(calls, [GENERATE, POLL]);
    assert.equal(canceled, 1);
    assert.equal(transport.dials.length, 0);
  });
}

test("BFL exact approved polling URL keeps X-Key and returns one generation without fallback", async (t) => {
  const transport = installPinnedTransport(t.mock);
  t.after(transport.restore);
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("x-key"), TOKEN);
    if (url === GENERATE) return Response.json({ id: "job-123", polling_url: POLL });
    assert.equal(url, POLL);
    return Response.json({ status: "Ready", result: { sample: "https://cdn.example/image.png" } });
  };
  const { result, selections } = await runBfl();
  assert.equal(result.success, true);
  assert.equal(selections, 0);
  assert.deepEqual(calls, [GENERATE, POLL]);
});

test("BFL origin gate preserves safe existing same-origin GET paths without inventing backend routes", async () => {
  const { validateBflPollingUrl } =
    await import("../../open-sse/handlers/imageGeneration/providers/bflPolling.ts");
  for (const url of [
    "https://api.bfl.ai/result/123",
    "https://api.bfl.ai:443/results/jobs/abc?state=ready",
    "https://api.bfl.ai/opaque/result-token?param=x&param=y",
    "https://API.BFL.AI/path",
  ])
    assert.equal(validateBflPollingUrl(url).origin, "https://api.bfl.ai");
});

for (const stage of ["submit", "poll"] as const) {
  test(`BFL ${stage} redirect cannot leak X-Key through real Undici HTTP dispatch`, async (t) => {
    const { MockAgent, fetch: httpFetch, Headers: HttpHeaders } = await import("undici");
    const http = new MockAgent();
    http.disableNetConnect();
    t.after(async () => {
      await http.close();
    });
    let sentToOtherOrigin = 0;
    let sendsToBfl = 0;
    http
      .get("https://api.bfl.ai")
      .intercept({ path: "/v1/flux-kontext-pro", method: "POST" })
      .reply((options) => {
        sendsToBfl++;
        assert.equal(new HttpHeaders(options.headers).get("x-key"), TOKEN);
        return stage === "submit"
          ? {
              statusCode: 307,
              data: "",
              responseOptions: { headers: { location: "https://evil.example/steal" } },
            }
          : {
              statusCode: 200,
              data: JSON.stringify({ polling_url: POLL }),
              responseOptions: { headers: { "content-type": "application/json" } },
            };
      });
    if (stage === "poll") {
      http
        .get("https://api.bfl.ai")
        .intercept({ path: "/result/123", method: "GET" })
        .reply((options) => {
          sendsToBfl++;
          assert.equal(new HttpHeaders(options.headers).get("x-key"), TOKEN);
          return {
            statusCode: 307,
            data: "",
            responseOptions: { headers: { location: "https://evil.example/steal" } },
          };
        });
    }
    http
      .get("https://evil.example")
      .intercept({ path: "/steal", method: stage === "submit" ? "POST" : "GET" })
      .reply(() => {
        sentToOtherOrigin++;
        return { statusCode: 200, data: "{}" };
      });
    // No mocked top-level response: real fetch runs its redirect and header machinery
    // and dispatches into the no-network HTTP transport above.
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      (await httpFetch(input as string | URL, {
        ...(init as Parameters<typeof httpFetch>[1]),
        dispatcher: http,
      })) as unknown as Response;
    const { result, selections } = await runBfl();
    assert.equal(result.success, false);
    assert.equal(result.retryable, false);
    assert.equal(selections, 0);
    assert.equal(sendsToBfl, stage === "submit" ? 1 : 2);
    assert.equal(sentToOtherOrigin, 0);
  });
}
