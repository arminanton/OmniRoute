/**
 * Task 4 handleChat flight charge: real POST /v1/messages with stamped
 * recorded body bytes. Serial so the process-wide ledger is not shared
 * with concurrent unit files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createChatPipelineHarness } from "../../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("flight-byte-handlechat-charge");
assert.ok(
  harness.TEST_DATA_DIR.includes("flight-byte-handlechat-charge") ||
    harness.TEST_DATA_DIR.includes("omniroute-"),
  "task-private harness DATA_DIR must be set before DB imports"
);

const { BaseExecutor, resetStorage, seedConnection } = harness;
const {
  DEFAULT_STREAM_FLOOR_DIVISOR,
  DEFAULT_STREAM_HOLD_FACTOR,
  estimateFlightBytes,
} = await import("../../../src/shared/middleware/admissionBudget.ts");
const { ChatAdmissionController, perConnectionAdmissionController } = await import(
  "../../../src/shared/middleware/chatBodyAdmission.ts"
);
const { setFlightChargeControllerForTests } = await import(
  "../../../src/shared/middleware/chargeFlightForChat.ts"
);
const messagesRoute = await import("../../../src/app/api/v1/messages/route.ts");
const completionsRoute = await import("../../../src/app/api/v1/chat/completions/route.ts");
const geminiRoute = await import("../../../src/app/api/v1beta/models/[...path]/route.ts");
const responsesRoute = await import("../../../src/app/api/v1/responses/route.ts");
const legacyCompletionsRoute = await import("../../../src/app/api/v1/completions/route.ts");
const relayCompletionsRoute = await import("../../../src/app/api/v1/relay/chat/completions/route.ts");
const { createRelayToken } = await import("../../../src/lib/db/relayProxies.ts");
const { addCustomModel } = await import("../../../src/lib/db/models.ts");
const {
  getAdaptiveAdmissionRuntime,
  reloadAdaptiveAdmissionRuntime,
  resetAdaptiveAdmissionRuntimeForTests,
} = await import("../../../open-sse/services/admission/runtime.ts");
const { reloadResourcePressureRuntime } = await import(
  "../../../open-sse/utils/resourcePressure.ts"
);

const originalFetch = globalThis.fetch;
const originalFlightBudgetEnabled = process.env.OMNIROUTE_CHAT_FLIGHT_BUDGET_ENABLED;
const MiB = 1024 ** 2;
const MODEL = "openai/gpt-4o-mini";

function reloadNormalResourcePressure() {
  reloadResourcePressureRuntime({
    heapThresholdMb: 10_000,
    immediateHeapUsedMb: () => 1,
    sample: async () => ({
      observedAtMs: Date.now(),
      v8: { heapUsedBytes: MiB, heapLimitBytes: 10_000 * MiB },
      process: {
        rssBytes: MiB,
        externalBytes: 0,
        arrayBuffersBytes: 0,
        availableBytes: null,
        constrainedBytes: null,
      },
      cgroup: { currentBytes: null, maxBytes: null, highBytes: null, fileBytes: null, events: null },
      psi: null,
    }),
  });
}

function hangingSseResponse(): Response {
  const chunk =
    'data: {"id":"chatcmpl-flight","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } }
  );
}

function smallStreamMessagesRequest(): Request {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 64,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  });
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Content-Length": String(Buffer.byteLength(body)),
    },
    body,
  });
}

test.beforeEach(async () => {
  process.env.OMNIROUTE_CHAT_FLIGHT_BUDGET_ENABLED = "true";
  BaseExecutor.RETRY_CONFIG.delayMs = 0;
  await resetStorage();
  resetAdaptiveAdmissionRuntimeForTests();
  reloadNormalResourcePressure();
  reloadAdaptiveAdmissionRuntime({
    config: {
      mode: "shadow",
      minLimit: 8,
      initialLimit: 64,
      maxLimit: 1000,
      maxQueueCount: 128,
      maxQueueCost: 2000,
      defaultMaxWaitMs: 5_000,
      windowMs: 1_000,
    },
    checkResourcePressure: () => null,
  });
  globalThis.fetch = originalFetch;
});

test.afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (originalFlightBudgetEnabled === undefined) {
    delete process.env.OMNIROUTE_CHAT_FLIGHT_BUDGET_ENABLED;
  } else {
    process.env.OMNIROUTE_CHAT_FLIGHT_BUDGET_ENABLED = originalFlightBudgetEnabled;
  }
  resetAdaptiveAdmissionRuntimeForTests();
  setFlightChargeControllerForTests(null);
  await resetStorage();
});

test.after(async () => {
  globalThis.fetch = originalFetch;
  resetAdaptiveAdmissionRuntimeForTests();
  await harness.cleanup();
});

test("Test 2: 100 STREAM_FLOOR holds then small /v1/messages stream is 503 flight_bytes_budget", async () => {
  await seedConnection("openai", { apiKey: "test-api-key-flight-2" });

  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return hangingSseResponse();
  };

  const controller = perConnectionAdmissionController.getController("anonymous");
  const floor = Math.floor(controller.maxFlightBytes / DEFAULT_STREAM_FLOOR_DIVISOR);
  assert.ok(floor > 0, "STREAM_FLOOR must be positive");

  const held = [];
  for (let i = 0; i < DEFAULT_STREAM_FLOOR_DIVISOR; i++) {
    const lease = controller.tryAcquireFlight(floor);
    assert.ok(lease, `STREAM_FLOOR hold ${i + 1} of ${DEFAULT_STREAM_FLOOR_DIVISOR} must fit`);
    held.push(lease);
  }
  assert.equal(controller.flightWaiting, 0);
  assert.ok(
    controller.maxFlightBytes - controller.flightBytes < floor,
    "100 STREAM_FLOOR holds must leave less than one floor of headroom"
  );

  try {
    const response = await messagesRoute.POST(smallStreamMessagesRequest(), {});
    assert.equal(response.status, 503);
    assert.match(String(response.headers.get("content-type") || ""), /application\/json/i);
    assert.ok(response.headers.get("Retry-After"));
    const payload = (await response.json()) as {
      error?: { code?: string; type?: string; reason?: string };
    };
    assert.equal(payload.error?.type, "server_error");
    assert.equal(payload.error?.code, "chat_admission_busy");
    assert.equal(payload.error?.reason, "flight_bytes_budget");
    assert.equal(fetchCalls, 0);
    assert.equal(getAdaptiveAdmissionRuntime().snapshot().activeCount, 0);
  } finally {
    for (const lease of held) lease.release();
  }

  assert.equal(controller.flightBytes, 0);
});

function streamMessagesRequest(body: unknown): Request {
  const json = JSON.stringify(body);
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "Content-Length": String(Buffer.byteLength(json)),
    },
    body: json,
  });
}

function flightControllerBlockedAtOriginalCharge(originalBytes: number) {
  const maxFlightBytes = originalBytes * DEFAULT_STREAM_HOLD_FACTOR ** 2;
  const charge = estimateFlightBytes(originalBytes, true, maxFlightBytes);
  assert.equal(charge, Math.floor(maxFlightBytes / DEFAULT_STREAM_HOLD_FACTOR));
  const controller = new ChatAdmissionController(20, undefined, undefined, undefined, undefined, {
    maxFlightBytes,
  });
  const blocker = controller.tryAcquireFlight(maxFlightBytes - charge + 1);
  assert.ok(blocker);
  setFlightChargeControllerForTests(controller);
  return { controller, blocker };
}

test("Task 4: v1 clone/rewrite routes use captured ingress bytes with wrong or absent Content-Length", async () => {
  await addCustomModel("codex", "gpt-5.5");
  const responsesBody = { model: "gpt-5.5", input: "x".repeat(512), stream: true };
  const responseProbe = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(JSON.stringify(responsesBody))),
      "x-omniroute-recorded-body-bytes": "1",
    },
    body: JSON.stringify(responsesBody),
  });
  const rewrittenResponses = await responsesRoute.withCodexPreferredModel(responseProbe);
  assert.equal(rewrittenResponses.body.model, "codex/gpt-5.5");
  assert.equal(rewrittenResponses.request.headers.get("Content-Length"), null);
  assert.equal(
    rewrittenResponses.request.headers.get("x-omniroute-recorded-body-bytes"),
    null
  );
  assert.deepEqual(await rewrittenResponses.request.json(), {
    ...responsesBody,
    model: "codex/gpt-5.5",
  });

  const completionBody = { model: MODEL, prompt: "x".repeat(512), stream: true };
  const { prompt, ...completionBodyRest } = completionBody;
  const rewrittenCompletionBody = {
    ...completionBodyRest,
    messages: [{ role: "user", content: prompt }],
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(rewrittenCompletionBody)) >
      Buffer.byteLength(JSON.stringify(completionBody)),
    "legacy prompt rewrite must differ from captured ingress bytes"
  );

  const relayToken = (() => {
    const requireDescriptor = Object.getOwnPropertyDescriptor(globalThis, "require");
    Object.defineProperty(globalThis, "require", {
      configurable: true,
      writable: true,
      value: createRequire(import.meta.url),
    });
    try {
      return createRelayToken({ name: "flight-stamp-clones", allowedModels: ["*"] });
    } finally {
      if (requireDescriptor) {
        Object.defineProperty(globalThis, "require", requireDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "require");
      }
    }
  })();
  const originalRelayBackend = process.env.OMNIROUTE_RELAY_BACKEND;
  process.env.OMNIROUTE_RELAY_BACKEND = "ts";
  globalThis.fetch = async () => {
    throw new Error("unexpected upstream fetch before flight-byte admission");
  };

  const cases = [
    {
      name: "/v1/responses model rewrite",
      url: "http://localhost/v1/responses",
      body: responsesBody,
      post: (request: Request) => responsesRoute.POST(request),
    },
    {
      name: "/v1/completions prompt rewrite",
      url: "http://localhost/v1/completions",
      body: completionBody,
      post: (request: Request) => legacyCompletionsRoute.POST(request),
    },
    {
      name: "/v1/relay/chat/completions request clone",
      url: "http://localhost/api/v1/relay/chat/completions",
      body: {
        model: MODEL,
        messages: [{ role: "user", content: "x".repeat(512) }],
        stream: true,
      },
      headers: { Authorization: `Bearer ${relayToken.rawToken}` },
      post: (request: Request) => relayCompletionsRoute.POST(request),
    },
  ];

  try {
    for (const path of cases) {
      const json = JSON.stringify(path.body);
      const originalBytes = Buffer.byteLength(json, "utf8");
      const contentLengthCases = [
        {
          name: "undercounted Content-Length",
          value: String(originalBytes - 17),
        },
        {
          name: "absent Content-Length",
          value: null,
        },
      ];

      // Exercise each route with untrusted length metadata. Route admission must
      // measure the body, stamp that count in its WeakMap, and transfer it across
      // each clone/rewrite; neither the inbound header nor the transformed body
      // is the flight-byte source.
      for (const contentLengthCase of contentLengthCases) {
        const scenario = `${path.name} (${contentLengthCase.name})`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "x-omniroute-recorded-body-bytes": "1",
          ...("headers" in path ? path.headers : {}),
        };
        if (contentLengthCase.value !== null) {
          headers["Content-Length"] = contentLengthCase.value;
          assert.notEqual(contentLengthCase.value, String(originalBytes));
        }

        const request = new Request(path.url, { method: "POST", headers, body: json });
        const { controller, blocker } = flightControllerBlockedAtOriginalCharge(originalBytes);
        try {
          const response = await path.post(request);
          assert.equal(response.status, 503, scenario);
          const payload = (await response.json()) as { error?: { reason?: string } };
          assert.equal(payload.error?.reason, "flight_bytes_budget", scenario);
          assert.equal(
            controller.flightBytes,
            controller.maxFlightBytes -
              estimateFlightBytes(originalBytes, true, controller.maxFlightBytes) +
              1,
            scenario
          );
        } finally {
          blocker.release();
          setFlightChargeControllerForTests(null);
        }
      }
    }
  } finally {
    if (originalRelayBackend === undefined) {
      delete process.env.OMNIROUTE_RELAY_BACKEND;
    } else {
      process.env.OMNIROUTE_RELAY_BACKEND = originalRelayBackend;
    }
  }
});

test("Test 5: STREAM_CEILING miss is 413 not ingest-budget copy", async () => {
  await seedConnection("openai", { apiKey: "test-api-key-flight-ceiling" });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return hangingSseResponse();
  };

  const tiny = new ChatAdmissionController(20, undefined, undefined, undefined, undefined, {
    maxFlightBytes: 1000,
  });
  setFlightChargeControllerForTests(tiny);
  const before = tiny.flightBytes;
  const bodyBytes = 400;
  assert.ok(
    bodyBytes * DEFAULT_STREAM_HOLD_FACTOR > Math.floor(1000 / DEFAULT_STREAM_HOLD_FACTOR),
    "fixture must sit above STREAM_CEILING"
  );

  const response = await messagesRoute.POST(
    streamMessagesRequest({
      model: MODEL,
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "y".repeat(bodyBytes) }],
    }),
    {}
  );
  const text = await response.text();
  assert.equal(response.status, 413);
  assert.doesNotMatch(text, /ingest/i);
  assert.match(text, /in-flight SSE hold budget/i);
  const payload = JSON.parse(text) as { error?: { code?: string; reason?: string } };
  assert.equal(payload.error?.code, "body_exceeds_budget");
  assert.equal(payload.error?.reason, "flight_ceiling");
  assert.equal(tiny.flightBytes, before);
  assert.equal(fetchCalls, 0);
});

test("Test 12: 200 short messages on a full flight ledger 503 with no waiters", async () => {
  await seedConnection("openai", { apiKey: "test-api-key-flight-heavy" });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return hangingSseResponse();
  };

  const controller = perConnectionAdmissionController.getController("anonymous");
  const floor = Math.floor(controller.maxFlightBytes / DEFAULT_STREAM_FLOOR_DIVISOR);
  const held = [];
  for (let i = 0; i < DEFAULT_STREAM_FLOOR_DIVISOR; i++) {
    const lease = controller.tryAcquireFlight(floor);
    assert.ok(lease);
    held.push(lease);
  }

  const messages = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: "x",
  }));
  const json = JSON.stringify({ model: MODEL, max_tokens: 64, stream: true, messages });
  assert.ok(Buffer.byteLength(json) < 256 * 1024, "body must stay under large-body threshold");

  try {
    const response = await messagesRoute.POST(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Content-Length": String(Buffer.byteLength(json)),
        },
        body: json,
      }),
      {}
    );
    assert.equal(response.status, 503);
    const payload = (await response.json()) as { error?: { reason?: string } };
    assert.equal(payload.error?.reason, "flight_bytes_budget");
    assert.equal(controller.flightWaiting, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    for (const lease of held) lease.release();
  }
});

test("Test 13: full ledger messages POST 503s without acquireFlightWithin", async () => {
  await seedConnection("openai", { apiKey: "test-api-key-flight-keepalive" });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return hangingSseResponse();
  };

  const controller = perConnectionAdmissionController.getController("anonymous");
  const floor = Math.floor(controller.maxFlightBytes / DEFAULT_STREAM_FLOOR_DIVISOR);
  const held = [];
  for (let i = 0; i < DEFAULT_STREAM_FLOOR_DIVISOR; i++) {
    const lease = controller.tryAcquireFlight(floor);
    assert.ok(lease);
    held.push(lease);
  }

  const started = Date.now();
  try {
    const response = await messagesRoute.POST(smallStreamMessagesRequest(), {});
    const elapsed = Date.now() - started;
    assert.equal(response.status, 503);
    assert.ok(response.headers.get("Retry-After"));
    const payload = (await response.json()) as { error?: { reason?: string } };
    assert.equal(payload.error?.reason, "flight_bytes_budget");
    assert.ok(elapsed < 5_000, `must not queue; elapsed=${elapsed}`);
    assert.equal(controller.flightWaiting, 0);
    assert.equal(fetchCalls, 0);
  } finally {
    for (const lease of held) lease.release();
  }
});

function mixedAcceptMessagesRequest(body: unknown, extraHeaders: Record<string, string> = {}): Request {
  const json = JSON.stringify(body);
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Content-Length": String(Buffer.byteLength(json)),
      ...extraHeaders,
    },
    body: json,
  });
}

function fillFlight(controller: InstanceType<typeof ChatAdmissionController>) {
  const floor = Math.floor(controller.maxFlightBytes / DEFAULT_STREAM_FLOOR_DIVISOR);
  const held = [];
  for (let i = 0; i < DEFAULT_STREAM_FLOOR_DIVISOR; i++) {
    const lease = controller.tryAcquireFlight(floor);
    assert.ok(lease);
    held.push(lease);
  }
  return held;
}

async function waitForFlightDrain(
  controller: InstanceType<typeof ChatAdmissionController>,
  timeoutMs = 2_000
): Promise<void> {
  const started = Date.now();
  while (controller.flightBytes > 0) {
    assert.ok(Date.now() - started < timeoutMs, `flightBytes still ${controller.flightBytes}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("Test 11: mixed Accept messages, completions, and Gemini share one flight ledger; usage command stays JSON", async () => {
  await seedConnection("openai", { apiKey: "test-api-key-flight-shared" });
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return hangingSseResponse();
  };

  const controller = perConnectionAdmissionController.getController("anonymous");
  const before = controller.flightBytes;
  const live: Response[] = [];

  try {
    const messagesRes = await messagesRoute.POST(
      mixedAcceptMessagesRequest({
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi-messages" }],
      }),
      {}
    );
    live.push(messagesRes);
    assert.equal(messagesRes.status, 200);
    assert.ok(controller.flightBytes > before, "mixed Accept /v1/messages must charge");

    const afterMessages = controller.flightBytes;
    const completionsBody = JSON.stringify({
      model: MODEL,
      stream: true,
      messages: [{ role: "user", content: "hi-completions" }],
    });
    const completionsRes = await completionsRoute.POST(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Content-Length": String(Buffer.byteLength(completionsBody)),
        },
        body: completionsBody,
      })
    );
    live.push(completionsRes);
    assert.equal(completionsRes.status, 200);
    assert.ok(controller.flightBytes > afterMessages, "completions stream must charge the same ledger");

    const afterCompletions = controller.flightBytes;
    const geminiBody = {
      contents: [{ role: "user", parts: [{ text: "hi-gemini" }] }],
    };
    const geminiJson = JSON.stringify(geminiBody);
    const geminiRes = await geminiRoute.POST(
      new Request("http://localhost/v1beta/models/openai/gpt-4o-mini:streamGenerateContent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(geminiJson)),
        },
        body: geminiJson,
      }),
      { params: Promise.resolve({ path: ["openai", "gpt-4o-mini:streamGenerateContent"] }) }
    );
    live.push(geminiRes);
    assert.equal(geminiRes.status, 200);
    assert.ok(controller.flightBytes > afterCompletions, "Gemini streamGenerateContent must charge the same ledger");
  } finally {
    for (const res of live) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
    }
  }
  await waitForFlightDrain(controller);

  const held = fillFlight(controller);
  const fullBytes = controller.flightBytes;
  let tryCalls = 0;
  const origTry = controller.tryAcquireFlight.bind(controller);
  controller.tryAcquireFlight = (bytes: number) => {
    tryCalls += 1;
    return origTry(bytes);
  };

  try {
    const usageOnFull = await messagesRoute.POST(
      mixedAcceptMessagesRequest({
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "@@om-usage" }],
      }),
      {}
    );
    assert.equal(usageOnFull.status, 200);
    assert.match(String(usageOnFull.headers.get("content-type") || ""), /application\/json/i);
    assert.equal(tryCalls, 0);
    assert.equal(controller.flightBytes, fullBytes);
    assert.equal(fetchCalls, 3);
  } finally {
    controller.tryAcquireFlight = origTry;
    for (const lease of held) lease.release();
  }

  const emptyBytes = controller.flightBytes;
  tryCalls = 0;
  const origTry2 = controller.tryAcquireFlight.bind(controller);
  controller.tryAcquireFlight = (bytes: number) => {
    tryCalls += 1;
    return origTry2(bytes);
  };
  try {
    const usageOnEmpty = await messagesRoute.POST(
      mixedAcceptMessagesRequest({
        model: MODEL,
        max_tokens: 64,
        messages: [{ role: "user", content: "@@om-usage" }],
      }),
      {}
    );
    assert.equal(usageOnEmpty.status, 200);
    assert.match(String(usageOnEmpty.headers.get("content-type") || ""), /application\/json/i);
    assert.equal(tryCalls, 0);
    assert.equal(controller.flightBytes, emptyBytes);
    assert.equal(fetchCalls, 3);
  } finally {
    controller.tryAcquireFlight = origTry2;
  }
});
