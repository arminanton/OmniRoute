import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import {
  pollVideoJobOnce,
  submitVideoJobOnce,
} from "../../open-sse/handlers/videoGeneration/job.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("async video submit makes one POST and persists only an accepted provider task id", async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({ video_id: "agnes-task-123" });
  }) as typeof fetch;

  const result = await submitVideoJobOnce({
    model: "agnes-video-v2.0",
    presetName: "agnes-video-job",
    body: { model: "agnes-video-v2.0", prompt: "private prompt", duration: 5 },
    credentials: { apiKey: "secret-provider-key" },
    deadlineAt: Date.now() + 10_000,
  });

  assert.deepEqual(result, { kind: "accepted", remoteTaskId: "agnes-task-123" });
  assert.equal(calls.length, 1, "async acceptance must not enter the synchronous poll loop");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://apihub.agnes-ai.com/v1/videos");
  assert.equal(calls[0].authorization, "Bearer secret-provider-key");
});

test("ambiguous POST failures are not safe to replay, while explicit provider 4xx is rejected", async () => {
  globalThis.fetch = (async () =>
    new Response("temporarily unavailable", { status: 503 })) as typeof fetch;
  const ambiguous = await submitVideoJobOnce({
    model: "agnes-video-v2.0",
    presetName: "agnes-video-job",
    body: { prompt: "x" },
    credentials: { apiKey: "key" },
    deadlineAt: Date.now() + 10_000,
  });
  assert.deepEqual(ambiguous, { kind: "unknown", errorCode: "submit_http_503" });

  globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  const rejected = await submitVideoJobOnce({
    model: "agnes-video-v2.0",
    presetName: "agnes-video-job",
    body: { prompt: "x" },
    credentials: { apiKey: "key" },
    deadlineAt: Date.now() + 10_000,
  });
  assert.deepEqual(rejected, { kind: "rejected", status: 429, errorCode: "provider_http_429" });
});

test("a single safe task poll classifies pending, transient 429, and completed result URLs", async () => {
  const responses = [
    Response.json({ status: "running" }),
    new Response("rate limited", { status: 429 }),
    Response.json({
      status: "completed",
      metadata: { url: "https://platform-outputs.agnes-ai.space/video.mp4?sig=secret" },
    }),
  ];
  const methods: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    const response = responses.shift();
    if (!response) throw new Error("unexpected extra provider request");
    return response;
  }) as typeof fetch;
  const baseInput = {
    model: "agnes-video-v2.0",
    presetName: "agnes-video-job",
    remoteTaskId: "agnes-task-123",
    credentials: { apiKey: "key" },
  };

  assert.deepEqual(await pollVideoJobOnce(baseInput), { kind: "pending" });
  assert.deepEqual(await pollVideoJobOnce(baseInput), {
    kind: "retry",
    errorCode: "provider_poll_http_429",
  });
  assert.deepEqual(await pollVideoJobOnce(baseInput), {
    kind: "completed",
    resultUrl: "https://platform-outputs.agnes-ai.space/video.mp4?sig=secret",
  });
  assert.deepEqual(methods, ["GET", "GET", "GET"]);
});
