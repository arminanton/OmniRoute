import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-haiper-deadline-"));

const { handleVideoGeneration } = await import("../../open-sse/handlers/videoGeneration.ts");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function haiperRequest(overrides: Record<string, unknown> = {}) {
  return handleVideoGeneration({
    body: { model: "haiper/gen2", prompt: "deadline test", ...overrides },
    credentials: { apiKey: "test-haiper-key" },
    log: null,
  });
}

test("Haiper does not submit when the caller was already cancelled", async () => {
  const caller = new AbortController();
  caller.abort();
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    throw new Error("fetch must not be called");
  }) as typeof fetch;

  const result = await handleVideoGeneration({
    body: { model: "haiper/gen2", prompt: "deadline test" },
    credentials: { apiKey: "test-haiper-key" },
    callerSignal: caller.signal,
    log: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 499);
  assert.equal(fetchCount, 0);
});

test("Haiper bounds and aborts an in-flight ambiguous submit at the task deadline", async () => {
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = ((_: unknown, init: RequestInit = {}) => {
    requestSignal = init.signal as AbortSignal;
    return new Promise((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
    });
  }) as typeof fetch;

  const result = await haiperRequest({ timeout_ms: 20 });

  assert.equal(result.success, false);
  assert.equal(result.status, 504);
  assert.equal(result.terminal, true);
  assert.equal(requestSignal?.aborted, true);
});

test("Haiper bounds submission response body parsing under the same deadline", async () => {
  let requestSignal: AbortSignal | undefined;
  globalThis.fetch = ((_: unknown, init: RequestInit = {}) => {
    requestSignal = init.signal as AbortSignal;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), {
            once: true,
          });
        }),
    } as Response);
  }) as typeof fetch;

  const result = await haiperRequest({ timeout_ms: 20 });

  assert.equal(result.success, false);
  assert.equal(result.status, 504);
  assert.equal(result.terminal, true, "the provider may have accepted the ambiguous create");
  assert.equal(requestSignal?.aborted, true);
});

test("Haiper continues polling after caller cancellation and returns terminal 499 at completion", async () => {
  const caller = new AbortController();
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    seen.push(url);
    if (init.method === "POST") {
      caller.abort();
      return new Response(JSON.stringify({ job_id: "accepted-job" }), { status: 200 });
    }
    if (url.endsWith("/accepted-job")) {
      assert.equal((init.signal as AbortSignal).aborted, false);
      return new Response(
        JSON.stringify({ status: "completed", creation_url: "https://video.test/out.mp4" }),
        {
          status: 200,
        }
      );
    }
    throw new Error(`unexpected fetch after cancellation: ${url}`);
  }) as typeof fetch;

  const result = await handleVideoGeneration({
    body: { model: "haiper/gen2", prompt: "deadline test" },
    credentials: { apiKey: "test-haiper-key" },
    callerSignal: caller.signal,
    log: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 499);
  assert.equal(result.terminal, true);
  assert.equal(
    seen.length,
    2,
    "accepted task is polled once; output is not downloaded after cancellation"
  );
  assert.match(seen[1]!, /accepted-job$/);
});

test("Haiper keeps a confirmed provider FAILED task fallback-eligible", async () => {
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    if (init.method === "POST") {
      return new Response(JSON.stringify({ job_id: "failed-job" }), { status: 200 });
    }
    assert.match(String(input), /failed-job$/);
    return new Response(JSON.stringify({ status: "failed", error: "provider rejected task" }), {
      status: 200,
    });
  }) as typeof fetch;

  const result = await haiperRequest({ poll_interval_ms: 1 });

  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.equal(result.terminal, undefined);
  assert.equal(result.error, "provider rejected task");
});

test("Haiper applies one deadline to accepted polling and aborts a stalled poll fetch", async () => {
  let pollSignal: AbortSignal | undefined;
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    if (init.method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ job_id: "stalled-job" }), { status: 200 })
      );
    }
    assert.match(String(input), /stalled-job$/);
    pollSignal = init.signal as AbortSignal;
    return new Promise((_resolve, reject) => {
      pollSignal?.addEventListener("abort", () => reject(pollSignal?.reason), { once: true });
    });
  }) as typeof fetch;

  const result = await haiperRequest({ timeout_ms: 20 });

  assert.equal(result.success, false);
  assert.equal(result.status, 504);
  assert.equal(result.terminal, true);
  assert.equal(pollSignal?.aborted, true);
});

