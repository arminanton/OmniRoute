import test from "node:test";
import assert from "node:assert/strict";
import { upstreamErrorResponse } from "../../open-sse/utils/audioResponse.ts";

const { handleAudioTranscription } = await import("../../open-sse/handlers/audioTranscription.ts");

test("upstream audio errors preserve safe messages, status, and CORS", async () => {
  const response = upstreamErrorResponse(
    new Response(null, { status: 429 }),
    JSON.stringify({ error: { message: "Transcription quota exceeded. Add credits and retry." } })
  );
  const payload = await response.json();

  assert.equal(response.status, 429);
  assert.equal(payload.error.message, "Transcription quota exceeded. Add credits and retry.");
  assert.equal(payload.error.code, 429);
  assert.equal(
    response.headers.get("Access-Control-Allow-Methods"),
    "GET, POST, PUT, DELETE, PATCH, OPTIONS"
  );
});

test("upstream audio errors omit tokens, paths, HTML, and raw bodies", async () => {
  const cases = [
    {
      status: 502,
      body: JSON.stringify({
        message: "Request failed. Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secretpayload",
      }),
      sensitiveText: /eyJhbGci/,
      safeText: "Request failed.",
    },
    {
      status: 502,
      body: JSON.stringify({ message: "Provider login failed: password=hunter2" }),
      sensitiveText: /hunter2/,
    },
    {
      status: 502,
      body: JSON.stringify({ message: "Provider failed at /srv/kie/private/worker.js" }),
      sensitiveText: /\/srv\/kie/,
    },
    {
      status: 502,
      body: JSON.stringify({ message: "<html><body>provider error</body></html>" }),
      sensitiveText: /<html>/,
      opaque: true,
    },
    {
      status: 503,
      body: "Provider failed at /srv/kie/private/worker.js",
      sensitiveText: /\/srv\/kie/,
      opaque: true,
    },
  ];

  for (const { status, body, sensitiveText, safeText, opaque } of cases) {
    const response = upstreamErrorResponse(new Response(null, { status }), body);
    const payload = await response.json();

    assert.equal(response.status, status);
    assert.equal(payload.error.code, status);
    assert.doesNotMatch(payload.error.message, sensitiveText);
    if (opaque) assert.equal(payload.error.message, `Upstream error (${status})`);
    if (safeText) assert.ok(payload.error.message.includes(safeText));
  }
});

test("upstream audio errors do not echo non-JSON prose", async () => {
  const response = upstreamErrorResponse(
    new Response(null, { status: 503 }),
    "Transcription is temporarily unavailable. Please try again shortly."
  );
  const payload = await response.json();

  assert.equal(response.status, 503);
  assert.equal(payload.error.message, "Upstream error (503)");
  assert.equal(payload.error.code, 503);
});

test("upstream audio errors normalize invalid statuses to 502", async () => {
  const response = upstreamErrorResponse(new Response(null, { status: 200 }), "{}");
  const payload = await response.json();

  assert.equal(response.status, 502);
  assert.equal(payload.error.code, 502);
});

