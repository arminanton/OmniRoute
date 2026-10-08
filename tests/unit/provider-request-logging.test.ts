import test from "node:test";
import assert from "node:assert/strict";

import {
  captureCurrentProviderBody,
  createPreparedRequestLogger,
  runWithCapture,
  type Capture,
  type ProviderRequestPrepared,
} from "../../open-sse/utils/providerRequestLogging.ts";
import {
  boundMemoryRetrievalQuery,
  MAX_MEMORY_RETRIEVAL_QUERY_CHARS,
  MAX_MEMORY_RETRIEVAL_QUERY_TERMS,
  sanitizeFts5Query,
} from "../../src/lib/memory/retrieval/scoring.ts";

test("disabled prepared-request capture keeps large provider bodies out of the capture context", async () => {
  let loggedRequests = 0;
  const fallback = {
    model: "gpt-6.1-sol",
    messages: [{ role: "user", content: "fallback" }],
  };
  const capture = createPreparedRequestLogger(
    { logTargetRequest: () => loggedRequests++ },
    { id: null, model: "gpt-6.1-sol", provider: "codex", connectionId: null },
    { enabled: false }
  );

  await capture.capture({
    url: "https://provider.example/v1/responses",
    headers: {},
    body: { model: "gpt-6.1-sol", messages: [{ role: "user", content: "large" }] },
    bodyString: JSON.stringify({
      model: "gpt-6.1-sol",
      messages: [{ role: "user", content: "large" }],
    }),
  });

  assert.equal(loggedRequests, 0);
  assert.equal(capture.latest?.() ?? null, null);
  assert.strictEqual(capture.body(fallback), fallback);
});

test("disabled capture bypasses the fetch observer without parsing provider bodies", async () => {
  const originalFetch = globalThis.fetch;
  let captureCalls = 0;
  const capture: Capture = {
    enabled: false,
    capture() {
      captureCalls++;
    },
    body(fallback) {
      return fallback;
    },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    await runWithCapture(capture, () =>
      fetch("https://provider.example/v1/responses", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-6.1-sol",
          input: [{ role: "user", content: "large synthetic request" }],
        }),
      })
    );
    assert.equal(captureCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("memory retrieval bounds a huge prompt before sanitizing it for FTS", () => {
  const prompt = "memory-word ".repeat(150_000);
  const bounded = boundMemoryRetrievalQuery(prompt);
  const ftsQuery = sanitizeFts5Query(prompt);

  assert.ok(bounded.length <= MAX_MEMORY_RETRIEVAL_QUERY_CHARS);
  assert.ok(ftsQuery.split(/\s+/).filter(Boolean).length <= MAX_MEMORY_RETRIEVAL_QUERY_TERMS);
  assert.ok(ftsQuery.length < 32);
});

test("runWithCapture captures the actual JSON provider fetch body", async () => {
  const originalFetch = globalThis.fetch;
  const prepared: ProviderRequestPrepared[] = [];
  const sentBodies: unknown[] = [];
  const capture: Capture = {
    capture(request) {
      prepared.push(request);
    },
    body(fallback) {
      return prepared.at(-1)?.body ?? fallback;
    },
  };

  globalThis.fetch = async (_url, init = {}) => {
    sentBodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await runWithCapture(capture, () =>
      fetch("https://provider.example/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer provider-key" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: "high",
        }),
      })
    );

    assert.equal(prepared.length, 1);
    assert.deepEqual(prepared[0].body, sentBodies[0]);
    assert.equal(prepared[0].url, "https://provider.example/v1/chat/completions");
    assert.equal(prepared[0].headers.authorization, "Bearer provider-key");
    assert.equal((capture.body(null) as Record<string, unknown>).reasoning_effort, "high");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runWithCapture ignores auth fetch bodies in the same executor scope", async () => {
  const originalFetch = globalThis.fetch;
  const prepared: ProviderRequestPrepared[] = [];
  const capture: Capture = {
    capture(request) {
      prepared.push(request);
    },
    body(fallback) {
      return prepared.at(-1)?.body ?? fallback;
    },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    await runWithCapture(capture, async () => {
      await fetch("https://oauth.example/token", {
        method: "POST",
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: "refresh",
          client_id: "client",
        }),
      });
      await fetch("https://provider.example/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
    });

    assert.equal(prepared.length, 1);
    assert.equal((prepared[0].body as Record<string, unknown>).model, "gpt-5");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runWithCapture does not duplicate an already prepared identical fetch", async () => {
  const originalFetch = globalThis.fetch;
  const prepared: ProviderRequestPrepared[] = [];
  const body = {
    model: "gpt-5",
    messages: [{ role: "user", content: "hi" }],
  };
  const bodyString = JSON.stringify(body);
  const url = "https://provider.example/v1/chat/completions";
  let latest: ProviderRequestPrepared | null = null;
  const capture: Capture = {
    capture(request) {
      latest = request;
      prepared.push(request);
    },
    body(fallback) {
      return latest?.body ?? fallback;
    },
    latest() {
      return latest;
    },
  };

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });

  try {
    await runWithCapture(capture, async () => {
      await capture.capture({ url, headers: {}, body, bodyString });
      await fetch(url, {
        method: "POST",
        body: bodyString,
      });
    });

    assert.equal(prepared.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("private-overflow prepared bodies skip the duplicate provider-fetch JSON parse", async () => {
  const originalFetch = globalThis.fetch;
  const originalParse = JSON.parse;
  const bodyString = JSON.stringify({
    model: "antigravity/gemini-3.8-flash-high",
    request: { contents: [{ role: "user", parts: [{ text: "x".repeat(262_144) }] }] },
  });
  const url = "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent";
  const scope = {
    id: null,
    model: "gemini-3.8-flash-high",
    provider: "antigravity",
    connectionId: null,
  };
  let loggedBody: unknown = "not-called";
  let bodyParseCalls = 0;
  const capture = createPreparedRequestLogger(
    {
      diagnosticOverflowOnly: true,
      getDiagnosticOverflowTrace: () => null,
      logTargetRequest: (_url, _headers, body) => {
        loggedBody = body;
      },
    },
    scope,
    { provider: "antigravity" }
  );

  globalThis.fetch = async () => new Response("ok");
  JSON.parse = ((
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown
  ) => {
    if (text === bodyString) bodyParseCalls++;
    return originalParse(text, reviver);
  }) as typeof JSON.parse;

  try {
    await runWithCapture(capture, async () => {
      await captureCurrentProviderBody(url, { "content-type": "application/json" }, bodyString);
      const response = await fetch(url, { method: "POST", body: bodyString });
      assert.equal(await response.text(), "ok");
    });

    assert.equal(bodyParseCalls, 0);
    assert.equal(
      loggedBody,
      null,
      "private overflow must leave the full request body out of the ordinary log"
    );
    assert.equal(capture.latest?.()?.bodyString, "private-overflow");
    assert.equal(capture.latest?.()?.bodyFingerprint?.length, 64);
  } finally {
    JSON.parse = originalParse;
    globalThis.fetch = originalFetch;
  }
});
