import test from "node:test";
import assert from "node:assert/strict";

import { handleVideoJobGeneration } from "../../open-sse/handlers/videoGeneration/job.ts";

const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalDateNow = Date.now;

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function runJob(options: Partial<Parameters<typeof handleVideoJobGeneration>[0]> = {}) {
  return handleVideoJobGeneration({
    model: "test-video",
    presetName: "agnes-video-job",
    body: { prompt: "a test video" },
    credentials: { apiKey: "test-key", baseUrl: "https://video.example" },
    ...options,
  });
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  Date.now = originalDateNow;
});

test("job preset does not dispatch after caller has already cancelled", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return response({ video_id: "unexpected" });
  }) as typeof fetch;

  const result = await runJob({ callerSignal: controller.signal });

  assert.equal(calls, 0);
  assert.equal(result.success, false);
  assert.equal(result.status, 499);
});

test("ambiguous submit transport failure is terminal and never polls", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new TypeError("socket closed after submit");
  }) as typeof fetch;

  const result = await runJob();

  assert.equal(calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.equal(result.terminal, true);
});

test("deadline covers submit response body parsing and marks possible acceptance terminal", async () => {
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  const result = await runJob({ timeoutMs: 25 });

  assert.equal(calls, 1);
  assert.equal(result.success, false);
  assert.equal(result.status, 504);
  assert.equal(result.terminal, true);
});

test("absolute deadline bounds polling waits", async () => {
  let calls = 0;
  globalThis.fetch = (async (url: unknown) => {
    calls += 1;
    if (String(url).endsWith("/v1/videos")) return response({ video_id: "accepted-job" });
    return response({ status: "processing" });
  }) as typeof fetch;

  const result = await runJob({ timeoutMs: 1, pollIntervalMs: 10_000, maxPolls: 10 });

  assert.equal(calls, 1, "the deadline expires during the bounded wait before the first poll");
  assert.equal(result.success, false);
  assert.equal(result.status, 504);
  assert.equal(result.terminal, true);
});

test("request timeout is capped at fifteen minutes", async () => {
  let currentTime = 1_000;
  Date.now = () => currentTime;
  let polls = 0;
  let calls = 0;
  let submittedBody: unknown;

  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls += 1;
    if (String(url).endsWith("/v1/videos")) {
      submittedBody = JSON.parse(String(init?.body));
      return response({ video_id: "accepted-job" });
    }
    polls += 1;
    if (polls === 1) {
      currentTime += 16 * 60_000;
      return response({ status: "processing" });
    }
    return response({ status: "completed", metadata: { url: "https://video.example/out.mp4" } });
  }) as typeof fetch;

  const result = await runJob({
    body: {
      prompt: "a test video",
      timeout_ms: 60 * 60_000,
      poll_interval_ms: 1,
    },
    maxPolls: 2,
  });

  assert.equal(calls, 2, "the one-hour override is clamped before the second poll");
  assert.deepEqual(submittedBody, { model: "test-video", prompt: "a test video" });
  assert.equal(result.success, false);
  assert.equal(result.status, 504);
  assert.equal(result.terminal, true);
});

test("caller cancellation after acceptance keeps polling, then returns terminal 499", async () => {
  const controller = new AbortController();
  const pollSignals: AbortSignal[] = [];
  let calls = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls += 1;
    if (String(url).endsWith("/v1/videos")) return response({ video_id: "accepted-job" });
    pollSignals.push(init?.signal as AbortSignal);
    if (pollSignals.length === 1) {
      controller.abort();
      return response({ status: "processing" });
    }
    return response({ status: "completed", metadata: { url: "https://video.example/out.mp4" } });
  }) as typeof fetch;

  const result = await runJob({ callerSignal: controller.signal, pollIntervalMs: 0 });

  assert.equal(calls, 3, "the accepted task is observed through a terminal provider status");
  assert.equal(pollSignals.length, 2);
  assert.equal(
    pollSignals[1].aborted,
    false,
    "caller disconnect is not forwarded to accepted polling"
  );
  assert.equal(result.success, false);
  assert.equal(result.status, 499);
  assert.equal(result.terminal, true);
});

test("confirmed provider task failure remains eligible for fallback", async () => {
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith("/v1/videos")) return response({ video_id: "failed-job" });
    return response({ status: "failed" });
  }) as typeof fetch;

  const result = await runJob({ pollIntervalMs: 0 });

  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.equal(result.terminal, undefined);
});

test("post-acceptance poll transport failures are terminal", async () => {
  let calls = 0;
  globalThis.fetch = (async (url: unknown) => {
    calls += 1;
    if (String(url).endsWith("/v1/videos")) return response({ video_id: "accepted-job" });
    throw new TypeError("poll socket closed");
  }) as typeof fetch;

  const result = await runJob({ pollIntervalMs: 0 });

  assert.equal(calls, 2);
  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.equal(result.terminal, true);
});
