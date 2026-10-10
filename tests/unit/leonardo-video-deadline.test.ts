import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omniroute-leonardo-deadline-"));

const { handleLeonardoVideoGeneration } =
  await import("../../open-sse/handlers/videoGeneration/leonardoHandler.ts");

const providerConfig = { baseUrl: "https://cloud.leonardo.example/generations" };

function jsonResponse(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function generationResponse(generationId = "leo-task-1") {
  return jsonResponse({ sdGenerationJob: { generationId } });
}

function statusResponse(status: string, url?: string) {
  return jsonResponse({
    generations_by_pk: {
      status,
      ...(url ? { generated_images: [{ url }] } : {}),
    },
  });
}

function request(body: Record<string, unknown> = {}, callerSignal?: AbortSignal | null) {
  return handleLeonardoVideoGeneration({
    model: "phoenix",
    provider: "leonardo",
    providerConfig,
    body: { prompt: "A cinematic mountain landscape", ...body },
    credentials: { apiKey: "leonardo-test-key" },
    callerSignal,
    log: null,
  });
}

test("Leonardo successful submit, poll, and output fetch return the encoded MP4", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push({ url: target, init });
    if (target === providerConfig.baseUrl) return generationResponse();
    if (target.endsWith("/leo-task-1"))
      return statusResponse("COMPLETE", "https://cdn.example/leo.mp4");
    if (target === "https://cdn.example/leo.mp4") return new Response(new Uint8Array([1, 2, 3]));
    throw new Error(`Unexpected URL: ${target}`);
  };

  try {
    const result = await request({ poll_interval_ms: 1 });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.data[0].b64_json, Buffer.from([1, 2, 3]).toString("base64"));
      assert.equal(result.data.data[0].format, "mp4");
    }
    assert.equal(calls.length, 3);
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(
      calls[0].init?.headers && (calls[0].init.headers as Record<string, string>).Authorization,
      "Bearer leonardo-test-key"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo bounds a hung submit and marks its ambiguous outcome terminal", async () => {
  const originalFetch = globalThis.fetch;
  let requestSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    requestSignal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  };

  try {
    const result = await request({ timeout_ms: 80 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 504);
      assert.equal(result.terminal, true);
      assert.match(result.error, /timed out/i);
    }
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo transport failure during submit is terminal because acceptance is ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new TypeError("socket closed after request write");
  };

  try {
    const result = await request();
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 502);
      assert.equal(result.terminal, true);
      assert.match(result.error, /outcome is unknown/i);
    }
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo 2xx submit without a generation id is terminal", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ sdGenerationJob: {} });

  try {
    const result = await request();
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 502);
      assert.equal(result.terminal, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo explicit submit rejection remains fallback eligible", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ message: "invalid prompt" }, 400);

  try {
    const result = await request();
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 400);
      assert.equal(result.terminal, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo explicit task FAILED remains fallback eligible", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return generationResponse();
    return statusResponse("FAILED");
  };

  try {
    const result = await request({ poll_interval_ms: 1 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 502);
      assert.equal(result.terminal, undefined);
      assert.match(result.error, /generation failed/i);
    }
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo accepted task polling is bounded and never resubmits", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let pollSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    calls++;
    if (calls === 1) return generationResponse();
    pollSignal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  };

  try {
    const result = await request({ timeout_ms: 80, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 504);
      assert.equal(result.terminal, true);
    }
    assert.equal(calls, 2);
    assert.equal(pollSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo deadline includes the poll interval and prevents a late status request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return generationResponse();
  };

  try {
    const result = await request({ timeout_ms: 80, poll_interval_ms: 500 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 504);
      assert.equal(result.terminal, true);
    }
    assert.equal(calls, 1, "no poll begins after the absolute deadline");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo caller disconnect does not abort accepted work and returns terminal cancellation", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  const seenSignals: AbortSignal[] = [];
  let calls = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls++;
    const target = String(url);
    if (init.signal) seenSignals.push(init.signal as AbortSignal);
    if (target === providerConfig.baseUrl) {
      caller.abort(new Error("client disconnected"));
      return generationResponse();
    }
    if (target.endsWith("/leo-task-1")) {
      assert.equal(init.signal, seenSignals[0]);
      assert.equal((init.signal as AbortSignal).aborted, false);
      return statusResponse("COMPLETE", "https://cdn.example/leo.mp4");
    }
    if (target === "https://cdn.example/leo.mp4") return new Response(new Uint8Array([9]));
    throw new Error(`Unexpected URL: ${target}`);
  };

  try {
    const result = await request({ poll_interval_ms: 1 }, caller.signal);
    assert.equal(caller.signal.aborted, true);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 499, JSON.stringify(result));
      assert.equal(result.terminal, true);
    }
    assert.equal(calls, 3);
    assert.equal(seenSignals.length, 3);
    assert.ok(seenSignals.every((signal) => signal !== caller.signal));
    assert.ok(seenSignals.every((signal) => !signal.aborted));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo caller disconnect takes precedence over a confirmed task failure after polling", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      caller.abort(new Error("client disconnected"));
      return generationResponse();
    }
    return statusResponse("FAILED");
  };

  try {
    const result = await request({ poll_interval_ms: 1 }, caller.signal);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 499, JSON.stringify(result));
      assert.equal(result.terminal, true);
    }
    assert.equal(calls, 2, "the accepted task is polled to its terminal provider state");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("video dispatcher forwards caller cancellation to the Leonardo job handler", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  const calls: string[] = [];

  try {
    const { handleVideoGeneration } = await import("../../open-sse/handlers/videoGeneration.ts");
    const { getVideoProvider } = await import("../../open-sse/config/videoRegistry.ts");
    const dispatcherBaseUrl = getVideoProvider("leonardo")!.baseUrl;
    // Importing the shared dispatcher installs OmniRoute's fetch instrumentation;
    // replace it afterward so this test controls the actual provider transport.
    globalThis.fetch = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target === dispatcherBaseUrl) {
        caller.abort(new Error("client disconnected"));
        return generationResponse();
      }
      if (target.endsWith("/leo-task-1"))
        return statusResponse("COMPLETE", "https://cdn.example/leo.mp4");
      if (target === "https://cdn.example/leo.mp4") return new Response(new Uint8Array([1, 2, 3]));
      throw new Error(`Unexpected URL: ${target}`);
    };
    const result = await handleVideoGeneration({
      body: { model: "leonardo/phoenix", prompt: "a cinematic landscape", poll_interval_ms: 1 },
      credentials: { apiKey: "leonardo-test-key" },
      callerSignal: caller.signal,
      log: null,
    });

    assert.deepEqual(
      calls,
      [dispatcherBaseUrl, `${dispatcherBaseUrl}/leo-task-1`, "https://cdn.example/leo.mp4"],
      `unexpected dispatcher path/result: ${JSON.stringify(result)}`
    );
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 499, JSON.stringify(result));
      assert.equal(result.terminal, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo caller disconnect takes precedence over post-acceptance transport failure", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      caller.abort(new Error("client disconnected"));
      return generationResponse();
    }
    throw new TypeError("poll socket closed");
  };

  try {
    const result = await request({ poll_interval_ms: 1 }, caller.signal);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 499);
      assert.equal(result.terminal, true);
    }
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo caller disconnect remains terminal after accepted-task deadline", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let calls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    calls++;
    if (calls === 1) {
      caller.abort(new Error("client disconnected"));
      return generationResponse();
    }
    assert.equal((init.signal as AbortSignal).aborted, false);
    return new Promise<Response>(() => {});
  };

  try {
    const result = await request({ timeout_ms: 80, poll_interval_ms: 1 }, caller.signal);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 499);
      assert.equal(result.terminal, true);
    }
    assert.equal(calls, 2, "the server deadline bounds the accepted task after disconnect");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo deadline bounds an output response body after task completion", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let outputSignal: AbortSignal | null = null;
  globalThis.fetch = async (url, init = {}) => {
    calls++;
    const target = String(url);
    if (target === providerConfig.baseUrl) return generationResponse();
    if (target.endsWith("/leo-task-1")) {
      return statusResponse("COMPLETE", "https://cdn.example/slow.mp4");
    }
    outputSignal = init.signal as AbortSignal;
    return {
      ok: true,
      status: 200,
      arrayBuffer: () => new Promise<ArrayBuffer>(() => {}),
    } as Response;
  };

  try {
    const result = await request({ timeout_ms: 80, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 504);
      assert.equal(result.terminal, true);
    }
    assert.equal(calls, 3);
    assert.equal(outputSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo deadline bounds an unreadable accepted-task poll body", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return generationResponse();
    return {
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => {}),
    } as Response;
  };

  try {
    const result = await request({ timeout_ms: 80, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 504);
      assert.equal(result.terminal, true);
    }
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Leonardo request already cancelled before submit makes no provider call", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  caller.abort();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return generationResponse();
  };

  try {
    const result = await request({}, caller.signal);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 499);
      assert.equal(result.terminal, undefined, "pre-dispatch cancellation has no accepted work");
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
