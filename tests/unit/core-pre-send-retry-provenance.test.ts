import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";
import { BaseExecutor } from "../../open-sse/executors/base.ts";
import { initTranslators } from "../../open-sse/translator/index.ts";
import { noteGenerationDispatchPhase } from "../../open-sse/services/generationDispatchEvidence.ts";
import { shouldRetrySameAccountTransport } from "../../src/sse/services/sameAccountTransportRetry.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
initTranslators();
test.after(() => resetDbInstance());
const log = { debug() {}, info() {}, warn() {}, error() {} };
const body = { model: "openai/gpt-4.1", messages: [{ role: "user", content: "fixture" }] };
async function core(stream: boolean) {
  return handleChatCore({
    body: { ...body, stream },
    modelInfo: { provider: "openai", model: "gpt-4.1" },
    credentials: { apiKey: "synthetic-only" },
    log,
    connectionId: null,
    apiKeyInfo: { id: "fixture-only", noLog: true },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers: {} },
    cachedSettings: { compression: { enabled: false } },
    skipResourcePressureGuard: true,
  } as Parameters<typeof handleChatCore>[0]);
}
function mockExecutor(t: TestContext) {
  t.mock.method(BaseExecutor.prototype, "execute", async () => ({
    response: await fetch("https://fixture.invalid/v1/chat/completions", { method: "POST" }),
    url: "https://fixture.invalid/v1/chat/completions",
    headers: {},
    transformedBody: {},
  }));
}
for (const stream of [false, true]) {
  test(`actual Core preserves known pre-send ECONNRESET for ${stream ? "stream" : "JSON"} same-account policy`, async (t) => {
    const failure = Object.assign(new Error("fixture ECONNRESET before request start"), {
      code: "ECONNRESET",
    });
    noteGenerationDispatchPhase(failure, "transport_queue", false);
    t.mock.method(globalThis, "fetch", async () => {
      throw failure;
    });
    mockExecutor(t);
    const result = await core(stream);
    assert.equal(result.success, false);
    assert.equal(
      result.originalError,
      failure,
      "Core must retain positive local provenance, not only public text/code"
    );
    assert.equal(
      shouldRetrySameAccountTransport({
        status: result.status,
        errorText: result.error,
        errorCode: result.errorCode,
        errorType: result.errorType,
        originalError: result.originalError,
        attempt: 0,
      }),
      true
    );
    await result.response.text();
  });
}
for (const status of [502, 503, 504]) {
  test(`actual Core provider${status} JSON cannot acquire local pre-send provenance`, async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json(
        {
          error: {
            message: "fixture service capacity; ECONNRESET",
            code: "ECONNRESET",
            phase: "transport_queue",
            requestStarted: false,
          },
        },
        { status }
      )
    );
    mockExecutor(t);
    const result = await core(false);
    assert.equal(result.success, false);
    assert.equal(result.originalError, undefined);
    assert.equal(
      shouldRetrySameAccountTransport({
        status: result.status,
        errorText: result.error,
        errorCode: result.errorCode,
        errorType: result.errorType,
        originalError: result.originalError,
        attempt: 0,
      }),
      false
    );
    await result.response.text();
  });
}