test("audio transcription route sanitizes and caps upstream error messages", async () => {
  const originalFetch = globalThis.fetch;
  const upstreamMessage =
    "Authorization: Bearer route-secret-token. Transcription failed: " +
    "safe detail ".repeat(80) +
    "\nError: upstream-stack-secret\n    at transcribe (/srv/kie/private/worker.js:11:2)";
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: upstreamMessage }), { status: 503 });

  try {
    const formData = new FormData();
    formData.append("model", "deepgram/nova-2");
    formData.append("file", new File(["audio"], "audio.wav", { type: "audio/wav" }));
    const response = await handleAudioTranscription({
      formData,
      credentials: { apiKey: "client-api-key" },
      resolvedProvider: {
        id: "deepgram",
        format: "deepgram",
        baseUrl: "https://deepgram.example/v1/listen",
        authType: "api-key",
        authHeader: "Authorization",
        models: [],
      },
      resolvedModel: "nova-2",
    });
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.error.code, 503);
    assert.ok(payload.error.message.length <= 500);
    assert.ok(payload.error.message.length > 0);
    assert.doesNotMatch(
      payload.error.message,
      /route-secret-token|upstream-stack-secret|https?:\/\/|\/srv\/kie|at transcribe/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

const asyncProviderCases = [
  {
    name: "AssemblyAI",
    provider: {
      id: "assemblyai",
      format: "assemblyai",
      baseUrl: "https://assemblyai.example/v2/transcript",
      authType: "api-key",
      authHeader: "Authorization",
      models: [],
    },
    setup: [{ upload_url: "https://assemblyai.example/upload" }, { id: "task-1" }],
    terminal: {
      status: "error",
      error: "Transcription rejected. Authorization: Bearer terminal-secret",
    },
  },
  {
    name: "Gladia",
    provider: {
      id: "gladia",
      format: "gladia",
      baseUrl: "https://gladia.example/v2/pre-recorded",
      authType: "api-key",
      authHeader: "Authorization",
      models: [],
    },
    setup: [
      { audio_url: "https://gladia.example/upload" },
      { result_url: "https://gladia.example/result/task-1" },
    ],
    terminal: {
      status: "error",
      error_code:
        "Transcription rejected. https://gladia.example/?api_key=query-secret at /srv/provider/private.js",
    },
  },
  {
    name: "Soniox",
    provider: {
      id: "soniox",
      format: "soniox",
      baseUrl: "https://soniox.example/v1/transcriptions",
      authType: "api-key",
      authHeader: "Authorization",
      models: [],
    },
    setup: [{ id: "file-1" }, { id: "task-1" }],
    terminal: {
      status: "error",
      error_message: "Transcription rejected. Authorization: Bearer terminal-secret",
    },
  },
  {
    name: "Rev AI",
    provider: {
      id: "rev-ai",
      format: "rev-ai",
      baseUrl: "https://rev.example/v1",
      authType: "api-key",
      authHeader: "Authorization",
      models: [],
    },
    setup: [{ id: "job-1" }],
    terminal: {
      status: "failed",
      failure_detail: "Transcription rejected. Authorization: Bearer terminal-secret",
    },
  },
  {
    name: "Speechmatics",
    provider: {
      id: "speechmatics",
      format: "speechmatics",
      baseUrl: "https://speechmatics.example/v2/jobs",
      authType: "api-key",
      authHeader: "Authorization",
      models: [],
    },
    setup: [{ id: "job-1" }],
    terminal: {
      job: {
        status: "rejected",
        errors: [{ message: "Transcription rejected. Authorization: Bearer terminal-secret" }],
      },
    },
  },
];

async function callAudioRoute(
  provider: (typeof asyncProviderCases)[number]["provider"],
  fetchImpl: typeof fetch
): Promise<Response> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const formData = new FormData();
    formData.append("model", `${provider.id}/model`);
    formData.append("file", new File(["audio"], "audio.wav", { type: "audio/wav" }));
    return await handleAudioTranscription({
      formData,
      credentials: { apiKey: "client-api-key" },
      resolvedProvider: provider,
      resolvedModel: "model",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function providerFailureResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message:
          "Transcription failed. Authorization: Bearer provider-secret-token. " +
          "https://provider.example/jobs/1?api_key=query-secret\n" +
          "Error: upstream-stack-secret\n    at provider (/srv/provider/private.js:1:2)",
      },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

test("async transcription provider create errors use sanitized upstream responses", async () => {
  for (const { name, provider } of asyncProviderCases) {
    let calls = 0;
    const response = await callAudioRoute(provider, async () => {
      calls += 1;
      return providerFailureResponse();
    });
    const payload = await response.json();

    assert.equal(response.status, 503, `${name} create status`);
    assert.equal(payload.error.code, 503, `${name} create code`);
    assert.match(payload.error.message, /Transcription failed/);
    assert.doesNotMatch(
      payload.error.message,
      /provider-secret-token|query-secret|https?:\/\/|upstream-stack-secret|\/srv\/provider|at provider/
    );
    assert.equal(calls, 1);
  }
});

test("async transcription provider poll errors use sanitized upstream responses", async () => {
  for (const { name, provider, setup } of asyncProviderCases) {
    let calls = 0;
    const response = await callAudioRoute(provider, async () => {
      const current = calls++;
      return current < setup.length
        ? new Response(JSON.stringify(setup[current]), { status: 200 })
        : providerFailureResponse();
    });
    const payload = await response.json();

    assert.equal(response.status, 503, `${name} poll status`);
    assert.equal(payload.error.code, 503, `${name} poll code`);
    assert.match(payload.error.message, /Transcription failed/);
    assert.doesNotMatch(
      payload.error.message,
      /provider-secret-token|query-secret|https?:\/\/|upstream-stack-secret|\/srv\/provider|at provider/
    );
    assert.equal(calls, setup.length + 1);
  }
});

test("async transcription provider terminal errors sanitize provider messages", async () => {
  for (const { name, provider, setup, terminal } of asyncProviderCases) {
    let calls = 0;
    const response = await callAudioRoute(provider, async () => {
      const current = calls++;
      return current < setup.length
        ? new Response(JSON.stringify(setup[current]), { status: 200 })
        : new Response(JSON.stringify(terminal), { status: 200 });
    });
    const payload = await response.json();

    assert.equal(response.status, 500, `${name} terminal status`);
    assert.equal(payload.error.code, 500, `${name} terminal code`);
    assert.ok(payload.error.message.length > 0, `${name} safe fallback`);
    assert.doesNotMatch(
      payload.error.message,
      /terminal-secret|query-secret|https?:\/\/|\/srv\/provider/
    );
    assert.equal(calls, setup.length + 1);
  }
});

test("Vertex transcription errors sanitize upstream messages and clamp status", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => providerFailureResponse();
  try {
    const provider = {
      id: "vertex",
      format: "vertex-gemini",
      baseUrl: "https://vertex.example/v1",
      authType: "api-key",
      authHeader: "Authorization",
      models: [],
    };
    const response = await callAudioRoute(provider, globalThis.fetch);
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.error.code, 503);
    assert.match(payload.error.message, /Vertex transcription failed: Transcription failed/);
    assert.doesNotMatch(
      payload.error.message,
      /provider-secret-token|query-secret|https?:\/\/|upstream-stack-secret|\/srv\/provider/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MaxAI rejects unsupported WAV input with a safe validation message", async () => {
  const provider = {
    id: "maxai",
    format: "maxai-stt",
    baseUrl: "https://maxai.example/gpt/speech_to_text",
    authType: "none",
    authHeader: "Authorization",
    models: [],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Unexpected MaxAI request");
  };
  try {
    const formData = new FormData();
    formData.append("model", "maxai/speech-to-text");
    formData.append("file", new File(["audio"], "audio.wav", { type: "audio/wav" }));
    const response = await handleAudioTranscription({
      formData,
      credentials: { connectionId: "connection-1" },
      resolvedProvider: provider,
      resolvedModel: "speech-to-text",
    });
    const payload = await response.json();

    assert.equal(response.status, 415);
    assert.equal(payload.error.code, 415);
    assert.equal(payload.error.message, "MaxAI transcription accepts WebM audio only");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
