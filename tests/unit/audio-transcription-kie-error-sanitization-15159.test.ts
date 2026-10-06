import test from "node:test";
import assert from "node:assert/strict";

const { handleAudioTranscription } = await import("../../open-sse/handlers/audioTranscription.ts");

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
