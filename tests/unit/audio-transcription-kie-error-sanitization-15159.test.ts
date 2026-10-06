import test from "node:test";
import assert from "node:assert/strict";

const { handleAudioTranscription } = await import("../../open-sse/handlers/audioTranscription.ts");

async function transcribeWithFetch(fetchImpl: typeof fetch): Promise<Response> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const formData = new FormData();
    formData.append("model", "kie/model");
    formData.append("file", new File(["audio"], "audio.wav", { type: "audio/wav" }));
    return await handleAudioTranscription({
      formData,
      credentials: { apiKey: "client-api-key" },
      resolvedProvider: {
        id: "kie",
        format: "kie-audio",
        baseUrl: "https://kie.example",
        authType: "api-key",
        authHeader: "Authorization",
        models: [],
      },
      resolvedModel: "model",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("Kie createTask failures do not expose raw upstream bodies", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamBody =
    "<html><body>Authorization: Bearer upstream-secret-token<br>/srv/kie/private/worker.js</body></html>";
  globalThis.fetch = async () =>
    new Response(upstreamBody, {
      status: 429,
      headers: { "Content-Type": "text/html" },
    });

  try {
    const formData = new FormData();
    formData.append("model", "kie/model");
    formData.append("file", new File(["audio"], "audio.wav", { type: "audio/wav" }));

    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "client-api-key" },
      resolvedProvider: {
        id: "kie",
        format: "kie-audio",
        baseUrl: "https://kie.example",
        authType: "api-key",
        authHeader: "Authorization",
        models: [],
      },
      resolvedModel: "model",
    });
    const body = await response.text();
    const payload = JSON.parse(body);

    assert.equal(response.status, 429);
    assert.equal(payload.error.message, "Kie transcription createTask failed");
    assert.equal(
      response.headers.get("Access-Control-Allow-Methods"),
      "GET, POST, PUT, DELETE, PATCH, OPTIONS"
    );
    assert.equal(
      response.headers.get("Access-Control-Allow-Headers"),
      "Content-Type, Authorization, x-api-key, anthropic-version, x-omniroute-connection, x-internal-test, accept"
    );
    assert.doesNotMatch(body, /upstream-secret-token|\/srv\/kie\/private\/worker\.js|<html>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Kie createTask preserves plain Error prose with fallback status", async () => {
  const response = await transcribeWithFetch(async () => {
    throw new Error("Kie network unavailable");
  });
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.error.message, "Kie network unavailable");
});

test("Kie createTask retains status from status-bearing errors", async () => {
  const response = await transcribeWithFetch(async () => {
    throw Object.assign(new Error("Kie rate limit exceeded"), { status: 429 });
  });
  const payload = await response.json();

  assert.equal(response.status, 429);
  assert.equal(payload.error.message, "Kie rate limit exceeded");
});

test("Kie createTask falls back to 502 for out-of-range statuses", async () => {
  for (const status of [399, 600]) {
    const response = await transcribeWithFetch(async () => {
      throw Object.assign(new Error("Kie request failed"), { status });
    });
    assert.equal(response.status, 502);
  }
});

test("Kie createTask preserves safe upstream prose and redacts secrets and paths", async () => {
  const response = await transcribeWithFetch(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            message:
              "Kie rejected request: Authorization: Bearer upstream-secret-token. " +
              "safe details ".repeat(60) +
              "\nError: upstream-stack-secret\n    at transcription (/srv/kie/private/worker.js:1:1)",
          },
        }),
        { status: 503 }
      )
  );
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.match(payload.error.message, /Kie rejected request/);
  assert.ok(payload.error.message.length <= 500);
  assert.doesNotMatch(
    payload.error.message,
    /upstream-secret-token|upstream-stack-secret|\/srv\/kie\/private\/worker\.js|at transcription/
  );
});

test("Kie poll failures expose only sanitized structured error messages", async () => {
  let calls = 0;
  const response = await transcribeWithFetch(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ data: { taskId: "task-1" } }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        error: {
          message:
            "Kie transcription failed. Authorization: Bearer poll-secret-token. " +
            "https://kie.example/jobs/1?api_key=query-secret\n" +
            "Error: poll-stack-secret\n    at poll (/srv/kie/private/worker.js:1:1)",
        },
      }),
      { status: 503 }
    );
  });
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.error.code, 503);
  assert.match(payload.error.message, /Kie transcription failed/);
  assert.doesNotMatch(
    payload.error.message,
    /poll-secret-token|query-secret|poll-stack-secret|\/srv\/kie|at poll/
  );
  assert.equal(calls, 2);
});
