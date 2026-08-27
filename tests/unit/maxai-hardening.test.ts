import test from "node:test";
import assert from "node:assert/strict";

import { MaxAiExecutor } from "../../open-sse/executors/maxai.ts";
import {
  __getMaxaiRefreshFailureCountForTesting,
  __resetMaxaiRefreshStateForTesting,
  MAXAI_REFRESH_FAILURES_MAX,
  maxaiAccessTokenNeedsRefresh,
  maxaiRefreshAccessToken,
  maxaiRefreshAccessTokenOnce,
} from "../../open-sse/executors/maxai/refresh.ts";
import { discoverMaxaiModels } from "../../open-sse/services/maxaiModels.ts";
import {
  MaxaiTransportError,
  runMaxaiConnectionTransport,
} from "../../open-sse/services/maxaiTransport.ts";
import { setTlsClientForTest } from "../../open-sse/utils/proxyFetch.ts";
import { MAXAI_MODELS, MAXAI_REGISTRY_MODELS } from "../../open-sse/executors/maxai/catalog.ts";
import { __setMaxaiConstantsForTest } from "../../open-sse/executors/maxai/constantsStore.ts";
import { MOCK_CONSTANTS, MOCK_DEVICE_ID, MOCK_USER_ID } from "./helpers/maxaiMockConstants.ts";

__setMaxaiConstantsForTest(MOCK_CONSTANTS);
const USER_ID = MOCK_USER_ID;

