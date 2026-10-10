import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-video-xai-"));

const { handleVideoGeneration } = await import("../../open-sse/handlers/videoGeneration.ts");
const { VIDEO_PROVIDERS } = await import("../../open-sse/config/videoRegistry.ts");
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);

// Makes poll-interval waits resolve instantly so tests don't sleep.
function immediateTimeout(callback, _ms, ...args) {
  // Preserve real server-deadline timers. The old tests used this shim before
  // the handler had a deadline timer, so firing every timer immediately would
  // now make all successful async jobs time out before their first poll.
  if (Number(_ms) > 4000) return nativeSetTimeout(callback, _ms, ...args);
  if (typeof callback === "function") callback(...args);
  return 0;
}

const CREATE_URL = "https://api.x.ai/v1/videos/generations";
const POLL_URL_PREFIX = "https://api.x.ai/v1/videos/";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("VIDEO_PROVIDERS exposes the xai grok-imagine-video entry", () => {
  assert.ok(VIDEO_PROVIDERS.xai, "xai video provider is registered");
  assert.equal(VIDEO_PROVIDERS.xai.format, "xai-video");
  assert.ok(
    VIDEO_PROVIDERS.xai.models.some((m) => m.id === "grok-imagine-video"),
    "grok-imagine-video is listed"
  );
});

