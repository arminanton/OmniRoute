import { test } from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("groq-field-strip-wiring");
const { getForcedReasoningEffort, setForcedReasoningEffort } = await import(
  "../../open-sse/utils/reasoningRuleContext.ts"
);
const { getActiveOnPersist } = await import("../../open-sse/services/tokenRefresh.ts");
const { DefaultExecutor } = await import("../../open-sse/executors/default.ts");
const { extractReasoningIntent, resolveReasoningRoutingRule } = await import(
  "../../src/lib/reasoningRouting/policy.ts"
);

test.after(async () => {
  await harness.cleanup();
});

// ──────────────────────────────────────────────────────────────────────────────
// Task 2.3: Groq field-strip wiring in base.ts
// Verify that when provider === "groq", stripGroqUnsupportedFields is applied
// before the body is dispatched — i.e. the outgoing fetch body has neither
// messages[].name, logprobs, logit_bias, nor top_logprobs.
// ──────────────────────────────────────────────────────────────────────────────

test("Groq executor strips logprobs, logit_bias, top_logprobs from outgoing request", async () => {
  const executor = new DefaultExecutor("groq");
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
    capturedBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await executor.execute({
      model: "llama-3.3-70b-versatile",
      body: {
        messages: [{ role: "user", content: "hi" }],
        logprobs: true,
        logit_bias: { "1234": 5 },
        top_logprobs: 3,
      },
      stream: false,
      credentials: { apiKey: "groq-test-key" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(capturedBody !== null, "fetch should have been called");
  assert.equal("logprobs" in capturedBody!, false, "logprobs should be stripped");
  assert.equal("logit_bias" in capturedBody!, false, "logit_bias should be stripped");
  assert.equal("top_logprobs" in capturedBody!, false, "top_logprobs should be stripped");
});

test("Groq executor strips messages[].name from outgoing request", async () => {
  const executor = new DefaultExecutor("groq");
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
    capturedBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await executor.execute({
      model: "llama-3.3-70b-versatile",
      body: {
        messages: [
          { role: "user", content: "hi", name: "alice" },
          { role: "assistant", content: "hello" },
        ],
      },
      stream: false,
      credentials: { apiKey: "groq-test-key" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(capturedBody !== null, "fetch should have been called");
  const messages = capturedBody!.messages as Record<string, unknown>[];
  assert.equal("name" in messages[0], false, "name should be stripped from user message");
  assert.equal(messages[0].content, "hi");
  assert.equal(messages[0].role, "user");
  // Second message has no name — should be unchanged.
  assert.equal(messages[1].content, "hello");
});

test("Non-Groq executor does NOT strip logprobs or messages[].name", async () => {
  // Use openai (an OpenAI-compat provider) to confirm the strip is Groq-only.
  const executor = new DefaultExecutor("openai");
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
    capturedBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await executor.execute({
      model: "gpt-4.1",
      body: {
        messages: [{ role: "user", content: "hi", name: "bob" }],
        logprobs: true,
      },
      stream: false,
      credentials: { apiKey: "sk-openai-test-key" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(capturedBody !== null, "fetch should have been called");
  // logprobs passes through untouched for non-Groq providers.
  assert.equal((capturedBody! as Record<string, unknown>).logprobs, true);
  // name passes through untouched.
  const messages = capturedBody!.messages as Record<string, unknown>[];
  assert.equal(messages[0].name, "bob");
});

test("Groq GPT-OSS dispatch maps forced none to low and drops foreign reasoning envelopes", async () => {
  const executor = new DefaultExecutor("groq");
  const originalFetch = globalThis.fetch;
  const credentials = { apiKey: "groq-test-key" };
  setForcedReasoningEffort(credentials, "none");
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await executor.execute({
      model: "openai/gpt-oss-20b",
      body: {
        messages: [{ role: "user", content: "hello" }],
        reasoning: { effort: "none" },
        output_config: { effort: "none" },
      },
      stream: false,
      credentials,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(capturedBody, "the executor must dispatch a request");
  assert.equal(capturedBody.reasoning_effort, "low");
  assert.equal("reasoning" in capturedBody, false);
  assert.equal("output_config" in capturedBody, false);
  assert.deepEqual(credentials, { apiKey: "groq-test-key" });
});

test("Groq preserves transient forced effort across both proactive refresh paths", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | undefined;
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    for (const persistsInsideRefresh of [false, true]) {
      const credentials = { apiKey: "groq-test-key" };
      setForcedReasoningEffort(credentials, "none");
      const executor = new DefaultExecutor("groq");
      executor.needsRefresh = () => true;
      executor.refreshCredentials = async () => {
        const refreshed = { apiKey: "groq-refreshed-key" };
        if (persistsInsideRefresh) await getActiveOnPersist()?.(refreshed);
        return refreshed;
      };
      capturedBody = undefined;
      let persistedCredentials: Record<string, unknown> | undefined;

      await executor.execute({
        model: "openai/gpt-oss-20b",
        body: {
          messages: [{ role: "user", content: "hello" }],
          reasoning: { effort: "none" },
          output_config: { effort: "none" },
        },
        stream: false,
        credentials,
        onCredentialsRefreshed: persistsInsideRefresh
          ? (patch) => {
              persistedCredentials = patch;
            }
          : undefined,
      });

      assert.equal(capturedBody?.reasoning_effort, "low");
      assert.deepEqual(credentials, { apiKey: "groq-test-key" });
      assert.deepEqual(
        persistedCredentials,
        persistsInsideRefresh ? { apiKey: "groq-refreshed-key" } : undefined
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Groq connection forced-none rule survives BaseExecutor refresh for GPT-OSS", async () => {
  await harness.resetStorage();
  const connection = await harness.seedConnection("groq", { apiKey: "groq-original-key" });
  await harness.reasoningRulesDb.createReasoningRoutingRule({
    name: "Force GPT-OSS no-reasoning",
    description: "Groq maps forced none to low",
    scope: "connection",
    apiKeyId: null,
    comboId: null,
    connectionId: connection.id,
    modelPattern: null,
    sourceEffort: "high",
    requestTags: [],
    tagMatchMode: "all",
    effortMode: "force",
    targetEffort: "none",
    targetKind: "keep",
    targetModel: null,
    targetComboId: null,
    budgetAction: "preserve",
    budgetTokens: null,
    priority: 10,
    enabled: true,
  });

  const ExecutorPrototype = DefaultExecutor.prototype as any;
  const originalNeedsRefresh = ExecutorPrototype.needsRefresh;
  const originalRefreshCredentials = ExecutorPrototype.refreshCredentials;
  const originalExecute = ExecutorPrototype.execute;
  const originalFetch = globalThis.fetch;
  let refreshInput: Record<string, unknown> | undefined;
  let refreshReplacement: Record<string, unknown> | undefined;
  let capturedBody: Record<string, unknown> | undefined;
  let capturedSelectedConnectionIdAtExecutorEntry: unknown;
  let capturedForcedEffortAtExecutorEntry: string | undefined;
  let capturedAuthorization: string | null = null;

  ExecutorPrototype.needsRefresh = function (this: { provider: string }) {
    return this.provider === "groq";
  };
  ExecutorPrototype.refreshCredentials = async function (
    this: { provider: string },
    credentials: Record<string, unknown>
  ) {
    if (this.provider !== "groq") return null;
    refreshInput = credentials;
    refreshReplacement = { apiKey: "groq-refreshed-key" };
    return refreshReplacement;
  };
  ExecutorPrototype.execute = async function (
    this: unknown,
    options: { body?: Record<string, unknown>; credentials?: Record<string, unknown> }
  ) {
    capturedSelectedConnectionIdAtExecutorEntry = options.credentials?.connectionId;
    if (options.credentials) {
      capturedForcedEffortAtExecutorEntry =
        getForcedReasoningEffort(options.credentials) ?? undefined;
    }
    return originalExecute.call(this, options);
  };
  globalThis.fetch = async (_url: string | URL | Request, init: RequestInit = {}) => {
    capturedBody = JSON.parse(String(init.body));
    capturedAuthorization = new Headers(init.headers).get("authorization");
    return harness.buildOpenAIResponse("forced effort ok", "gpt-oss-20b");
  };

  const requestBody = {
    model: "groq/openai/gpt-oss-20b",
    stream: false,
    messages: [{ role: "user", content: "hello" }],
    reasoning_effort: "high",
  };

  // Check each routing premise before exercising the chat HTTP path. This keeps
  // fixture/DB/policy failures separate from executor refresh wiring failures.
  const persistedRules = await harness.reasoningRulesDb.getReasoningRoutingRules({
    enabledOnly: true,
  });
  assert.deepEqual(
    persistedRules.map(
      ({
        scope,
        connectionId,
        modelPattern,
        sourceEffort,
        effortMode,
        targetEffort,
        targetKind,
        targetModel,
      }) => ({
        scope,
        connectionId,
        modelPattern,
        sourceEffort,
        effortMode,
        targetEffort,
        targetKind,
        targetModel,
      })
    ),
    [
      {
        scope: "connection",
        connectionId: connection.id,
        modelPattern: null,
        sourceEffort: "high",
        effortMode: "force",
        targetEffort: "none",
        targetKind: "keep",
        targetModel: null,
      },
    ],
    "the enabled connection rule must persist with the fixture fields",
  );

  const reasoningIntent = extractReasoningIntent(requestBody.model, requestBody);
  assert.equal(reasoningIntent.model, requestBody.model);
  assert.equal(reasoningIntent.sourceEffort, "high");
  assert.equal(reasoningIntent.hasReasoningSignal, true);

  const directDecision = await resolveReasoningRoutingRule({
    sourceModel: reasoningIntent.model,
    sourceEffort: reasoningIntent.sourceEffort,
    hasReasoningSignal: reasoningIntent.hasReasoningSignal,
    hasThinkingBudget: reasoningIntent.hasThinkingBudget,
    connectionId: connection.id,
    connectionOnly: true,
  });
  assert.ok(directDecision, "the seeded connection-only rule must match the request");
  assert.equal(directDecision.rule.id, persistedRules[0].id);
  assert.equal(directDecision.rule.effortMode, "force");
  assert.equal(directDecision.targetEffort, "none");

  try {
    const response = await harness.handleChat(
      harness.buildRequest({
        body: requestBody,
        headers: { "x-omniroute-connection": connection.id },
      })
    );
    await response.json();

    assert.equal(response.status, 200);
    assert.equal(capturedSelectedConnectionIdAtExecutorEntry, connection.id);
    assert.equal(capturedForcedEffortAtExecutorEntry, "none");
    assert.equal(capturedBody?.reasoning_effort, "low");
    assert.equal("reasoning" in (capturedBody ?? {}), false);
    assert.equal("output_config" in (capturedBody ?? {}), false);
    assert.equal("_omnirouteReasoningRule" in (capturedBody ?? {}), false);
    assert.ok(refreshInput);
    assert.ok(refreshReplacement);
    assert.notEqual(refreshInput, refreshReplacement);
    assert.equal(capturedAuthorization, "Bearer groq-refreshed-key");
    assert.equal("reasoning" in requestBody, false);
    assert.equal(requestBody.reasoning_effort, "high");
    assert.equal("output_config" in requestBody, false);
  } finally {
    globalThis.fetch = originalFetch;
    ExecutorPrototype.needsRefresh = originalNeedsRefresh;
    ExecutorPrototype.refreshCredentials = originalRefreshCredentials;
    ExecutorPrototype.execute = originalExecute;
  }
});