function fakeJwt(exp: number, userId?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims: Record<string, unknown> = { exp };
  if (userId) claims.subject = { user_id: userId };
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

function maxaiSseBody(full: string): string {
  return (
    `data: ${JSON.stringify({ data_key: "text", need_merge: true, text: full })}\n\n` +
    "data: [DONE]\n\n"
  );
}

const TOOL_CRED = {
  providerSpecificData: {
    maxaiAccessToken: "acc.tok.en",
    maxaiDeviceId: "dev-1",
    maxaiUserId: USER_ID,
  },
  accessToken: "acc.tok.en",
};

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

test("maxaiAccessTokenNeedsRefresh separates near-expiry and fresh tokens", () => {
  const now = () => 1_000_000_000_000;
  const nowSec = 1_000_000_000;
  assert.equal(maxaiAccessTokenNeedsRefresh("", 3600, now), true);
  assert.equal(maxaiAccessTokenNeedsRefresh("not-a-jwt", 3600, now), true);
  assert.equal(maxaiAccessTokenNeedsRefresh(fakeJwt(nowSec + 1800), 3600, now), true);
  assert.equal(maxaiAccessTokenNeedsRefresh(fakeJwt(nowSec + 5 * 3600), 3600, now), false);
});

test("MaxAI refresh failures cool down per connection instead of retrying every request", async () => {
  __resetMaxaiRefreshStateForTesting();
  let nowMs = 1_000_000;
  let refreshCalls = 0;
  const run = async () => {
    refreshCalls += 1;
    return { ok: false as const, status: 418, error: "profile rejected" };
  };
  const input = {
    refreshToken: "refresh-token",
    deviceId: MOCK_DEVICE_ID,
    userId: USER_ID,
  };

  const first = await maxaiRefreshAccessTokenOnce("connection-1", input, {
    run,
    now: () => nowMs,
    failureCooldownMs: 5_000,
  });
  const second = await maxaiRefreshAccessTokenOnce("connection-1", input, {
    run,
    now: () => nowMs,
    failureCooldownMs: 5_000,
  });
  assert.equal(first.status, 418);
  assert.equal(second.status, 418);
  assert.equal(refreshCalls, 1);

  nowMs += 5_001;
  await maxaiRefreshAccessTokenOnce("connection-1", input, {
    run,
    now: () => nowMs,
    failureCooldownMs: 5_000,
  });
  assert.equal(refreshCalls, 2);
  __resetMaxaiRefreshStateForTesting();
});

test("MaxAI refresh singleflight isolates caller aborts and token generations", async () => {
  __resetMaxaiRefreshStateForTesting();
  const firstCaller = new AbortController();
  let finishShared!: (result: { ok: true; status: 200; accessToken: string }) => void;
  let calls = 0;
  let sharedSignal: AbortSignal | null | undefined;
  const run = async (input: { signal?: AbortSignal | null }) => {
    calls += 1;
    sharedSignal = input.signal;
    return new Promise<{ ok: true; status: 200; accessToken: string }>((resolve) => {
      finishShared = resolve;
    });
  };
  const base = { refreshToken: "generation-one", deviceId: MOCK_DEVICE_ID, userId: USER_ID };

  const first = maxaiRefreshAccessTokenOnce(
    "connection-singleflight",
    { ...base, signal: firstCaller.signal },
    { run, timeoutMs: 10_000 }
  );
  const second = maxaiRefreshAccessTokenOnce("connection-singleflight", base, {
    run,
    timeoutMs: 10_000,
  });
  const third = maxaiRefreshAccessTokenOnce("connection-singleflight", base, {
    run,
    timeoutMs: 10_000,
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.notEqual(sharedSignal, firstCaller.signal);
  firstCaller.abort();
  assert.deepEqual(await first, { ok: false, status: 0, error: "refresh wait aborted" });
  assert.equal(sharedSignal?.aborted, false);

  finishShared({ ok: true, status: 200, accessToken: "minted" });
  assert.equal((await second).accessToken, "minted");
  assert.equal((await third).accessToken, "minted");

  const rotated = await maxaiRefreshAccessTokenOnce(
    "connection-singleflight",
    { ...base, refreshToken: "generation-two" },
    {
      run: async () => {
        calls += 1;
        return { ok: true, status: 200, accessToken: "rotated-generation" };
      },
    }
  );
  assert.equal(rotated.accessToken, "rotated-generation");
  assert.equal(calls, 2);

  const failedGeneration = await maxaiRefreshAccessTokenOnce(
    "connection-singleflight",
    { ...base, refreshToken: "failed-generation" },
    {
      run: async () => {
        calls += 1;
        return { ok: false, status: 418, error: "generation rejected" };
      },
    }
  );
  assert.equal(failedGeneration.status, 418);
  const replacementGeneration = await maxaiRefreshAccessTokenOnce(
    "connection-singleflight",
    { ...base, refreshToken: "replacement-after-failure" },
    {
      run: async () => {
        calls += 1;
        return { ok: true, status: 200, accessToken: "replacement-minted" };
      },
    }
  );
  assert.equal(replacementGeneration.accessToken, "replacement-minted");
  assert.equal(calls, 4);
  __resetMaxaiRefreshStateForTesting();
});

test("MaxAI refresh does not start for an already aborted caller", async () => {
  __resetMaxaiRefreshStateForTesting();
  const caller = new AbortController();
  caller.abort();
  let calls = 0;

  const result = await maxaiRefreshAccessTokenOnce(
    "connection-pre-aborted",
    {
      refreshToken: "pre-aborted-generation",
      deviceId: MOCK_DEVICE_ID,
      userId: USER_ID,
      signal: caller.signal,
    },
    {
      run: async () => {
        calls += 1;
        return { ok: true, status: 200, accessToken: "must-not-mint" };
      },
    }
  );

  assert.deepEqual(result, { ok: false, status: 0, error: "refresh wait aborted" });
  assert.equal(calls, 0);
  __resetMaxaiRefreshStateForTesting();
});

test("MaxAI refresh singleflight cleans up when an injected run throws", async () => {
  __resetMaxaiRefreshStateForTesting();
  const input = { refreshToken: "throwing-generation", deviceId: MOCK_DEVICE_ID, userId: USER_ID };
  await assert.rejects(
    maxaiRefreshAccessTokenOnce("connection-throw", input, {
      run: async () => {
        throw new Error("refresh exploded");
      },
    }),
    /refresh exploded/
  );
  const recovered = await maxaiRefreshAccessTokenOnce("connection-throw", input, {
    run: async () => ({ ok: true, status: 200, accessToken: "after-throw" }),
  });
  assert.equal(recovered.accessToken, "after-throw");
  __resetMaxaiRefreshStateForTesting();
});

test("MaxAI refresh timeout settles when the runner ignores abort and releases the lane", async () => {
  __resetMaxaiRefreshStateForTesting();
  let calls = 0;
  let rejectLate!: (error: Error) => void;
  let sharedSignal: AbortSignal | null | undefined;
  const input = { refreshToken: "stuck-generation", deviceId: MOCK_DEVICE_ID, userId: USER_ID };
  const startedAt = Date.now();

  const timedOut = await Promise.race([
    maxaiRefreshAccessTokenOnce("connection-stuck", input, {
      timeoutMs: 20,
      run: async (runInput) => {
        calls += 1;
        sharedSignal = runInput.signal;
        return new Promise((_resolve, reject) => {
          rejectLate = reject;
        });
      },
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("refresh timeout did not settle")), 500)
    ),
  ]);

  assert.deepEqual(timedOut, { ok: false, status: 0, error: "refresh timed out" });
  assert.ok(Date.now() - startedAt >= 15);
  assert.equal(sharedSignal?.aborted, true);
  const recovered = await maxaiRefreshAccessTokenOnce("connection-stuck", input, {
    run: async () => {
      calls += 1;
      return { ok: true, status: 200, accessToken: "after-timeout" };
    },
  });
  assert.equal(recovered.accessToken, "after-timeout");
  assert.equal(calls, 2);

  rejectLate(new Error("detached late rejection"));
  await new Promise((resolve) => setImmediate(resolve));
  __resetMaxaiRefreshStateForTesting();
});

test("MaxAI refresh coordinator prunes every expired failure on entry", async () => {
  __resetMaxaiRefreshStateForTesting();
  let nowMs = 10_000;
  const fail = async () => ({ ok: false as const, status: 418, error: "rejected" });
  const input = { deviceId: MOCK_DEVICE_ID, userId: USER_ID };

  for (const refreshToken of ["expired-one", "expired-two", "still-live"]) {
    await maxaiRefreshAccessTokenOnce(
      "connection-prune",
      { ...input, refreshToken },
      {
        run: fail,
        now: () => nowMs,
        failureCooldownMs: refreshToken === "still-live" ? 1_000 : 10,
      }
    );
  }
  assert.equal(__getMaxaiRefreshFailureCountForTesting(), 3);

  nowMs += 11;
  await maxaiRefreshAccessTokenOnce(
    "connection-prune",
    { ...input, refreshToken: "successful-entry" },
    {
      run: async () => ({ ok: true, status: 200, accessToken: "minted" }),
      now: () => nowMs,
    }
  );
  assert.equal(__getMaxaiRefreshFailureCountForTesting(), 1);
  __resetMaxaiRefreshStateForTesting();
});

test("MaxAI refresh failure cache evicts the generation with the oldest expiry", async () => {
  __resetMaxaiRefreshStateForTesting();
  const nowMs = 20_000;
  let calls = 0;
  const input = { deviceId: MOCK_DEVICE_ID, userId: USER_ID };
  const fail = async () => {
    calls += 1;
    return { ok: false as const, status: 418, error: "rejected" };
  };

  for (let index = 0; index < MAXAI_REFRESH_FAILURES_MAX + 2; index += 1) {
    await maxaiRefreshAccessTokenOnce(
      "connection-limit",
      { ...input, refreshToken: `generation-${index}` },
      { run: fail, now: () => nowMs, failureCooldownMs: 1_000 + index }
    );
  }
  assert.equal(__getMaxaiRefreshFailureCountForTesting(), MAXAI_REFRESH_FAILURES_MAX);
  const populatedCalls = calls;

  await maxaiRefreshAccessTokenOnce(
    "connection-limit",
    { ...input, refreshToken: `generation-${MAXAI_REFRESH_FAILURES_MAX + 1}` },
    { run: fail, now: () => nowMs, failureCooldownMs: 10_000 }
  );
  assert.equal(calls, populatedCalls);
  await maxaiRefreshAccessTokenOnce(
    "connection-limit",
    { ...input, refreshToken: "generation-0" },
    { run: fail, now: () => nowMs, failureCooldownMs: 10_000 }
  );
  assert.equal(calls, populatedCalls + 1);
  assert.equal(__getMaxaiRefreshFailureCountForTesting(), MAXAI_REFRESH_FAILURES_MAX);
  __resetMaxaiRefreshStateForTesting();
});

test("maxaiRefreshAccessToken accepts camelCase tokens and preserves a rotated refresh token", async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const oldRefresh = fakeJwt(nowSec + 1000, USER_ID);
  const newAccess = fakeJwt(nowSec + 3600, USER_ID);
  const newRefresh = fakeJwt(nowSec + 2000, USER_ID);
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ data: { accessToken: newAccess, refreshToken: newRefresh } }), {
      status: 200,
    })) as unknown as typeof fetch;

  const result = await maxaiRefreshAccessToken({
    refreshToken: oldRefresh,
    deviceId: MOCK_DEVICE_ID,
    fetchImpl: fakeFetch,
  });
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, newAccess);
  assert.equal(result.refreshToken, newRefresh);
});