test("handleVideoGeneration creates + polls an xAI Grok Imagine video job and returns mp4 URL", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let createRequest;
  let pollRequestCount = 0;

  globalThis.setTimeout = immediateTimeout;
  globalThis.fetch = async (url, options = {}) => {
    const stringUrl = String(url);

    if (stringUrl === CREATE_URL) {
      createRequest = {
        url: stringUrl,
        headers: options.headers,
        body: JSON.parse(String(options.body || "{}")),
      };
      return jsonResponse({ request_id: "xai-req-1", status: "pending" });
    }

    if (stringUrl === `${POLL_URL_PREFIX}xai-req-1`) {
      pollRequestCount += 1;
      if (pollRequestCount === 1) {
        return jsonResponse({ request_id: "xai-req-1", status: "processing", progress: 40 });
      }
      return jsonResponse({
        request_id: "xai-req-1",
        status: "done",
        progress: 100,
        video: { url: "https://videos.x.ai/xai-req-1.mp4" },
      });
    }

    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  try {
    const result = await handleVideoGeneration({
      body: {
        model: "xai/grok-imagine-video",
        prompt: "a cinematic tracking shot through a neon city at night",
        duration: 6,
      },
      credentials: { apiKey: "xai-key" },
      log: null,
    });

    // Create request shape
    assert.equal(createRequest.headers["Authorization"], "Bearer xai-key");
    assert.equal(createRequest.body.model, "grok-imagine-video");
    assert.equal(
      createRequest.body.prompt,
      "a cinematic tracking shot through a neon city at night"
    );
    assert.equal(createRequest.body.duration, 6);

    // Polled at least once past "processing" before terminal "done"
    assert.ok(pollRequestCount >= 2);

    // Response shape
    assert.equal(result.success, true);
    assert.equal(result.data.data[0].url, "https://videos.x.ai/xai-req-1.mp4");
    assert.equal(result.data.data[0].format, "mp4");
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("handleVideoGeneration rejects xAI video requests without credentials", async () => {
  const result = await handleVideoGeneration({
    body: { model: "xai/grok-imagine-video", prompt: "x" },
    credentials: null,
    log: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 401);
  assert.match(result.error, /xAI API key is required/);
});

test("handleVideoGeneration surfaces a 502 when xAI returns no request_id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ error: { message: "Invalid API key" } }, 401);

  try {
    const result = await handleVideoGeneration({
      body: { model: "xai/grok-imagine-video", prompt: "x" },
      credentials: { apiKey: "bad-key" },
      log: null,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 502);
    assert.equal(result.error, "Invalid API key");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleVideoGeneration returns 502 when the xAI job status is failed", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = immediateTimeout;

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    if (stringUrl === CREATE_URL) {
      return jsonResponse({ request_id: "xai-fail", status: "pending" });
    }
    if (stringUrl === `${POLL_URL_PREFIX}xai-fail`) {
      return jsonResponse({
        request_id: "xai-fail",
        status: "failed",
        error: "content policy violation",
      });
    }
    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  try {
    const result = await handleVideoGeneration({
      body: { model: "xai/grok-imagine-video", prompt: "x" },
      credentials: { apiKey: "xai-key" },
      log: null,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 502);
    assert.equal(result.error, "content policy violation");
    assert.equal(
      result.terminal,
      undefined,
      "a confirmed failed task may try the next combo target"
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("handleVideoGeneration returns 504 when the xAI job never completes", async () => {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalNow = Date.now;
  globalThis.setTimeout = immediateTimeout;

  let nowCalls = 0;
  Date.now = () => {
    nowCalls += 1;
    return nowCalls === 1 ? 1000 : nowCalls === 2 ? 2000 : 1_000_000;
  };

  globalThis.fetch = async (url) => {
    const stringUrl = String(url);
    if (stringUrl === CREATE_URL) {
      return jsonResponse({ request_id: "xai-stuck", status: "pending" });
    }
    if (stringUrl === `${POLL_URL_PREFIX}xai-stuck`) {
      return jsonResponse({ request_id: "xai-stuck", status: "processing", progress: 10 });
    }
    throw new Error(`Unexpected URL: ${stringUrl}`);
  };

  try {
    const result = await handleVideoGeneration({
      body: {
        model: "xai/grok-imagine-video",
        prompt: "x",
        timeout_ms: 5000,
        poll_interval_ms: 100,
      },
      credentials: { apiKey: "xai-key" },
      log: null,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(result.terminal, true, "an accepted task timeout must not create a duplicate job");
    assert.match(result.error, /timed out/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalNow;
  }
});

test("xAI submit hangs are aborted at the server deadline and marked terminal", async () => {
  const originalFetch = globalThis.fetch;
  let submitSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) =>
    new Promise<Response>((_resolve, reject) => {
      submitSignal = init.signal as AbortSignal;
      assert.ok(submitSignal, "xAI submit receives the server-owned deadline signal");
      submitSignal.addEventListener("abort", () => reject(submitSignal!.reason), { once: true });
    });

  try {
    const result = await handleVideoGeneration({
      body: { model: "xai/grok-imagine-video", prompt: "x", timeout_ms: 25 },
      credentials: { apiKey: "xai-key" },
      log: null,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(result.terminal, true, "submit acceptance is ambiguous after dispatch");
    assert.equal(submitSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("xAI poll hangs are aborted at the same deadline and do not recreate accepted work", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let pollSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    calls += 1;
    if (calls === 1) return jsonResponse({ request_id: "accepted-xai-task", status: "pending" });

    pollSignal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      assert.ok(pollSignal, "xAI poll uses the same server-owned deadline signal");
      pollSignal.addEventListener("abort", () => reject(pollSignal!.reason), { once: true });
    });
  };

  try {
    const result = await handleVideoGeneration({
      body: {
        model: "xai/grok-imagine-video",
        prompt: "x",
        timeout_ms: 60,
        poll_interval_ms: 1,
      },
      credentials: { apiKey: "xai-key" },
      log: null,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(result.terminal, true);
    assert.equal(calls, 2, "the accepted task is polled once and never submitted again");
    assert.equal(pollSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("xAI accepted-task poll HTTP errors are terminal to video combo fallback", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ request_id: "accepted-xai-task" });
    return jsonResponse({ error: { message: "rate limited while checking task" } }, 429);
  };

  try {
    const result = await handleVideoGeneration({
      body: { model: "xai/grok-imagine-video", prompt: "x", poll_interval_ms: 1 },
      credentials: { apiKey: "xai-key" },
      log: null,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 429);
    assert.equal(result.terminal, true);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleVideoGeneration never leaks a stack trace in xAI video error responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:443\n    at TCPConnectWrap.afterConnect");
  };

  try {
    const result = await handleVideoGeneration({
      body: { model: "xai/grok-imagine-video", prompt: "x" },
      credentials: { apiKey: "xai-key" },
      log: null,
    });

    assert.equal(result.success, false);
    assert.ok(!String(result.error).includes("at TCPConnectWrap"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
