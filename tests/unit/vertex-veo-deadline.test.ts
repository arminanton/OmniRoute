import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { handleVideoGeneration } from "../../open-sse/handlers/videoGeneration.ts";

function serviceAccount(accessToken: string | null = "vertex-test-token") {
  return {
    apiKey: JSON.stringify({
      type: "service_account",
      project_id: "vertex-veo-test-project",
      private_key_id: "test-key-id",
      private_key: "unused-when-access-token-is-present",
      client_email: `veo-${Math.random().toString(16).slice(2)}@test.iam.gserviceaccount.com`,
    }),
    accessToken,
    providerSpecificData: { region: "us-central1" },
  };
}

function request(body: Record<string, unknown> = {}, callerSignal?: AbortSignal | null) {
  return handleVideoGeneration({
    body: { model: "vertex/veo-3.0-fast-generate-001", prompt: "A quiet forest", ...body },
    credentials: serviceAccount(),
    callerSignal,
    log: null,
  });
}

function jsonResponse(value: unknown, status = 200) {
  return Response.json(value, { status });
}

test("Vertex Veo threads a bounded server signal through submit and polling", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return calls.length === 1
      ? jsonResponse({ name: "projects/p/locations/us-central1/operations/op-1" })
      : jsonResponse({ done: true, response: { videos: [{ bytesBase64Encoded: "TVA0" }] } });
  };

  try {
    const result = await request({ timeout_ms: 2_000, poll_interval_ms: 1 });
    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ init }) => init.signal instanceof AbortSignal));
    assert.equal((calls[1].init.signal as AbortSignal).aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an already-aborted caller is rejected before any OAuth or Veo network request", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse({});
  };
  const caller = new AbortController();
  caller.abort();

  try {
    const result = await request({}, caller.signal);
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.status, 499);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the server deadline also aborts a stalled OAuth token exchange", async () => {
  const originalFetch = globalThis.fetch;
  let tokenSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    tokenSignal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credentials = {
    apiKey: JSON.stringify({
      type: "service_account",
      project_id: "vertex-veo-auth-timeout-project",
      private_key_id: "test-key-id",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_email: `auth-timeout-${Date.now()}@test.iam.gserviceaccount.com`,
    }),
    accessToken: null,
  };

  try {
    const result = await handleVideoGeneration({
      body: { model: "vertex/veo-3.0-fast-generate-001", prompt: "A quiet forest", timeout_ms: 50 },
      credentials,
      log: null,
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 504);
      assert.equal(result.terminal, undefined);
    }
    assert.equal(tokenSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("caller cancellation during OAuth stops before Veo submission", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let tokenSignal: AbortSignal | null = null;
  let calls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    calls++;
    tokenSignal = init.signal as AbortSignal;
    return new Promise<Response>((_resolve, reject) => {
      tokenSignal?.addEventListener("abort", () => reject(new Error("OAuth request aborted")), {
        once: true,
      });
    });
  };
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credentials = {
    apiKey: JSON.stringify({
      type: "service_account",
      project_id: "vertex-veo-cancel-project",
      private_key_id: "test-key-id",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      client_email: `cancel-${Date.now()}@test.iam.gserviceaccount.com`,
    }),
    accessToken: null,
  };

  try {
    const resultPromise = handleVideoGeneration({
      body: {
        model: "vertex/veo-3.0-fast-generate-001",
        prompt: "A quiet forest",
        timeout_ms: 2_000,
      },
      credentials,
      callerSignal: caller.signal,
      log: null,
    });
    setTimeout(() => caller.abort(), 15);
    const result = await resultPromise;
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.status, 499);
    assert.equal(calls, 1);
    assert.equal(tokenSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a stalled submit times out and is terminal because acceptance is ambiguous", async () => {
  const originalFetch = globalThis.fetch;
  let submitSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    submitSignal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  };

  try {
    const result = await request({ timeout_ms: 50 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 504);
      assert.equal(result.terminal, true);
    }
    assert.equal(submitSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a known Vertex 429 stays fallback-eligible when its error body stalls", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const response = new Response(null, { status: 429 });
    response.text = () => new Promise<string>(() => {});
    return response;
  };

  try {
    const result = await request({ timeout_ms: 500 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 429);
      assert.equal(result.terminal, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an accepted operation with a stalled poll is bounded and terminal", async () => {
  const originalFetch = globalThis.fetch;
  let pollSignal: AbortSignal | null = null;
  let calls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    calls++;
    if (calls === 1) return jsonResponse({ name: "projects/p/operations/op-2" });
    pollSignal = init.signal as AbortSignal;
    return new Promise<Response>(() => {});
  };

  try {
    const result = await request({ timeout_ms: 60, poll_interval_ms: 1 });
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

test("a caller disconnect after submit does not abort the accepted operation poll", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let pollSignal: AbortSignal | null = null;
  let calls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    calls++;
    if (calls === 1) return jsonResponse({ name: "projects/p/operations/op-3" });
    pollSignal = init.signal as AbortSignal;
    caller.abort();
    return jsonResponse({ done: true, response: { videos: [{ bytesBase64Encoded: "TVA0" }] } });
  };

  try {
    const result = await request({ timeout_ms: 2_000, poll_interval_ms: 1 }, caller.signal);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 499);
      assert.equal(result.terminal, true);
    }
    assert.equal(calls, 2);
    assert.equal(pollSignal?.aborted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an accepted operation poll HTTP error is terminal to prevent duplicate combo work", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? jsonResponse({ name: "projects/p/operations/op-4" })
      : jsonResponse({ error: { message: "temporarily unavailable" } }, 429);
  };

  try {
    const result = await request({ timeout_ms: 2_000, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 429);
      assert.equal(result.terminal, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an explicit completed Vertex operation error remains fallback eligible", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? jsonResponse({ name: "projects/p/operations/op-5" })
      : jsonResponse({ done: true, error: { code: 400, message: "unsupported duration" } });
  };

  try {
    const result = await request({ timeout_ms: 2_000, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 400);
      assert.equal(result.terminal, undefined);
      assert.match(result.error, /unsupported duration/);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a hung accepted-operation response body is covered by the same deadline", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let pollSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    calls++;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ name: "projects/p/operations/op-6" }),
      } as Response;
    }
    pollSignal = init.signal as AbortSignal;
    return {
      ok: true,
      status: 200,
      json: async () => new Promise(() => {}),
    } as Response;
  };

  try {
    const result = await request({ timeout_ms: 60, poll_interval_ms: 1 });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.status, 504);
      assert.equal(result.terminal, true);
    }
    assert.equal(pollSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