test("Haiper caller cancellation does not stop accepted polling and resolves as terminal 499 at deadline", async () => {
  const caller = new AbortController();
  let pollSignal: AbortSignal | undefined;
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    if (init.method === "POST") {
      caller.abort();
      return Promise.resolve(
        new Response(JSON.stringify({ job_id: "cancelled-job" }), { status: 200 })
      );
    }
    assert.match(String(input), /cancelled-job$/);
    pollSignal = init.signal as AbortSignal;
    return new Promise((_resolve, reject) => {
      pollSignal?.addEventListener("abort", () => reject(pollSignal?.reason), { once: true });
    });
  }) as typeof fetch;

  const result = await handleVideoGeneration({
    body: { model: "haiper/gen2", prompt: "deadline test", timeout_ms: 20 },
    credentials: { apiKey: "test-haiper-key" },
    callerSignal: caller.signal,
    log: null,
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 499);
  assert.equal(result.terminal, true);
  assert.equal(pollSignal?.aborted, true, "only the server deadline aborts the accepted poll");
});

test("Haiper completes output download within the same task lifecycle", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    seen.push(url);
    if (init.method === "POST") {
      return new Response(JSON.stringify({ job_id: "complete-job" }), { status: 200 });
    }
    if (url.endsWith("/complete-job")) {
      return new Response(
        JSON.stringify({
          status: "succeeded",
          output: { video_url: "https://video.test/out.mp4" },
        }),
        {
          status: 200,
        }
      );
    }
    if (url === "https://video.test/out.mp4") return new Response(new Uint8Array([1, 2, 3]));
    throw new Error(`unexpected URL: ${url}`);
  }) as typeof fetch;

  const result = await haiperRequest();

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.data[0].b64_json, "AQID");
    assert.equal(result.data.data[0].format, "mp4");
  }
  assert.equal(seen.length, 3);
});

test("Haiper cancels a failed output-download response body", async () => {
  let bodyCancelled = false;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method === "POST") {
      return Response.json({ job_id: "output-error-job" });
    }
    if (url.endsWith("/output-error-job")) {
      return Response.json({ status: "completed", creation_url: "https://video.test/error.mp4" });
    }
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        bodyCancelled = true;
      },
    });
    return new Response(body, { status: 502 });
  }) as typeof fetch;

  const result = await haiperRequest();

  assert.equal(result.success, false);
  assert.equal(result.status, 502);
  assert.equal(result.terminal, true);
  assert.equal(bodyCancelled, true);
});

test("Haiper applies the task deadline to output response body reads", async () => {
  let downloadSignal: AbortSignal | undefined;
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify({ job_id: "slow-body-job" }), { status: 200 })
      );
    }
    if (url.endsWith("/slow-body-job")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ status: "completed", creation_url: "https://video.test/slow.mp4" }),
          {
            status: 200,
          }
        )
      );
    }
    downloadSignal = init.signal as AbortSignal;
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () =>
        new Promise((_resolve, reject) => {
          downloadSignal?.addEventListener("abort", () => reject(downloadSignal?.reason), {
            once: true,
          });
        }),
    } as Response);
  }) as typeof fetch;

  const result = await haiperRequest({ timeout_ms: 20 });

  assert.equal(result.success, false);
  assert.equal(result.status, 504);
  assert.equal(result.terminal, true);
  assert.equal(downloadSignal?.aborted, true);
});

test("Haiper aborts output retrieval when the caller disconnects after task completion", async () => {
  const caller = new AbortController();
  let downloadSignal: AbortSignal | undefined;
  let outputStarted!: () => void;
  const started = new Promise<void>((resolve) => (outputStarted = resolve));
  globalThis.fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (init.method === "POST") {
      return Promise.resolve(Response.json({ job_id: "caller-abort-output-job" }));
    }
    if (url.endsWith("/caller-abort-output-job")) {
      return Promise.resolve(
        Response.json({ status: "completed", creation_url: "https://video.test/slow.mp4" })
      );
    }
    downloadSignal = init.signal as AbortSignal;
    outputStarted();
    return Promise.resolve({
      ok: true,
      status: 200,
      arrayBuffer: () =>
        new Promise((_resolve, reject) => {
          downloadSignal?.addEventListener("abort", () => reject(downloadSignal?.reason), {
            once: true,
          });
        }),
    } as Response);
  }) as typeof fetch;

  const pending = handleVideoGeneration({
    body: { model: "haiper/gen2", prompt: "deadline test", timeout_ms: 5_000 },
    credentials: { apiKey: "test-haiper-key" },
    callerSignal: caller.signal,
    log: null,
  });
  await started;
  caller.abort(new Error("caller disconnected during artifact download"));
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(result.status, 499);
  assert.equal(result.terminal, true);
  assert.equal(downloadSignal?.aborted, true);
});
