import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-dashscope-video-deadline-"));

const { handleDashscopeVideoGeneration } =
  await import("../../open-sse/handlers/videoGeneration/dashscopeHandler.ts");

const providerConfig = { baseUrl: "https://dashscope.example/api/v1" };

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function request(body: Record<string, unknown>) {
  return handleDashscopeVideoGeneration({
    model: "test-video-model",
    provider: "dashscope",
    providerConfig,
    body: { prompt: "A slow aerial shot", ...body },
    credentials: { apiKey: "dashscope-test-key" },
    log: null,
  });
}

test("DashScope generation bounds a hung create and marks acceptance ambiguity terminal", async () => {
  const originalFetch = globalThis.fetch;
  let createSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) =>
    new Promise<Response>((_resolve, reject) => {
      createSignal = init.signal as AbortSignal;
      assert.ok(createSignal, "create receives the server-owned absolute-deadline signal");
      createSignal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted", "AbortError")),
        { once: true }
      );
    });

  try {
    const result = await request({ timeout_ms: 25, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(result.terminal, true);
    assert.match(result.error, /task submission timed out/i);
    assert.equal(createSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DashScope create HTTP 408 without a task id is terminal to combo replay", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse({ message: "request timed out" }, 408);
  };

  try {
    const result = await request({ timeout_ms: 1_000, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    assert.equal(result.status, 408);
    assert.equal(result.terminal, true);
    assert.equal(calls, 1, "an ambiguous create timeout must not replay on another combo target");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DashScope generation bounds a hung poll after acceptance without resubmitting", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let pollSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    calls++;
    if (calls === 1) return jsonResponse({ output: { task_id: "accepted-task" } });

    pollSignal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      assert.ok(pollSignal, "poll receives the same server-owned deadline signal");
      pollSignal.addEventListener(
        "abort",
        () => reject(new DOMException("The operation was aborted", "AbortError")),
        { once: true }
      );
    });
  };

  try {
    const result = await request({ timeout_ms: 40, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(result.terminal, true);
    assert.equal(calls, 2, "an accepted remote generation is never submitted a second time");
    assert.equal(pollSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DashScope task deadline includes poll sleeps", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse({ output: { task_id: "sleep-deadline-task" } });
  };

  try {
    const result = await request({ timeout_ms: 25, poll_interval_ms: 1_000 });
    assert.equal(result.success, false);
    assert.equal(result.status, 504);
    assert.equal(result.terminal, true);
    assert.equal(calls, 1, "the handler must not poll after the deadline expires during sleep");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DashScope poll HTTP errors are terminal after task acceptance", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return jsonResponse({ output: { task_id: "poll-error-task" } });
    return jsonResponse({ message: "temporary polling error" }, 429);
  };

  try {
    const result = await request({ timeout_ms: 1_000, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    assert.equal(result.status, 429);
    assert.equal(result.terminal, true);
    assert.match(result.error, /temporary polling error/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DashScope success regression returns the accepted MP4 URL", async () => {
  const originalFetch = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    seen.push(target);
    if (target.endsWith("/video-synthesis")) {
      return jsonResponse({ output: { task_id: "successful-task" } });
    }
    if (target.endsWith("/tasks/successful-task")) {
      return jsonResponse({
        output: { task_status: "SUCCEEDED", video_url: "https://cdn.example/video.mp4" },
      });
    }
    throw new Error(`Unexpected URL: ${target}`);
  };

  try {
    const result = await request({ timeout_ms: 1_000, poll_interval_ms: 1 });
    assert.equal(result.success, true);
    assert.deepEqual(result.data.data, [{ url: "https://cdn.example/video.mp4", format: "mp4" }]);
    assert.equal(seen.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DashScope's explicit FAILED task status remains eligible for combo fallback", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return jsonResponse({ output: { task_id: "failed-task" } });
    return jsonResponse({ output: { task_status: "FAILED", message: "provider rejected task" } });
  };

  try {
    const result = await request({ timeout_ms: 1_000, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    assert.equal(result.status, 502);
    assert.equal("terminal" in result ? result.terminal : false, false);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