test("maxaiRefreshAccessToken refuses incomplete refresh credentials", async () => {
  const result = await maxaiRefreshAccessToken({ refreshToken: "", deviceId: "" });
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
});

test("executor fails closed when a requested document upload fails", async () => {
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    urls.push(String(url));
    if (String(url).endsWith("/app/upload_document")) {
      return new Response("upload failed", { status: 500 });
    }
    return new Response(maxaiSseBody("I did not receive a document."), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const result = await new MaxAiExecutor().execute({
      model: "gpt-5.6-luna",
      stream: false,
      credentials: TOOL_CRED,
      body: {
        model: "gpt-5.6-luna",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize this file." },
              {
                type: "file",
                file: {
                  filename: "note.txt",
                  file_data: "data:text/plain;base64,aGVsbG8=",
                },
              },
            ],
          },
        ],
      },
    } as unknown as Parameters<MaxAiExecutor["execute"]>[0]);
    const response = "response" in result ? result.response : (result as Response);
    assert.equal(response.status, 502);
    const json = await response.json();
    assert.equal(json.error?.code, "maxai_document_upload_failed");
    assert.equal(urls.filter((url) => url.endsWith("/gpt/cwc/chat")).length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("executor rejects malformed document input instead of sending text-only chat", async () => {
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("must not fetch");
  }) as unknown as typeof fetch;
  try {
    const result = await new MaxAiExecutor().execute({
      model: "gpt-5.6-luna",
      stream: false,
      credentials: TOOL_CRED,
      body: {
        model: "gpt-5.6-luna",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Summarize the attached file." },
              { type: "input_file", file_id: "already-uploaded" },
            ],
          },
        ],
      },
    } as unknown as Parameters<MaxAiExecutor["execute"]>[0]);
    const response = "response" in result ? result.response : (result as Response);
    assert.equal(response.status, 400);
    const json = await response.json();
    assert.equal(json.error?.code, "maxai_invalid_document");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("executor preserves current-turn images during the bounded tool retry", async () => {
  const realFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let call = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    call += 1;
    const text =
      call === 1
        ? "I can use get_weather through a <tool> block. Let me do that."
        : '<tool>{"name":"get_weather","arguments":{"city":"Paris"}}</tool>';
    return new Response(maxaiSseBody(text), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const result = await new MaxAiExecutor().execute({
      model: "gpt-5.6-luna",
      stream: false,
      credentials: TOOL_CRED,
      body: {
        model: "gpt-5.6-luna",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Use the image and weather tool." },
              { type: "image_url", image_url: { url: "data:image/png;base64,aW1n" } },
            ],
          },
        ],
        tools: [WEATHER_TOOL],
      },
    } as unknown as Parameters<MaxAiExecutor["execute"]>[0]);
    const response = "response" in result ? result.response : (result as Response);
    assert.equal(response.status, 200);
    assert.equal(bodies.length, 2);
    for (const body of bodies) {
      const content = body.message_content as Array<{ type?: string }>;
      assert.ok(content.some((part) => part.type === "image_url"));
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("cancelling the OpenAI-facing MaxAI stream cancels its upstream reader", async () => {
  const realFetch = globalThis.fetch;
  let upstreamCancelReason: unknown;
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ data_key: "text", need_merge: true, text: "partial response that is long enough to emit" })}\n\n`
        )
      );
    },
    cancel(reason) {
      upstreamCancelReason = reason;
    },
  });
  globalThis.fetch = (async () =>
    new Response(upstream, { status: 200 })) as unknown as typeof fetch;
  try {
    const result = await new MaxAiExecutor().execute({
      model: "gpt-5.6-luna",
      stream: true,
      credentials: TOOL_CRED,
      body: { messages: [{ role: "user", content: "start streaming" }] },
    } as unknown as Parameters<MaxAiExecutor["execute"]>[0]);
    const response = "response" in result ? result.response : (result as Response);
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await reader.cancel("client disconnected");
    assert.equal(upstreamCancelReason, "client disconnected");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("discoverMaxaiModels sends the captured web-client request body", async () => {
  let requestBody = "";
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        data: {
          chat_models: [{ model_name: "gpt-5.6-luna", type: "chat", max_tokens: 1_050_000 }],
        },
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;

  await discoverMaxaiModels({
    providerSpecificData: TOOL_CRED.providerSpecificData,
    accessToken: TOOL_CRED.accessToken,
    fetchImpl: fakeFetch,
  });
  assert.equal(requestBody, JSON.stringify({ language: "en", client_type: "web" }));
});

test("MaxAI requires Windows Firefox 150 even when TLS feature flags are unset", async (t) => {
  const priorEnabled = process.env.ENABLE_TLS_FINGERPRINT;
  const priorProviders = process.env.TLS_FINGERPRINT_PROVIDERS;
  delete process.env.ENABLE_TLS_FINGERPRINT;
  delete process.env.TLS_FINGERPRINT_PROVIDERS;
  let operationCalls = 0;
  setTlsClientForTest({
    available: false,
    fetch: async () => {
      throw new Error("unreachable");
    },
  });
  t.after(() => {
    setTlsClientForTest(null);
    if (priorEnabled === undefined) delete process.env.ENABLE_TLS_FINGERPRINT;
    else process.env.ENABLE_TLS_FINGERPRINT = priorEnabled;
    if (priorProviders === undefined) delete process.env.TLS_FINGERPRINT_PROVIDERS;
    else process.env.TLS_FINGERPRINT_PROVIDERS = priorProviders;
  });

  await assert.rejects(
    runMaxaiConnectionTransport(
      "connection-1",
      async () => {
        operationCalls += 1;
        return "unexpected";
      },
      { resolveProxy: async () => null }
    ),
    (error: unknown) => error instanceof MaxaiTransportError && error.status === 503
  );
  assert.equal(operationCalls, 0);
});

test("every shipped MaxAI model retains prompted tool support", () => {
  assert.deepEqual(
    MAXAI_REGISTRY_MODELS.map((model) => model.id),
    MAXAI_MODELS.map((model) => model.id)
  );
  assert.ok(MAXAI_REGISTRY_MODELS.every((model) => model.toolCalling === true));
});
