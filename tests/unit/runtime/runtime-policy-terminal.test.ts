import assert from "node:assert/strict";
import test from "node:test";
import type { ComboLike } from "../../../open-sse/services/combo/types.ts";
import { createChatPipelineHarness } from "../../integration/_chatPipelineHarness.ts";

// The harness sets a new disposable DATA_DIR before loading any DB consumer.
// Never use a live provider, helper, policy mount, or the operator's database.
const originalFetch = globalThis.fetch;
const offlineFetch: typeof fetch = async () => {
  throw new Error("Unexpected network access in runtime policy terminal fixture");
};
globalThis.fetch = offlineFetch;
const harness = await createChatPipelineHarness("runtime-policy-terminal");
const {
  RuntimePolicyError,
  isRuntimePolicyError,
  markRuntimePolicyResponse,
  isRuntimePolicyResponse,
} = await import("../../../src/shared/runtimePolicy.ts");
const { runtimePolicyErrorResponse } = await import("../../../open-sse/utils/error.ts");
const { isExhaustedNetworkResponse, markExhaustedNetworkResponse } =
  await import("../../../open-sse/services/exhaustedNetworkResponse.ts");
const { decideProxyResolutionFailure, withSelectedConnectionHeader, checkPipelineGates } =
  await import("../../../src/sse/handlers/chatHelpers.ts");
const { getCooldownAwareRetryDecision } =
  await import("../../../src/sse/services/cooldownAwareRetry.ts");
const { handlePipelineChat } = await import("../../../open-sse/services/pipeline.ts");
const { handleFusionChat } = await import("../../../open-sse/services/fusion.ts");
const { handleComboChat, resolveComboTargets } =
  await import("../../../open-sse/services/combo.ts");
const { attemptCompatRejectedFallback } =
  await import("../../../open-sse/services/combo/comboCompatFallback.ts");
const { executeRuntimeUnitCombo } =
  await import("../../../open-sse/services/combo/runtimeUnits.ts");
const { tryPinnedModelDispatch } =
  await import("../../../open-sse/services/combo/dispatchPrelude.ts");
const { resolveComboSetupConfig } = await import("../../../open-sse/services/comboConfig.ts");
const { getCircuitBreaker } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { getProviderConnectionById } = await import("../../../src/lib/db/providers.ts");
const { getAllModelLockouts } = await import("../../../open-sse/services/accountFallback.ts");
const { clearCooldownState, getCooldownEntryCount } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };
const body = { messages: [{ role: "user", content: "synthetic terminal denial" }] };
const models = ["fixture-a/first", "fixture-b/second"];
const retrySettings = {
  enabled: true,
  maxRetries: 2,
  maxRetryWaitSec: 2,
  maxRetryWaitMs: 2_000,
  budgetMs: 4_000,
};

function publicFailure(contentType = "application/json", status = 503): Response {
  const error = { error: { code: "OMNI_RUNTIME_POLICY_DENIED", message: "proxy-forbidden" } };
  return new Response(
    contentType === "text/event-stream"
      ? `data: ${JSON.stringify(error)}\n\n`
      : JSON.stringify(error),
    { status, headers: { "content-type": contentType } }
  );
}

function combo(strategy = "priority"): ComboLike {
  return {
    name: `runtime-policy-${strategy}`,
    strategy,
    models,
    config: { maxRetries: 2, retryDelayMs: 0, concurrencyPerModel: 1, queueTimeoutMs: 100 },
  };
}

test.beforeEach(async () => {
  await harness.resetStorage();
  globalThis.fetch = offlineFetch;
  clearCooldownState();
  harness.BaseExecutor.RETRY_CONFIG.delayMs = 0;
});
test.after(async () => {
  await harness.cleanup();
  globalThis.fetch = originalFetch;
});

test("safe policy response is branded locally, sanitized, and not network exhaustion", async () => {
  const response = runtimePolicyErrorResponse();
  assert.equal(response.status, 403);
  assert.equal(isRuntimePolicyResponse(response), true);
  assert.equal(isExhaustedNetworkResponse(response), false);
  assert.equal(response.headers.has("retry-after"), false);
  const parsed = await response.json();
  assert.equal(parsed.error.code, "OMNI_RUNTIME_POLICY_DENIED");
  assert.equal(parsed.error.message, "Request denied by runtime policy.");
  assert.doesNotMatch(JSON.stringify(parsed), /https?:|token=|at \/|\.json/);
  assert.equal(isRuntimePolicyResponse(publicFailure()), false);
  assert.equal(isRuntimePolicyResponse(markExhaustedNetworkResponse(publicFailure())), false);
  assert.equal(
    isRuntimePolicyError({ code: "OMNI_RUNTIME_POLICY_DENIED", reason: "proxy-forbidden" }),
    false
  );
});

test("PROXY_FAIL_OPEN never swallows a local denial; ordinary errors keep fail-open", () => {
  const denied = new RuntimePolicyError("proxy-forbidden");
  assert.throws(
    () => decideProxyResolutionFailure(denied, { PROXY_FAIL_OPEN: "true" }),
    (error) => error === denied
  );
  const spoof = Object.assign(new Error("OMNI_RUNTIME_POLICY_DENIED proxy-forbidden"), {
    code: "OMNI_RUNTIME_POLICY_DENIED",
    reason: "proxy-forbidden",
  });
  assert.equal(decideProxyResolutionFailure(spoof, { PROXY_FAIL_OPEN: "true" }), null);
  assert.throws(
    () => decideProxyResolutionFailure(spoof, {}),
    (error) => error === spoof
  );
});

test("selected-connection header cloning retains the local response brand", () => {
  // Response.redirect has immutable headers; there is no network access.
  const response = markRuntimePolicyResponse(Response.redirect("https://fixture.example.invalid"));
  const wrapped = withSelectedConnectionHeader(response, "fixture-connection");
  assert.notEqual(wrapped, response);
  assert.equal(isRuntimePolicyResponse(wrapped), true);
  assert.equal(wrapped.headers.get("X-OmniRoute-Selected-Connection-Id"), "fixture-connection");
});

test("cooldown retry uses local provenance, never provider code or message strings", () => {
  const args = { retryAfter: new Date(Date.now() + 100), settings: retrySettings, attempt: 0 };
  assert.equal(
    getCooldownAwareRetryDecision({
      ...args,
      originalError: new RuntimePolicyError("proxy-forbidden"),
    }).shouldRetry,
    false
  );
  assert.equal(
    getCooldownAwareRetryDecision({ ...args, response: markRuntimePolicyResponse(publicFailure()) })
      .shouldRetry,
    false
  );
  assert.equal(
    getCooldownAwareRetryDecision({
      ...args,
      failureCode: "OMNI_RUNTIME_POLICY_DENIED",
      failureText: "proxy-forbidden",
      response: publicFailure(),
    }).shouldRetry,
    true
  );
});

test("provider breaker does not count a thrown local denial", async () => {
  await checkPipelineGates("fixture-a", "first", { providerProfile: {} });
  const breaker = getCircuitBreaker("fixture-a");
  const denied = new RuntimePolicyError("proxy-forbidden");
  await assert.rejects(
    breaker.execute(async () => {
      throw denied;
    }),
    (error) => error === denied
  );
  assert.equal(breaker.getStatus().failureCount, 0);
  await assert.rejects(
    breaker.execute(async () => {
      throw new Error("ordinary outage");
    })
  );
  assert.equal(breaker.getStatus().failureCount, 1);
});

for (const contentType of ["application/json", "text/event-stream"]) {
  test(`pipeline ${contentType} stops before retry or next stage`, async () => {
    const denied = markRuntimePolicyResponse(publicFailure(contentType));
    const calls: string[] = [];
    const response = await handlePipelineChat({
      body,
      steps: models.map((model) => ({ model })),
      maxRetries: 2,
      retryDelayMs: 0,
      log,
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        return denied;
      },
    });
    assert.equal(response, denied);
    assert.deepEqual(calls, [models[0]]);
    assert.equal(denied.bodyUsed, false);
  });

  for (const strategy of ["priority", "round-robin"]) {
    test(`${strategy} ${contentType} stops before retry, target rotation, or health penalty`, async () => {
      const denied = markRuntimePolicyResponse(publicFailure(contentType));
      const calls: string[] = [];
      const locks = getAllModelLockouts();
      const response = await handleComboChat({
        body,
        combo: combo(strategy),
        log,
        isModelAvailable: async () => true,
        handleSingleModel: async (_body, model) => {
          calls.push(model);
          return denied;
        },
      });
      assert.equal(response, denied);
      assert.equal(calls.length, 1);
      assert.ok(models.includes(calls[0]));
      assert.equal(denied.bodyUsed, false);
      assert.equal(isExhaustedNetworkResponse(response), false);
      assert.equal(getCircuitBreaker("fixture-a").getStatus().failureCount, 0);
      assert.equal(getCooldownEntryCount(), 0);
      assert.deepEqual(getAllModelLockouts(), locks);
    });
  }
}

test("pipeline checks denial again after an ordinary transient retry", async () => {
  const denied = markRuntimePolicyResponse(publicFailure());
  let calls = 0;
  const response = await handlePipelineChat({
    body,
    steps: models.map((model) => ({ model })),
    maxRetries: 2,
    retryDelayMs: 0,
    log,
    handleSingleModel: async () => (++calls === 1 ? publicFailure() : denied),
  });
  assert.equal(response, denied);
  assert.equal(calls, 2);
});

test("public policy-looking strings do not disable ordinary pipeline retry", async () => {
  let calls = 0;
  const response = await handlePipelineChat({
    body,
    steps: models.map((model) => ({ model })),
    maxRetries: 1,
    retryDelayMs: 0,
    log,
    handleSingleModel: async () =>
      ++calls === 1 ? publicFailure() : harness.buildOpenAIResponse("ok"),
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 3);
  assert.equal(isRuntimePolicyResponse(response), false);
});

for (const thrown of [false, true]) {
  test(`fusion ${thrown ? "thrown denial" : "denied response"} stops before judge or single-survivor redispatch`, async () => {
    const denied = markRuntimePolicyResponse(publicFailure());
    const calls: string[] = [];
    const response = await handleFusionChat({
      body,
      models,
      log,
      tuning: { minPanel: 1, stragglerGraceMs: 0, panelHardTimeoutMs: 100 },
      handleSingleModel: async (_body, model) => {
        calls.push(model);
        if (model === models[0]) {
          if (thrown) throw new RuntimePolicyError("helper-unapproved");
          return denied;
        }
        return harness.buildOpenAIResponse("healthy panel member");
      },
    });
    assert.equal(isRuntimePolicyResponse(response), true);
    if (!thrown) assert.equal(response, denied);
    assert.deepEqual(calls, models, "parallel panel may start; no later judge/fallback dispatch");
  });
}

test("compatibility fallback stops on the first local denial", async () => {
  const denied = markRuntimePolicyResponse(publicFailure());
  const calls: string[] = [];
  const response = await attemptCompatRejectedFallback(resolveComboTargets(combo(), null), body, {
    strategy: "priority",
    log,
    isModelAvailable: async () => true,
    handleSingleModel: async (_body, model) => {
      calls.push(model);
      return denied;
    },
  });
  assert.equal(response, denied);
  assert.deepEqual(calls, [models[0]]);
});

test("nested runtime units keep a denial out of retry and quota classification", async () => {
  const denied = markRuntimePolicyResponse(publicFailure());
  const calls: string[] = [];
  const handleSingleModel = async (_body: Record<string, unknown>, model: string) => {
    calls.push(model);
    return denied;
  };
  const response = await executeRuntimeUnitCombo({
    body,
    combo: combo(),
    strategy: "priority",
    units: resolveComboTargets(combo(), null),
    handleSingleModel,
    log,
    isModelAvailable: async () => true,
    config: { maxRetries: 2, retryDelayMs: 0 },
    allCombos: [],
    nesting: {
      depth: 0,
      maxDepth: 4,
      visitedComboNames: [],
      rootComboName: "fixture-root",
      attemptBudget: { count: 0, limit: 10 },
    },
    baseOptions: { body, combo: combo(), handleSingleModel, log },
    runCombo: async () => {
      throw new Error("unexpected nested fallback");
    },
  });
  assert.equal(response.response, denied);
  assert.deepEqual(calls, [models[0]]);
  assert.equal(denied.bodyUsed, false);
});

for (const thrown of [false, true]) {
  test(`context-cache pin preserves ${thrown ? "thrown" : "returned"} denial without falling through`, async () => {
    await harness.seedConnection("fixture-a");
    const denied = markRuntimePolicyResponse(publicFailure());
    const response = await tryPinnedModelDispatch({
      body,
      combo: combo(),
      pinnedModel: models[0],
      allCombos: [],
      config: resolveComboSetupConfig(combo(), {}),
      clientRequestedStream: false,
      log,
      handleSingleModelWithTimeout: async () => {
        if (thrown) throw new RuntimePolicyError("entrypoint-unapproved");
        return denied;
      },
    });
    assert.equal(isRuntimePolicyResponse(response), true);
    if (!thrown) assert.equal(response, denied);
  });
}

for (const stream of [false, true]) {
  for (const useCombo of [false, true]) {
    test(`chat ${useCombo ? "combo" : "single"} ${stream ? "SSE" : "JSON"} denial stops account/model/global fallback and health penalties`, async () => {
      const first = await harness.seedConnection("openai", {
        apiKey: "sk-synthetic-policy-first",
        priority: 1,
      });
      const second = await harness.seedConnection("openai", {
        apiKey: "sk-synthetic-policy-second",
        priority: 2,
      });
      await harness.seedConnection("nvidia", { apiKey: "sk-synthetic-global-unused" });
      await harness.settingsDb.updateSettings({
        requestRetry: 2,
        maxRetryIntervalSec: 1,
        globalFallbackModel: "nvidia/openai/gpt-oss-120b",
      });
      if (useCombo)
        await harness.combosDb.createCombo({
          name: "synthetic-policy-route",
          strategy: "priority",
          models: ["openai/gpt-4.1", "nvidia/openai/gpt-oss-120b"],
          config: { maxRetries: 2, retryDelayMs: 0 },
        });
      let sends = 0;
      globalThis.fetch = async () => {
        sends++;
        throw new RuntimePolicyError("proxy-forbidden");
      };
      const response = await harness.handleChat(
        harness.buildRequest({
          body: { ...body, stream, model: useCombo ? "synthetic-policy-route" : "openai/gpt-4.1" },
        })
      );
      assert.equal(response.status, 403);
      assert.equal(sends, 1, "no account, combo, or global fallback after denial");
      assert.equal(isExhaustedNetworkResponse(response), false);
      if (!stream) assert.equal(isRuntimePolicyResponse(response), true);
      const text = await response.text();
      assert.match(text, /OMNI_RUNTIME_POLICY_DENIED/);
      assert.doesNotMatch(text, /https?:|sk-synthetic|at \/|\.json/);
      assert.equal(getCircuitBreaker("openai").getStatus().failureCount, 0);
      assert.equal(getCooldownEntryCount(), 0);
      for (const connection of [first, second]) {
        const after = await getProviderConnectionById(String(connection.id));
        assert.equal(after?.testStatus, "active");
        assert.equal(Boolean(after?.rateLimitedUntil), false);
      }
    });
  }
}

for (const timeoutMs of [0, 500]) {
  test(`combo timeout adapter preserves thrown denial (timeout=${timeoutMs})`, async () => {
    const { buildTargetTimeoutRunner } =
      await import("../../../open-sse/services/combo/targetTimeoutRunner.ts");
    let calls = 0;
    const runner = buildTargetTimeoutRunner({
      comboTargetTimeoutMs: timeoutMs,
      log,
      handleSingleModel: async () => {
        calls++;
        throw new RuntimePolicyError("proxy-forbidden");
      },
    });
    const response = await runner(body, models[0]);
    assert.equal(isRuntimePolicyResponse(response), true);
    assert.equal(response.status, 403);
    assert.equal(calls, 1);
  });
}

for (const kind of ["throw", "response", "ordinary"] as const) {
  test(`native-to-proxy executor fallback handles ${kind} without confusing provenance`, async (t) => {
    const { getExecutor } = await import("../../../open-sse/executors/index.ts");
    const { upsertUpstreamProxyConfig } = await import("../../../src/lib/db/upstreamProxy.ts");
    const { clearUpstreamProxyConfigCache } =
      await import("../../../open-sse/handlers/chatCore/comboContextCache.ts");
    const { resolveExecutorWithProxy } =
      await import("../../../open-sse/handlers/chatCore/executorProxy.ts");
    await upsertUpstreamProxyConfig({ providerId: "openai", enabled: true, mode: "fallback" });
    clearUpstreamProxyConfigCache("openai");
    t.after(() => clearUpstreamProxyConfigCache("openai"));
    const native = await getExecutor("openai");
    const fallback = await getExecutor("cliproxyapi");
    const deniedError = new RuntimePolicyError("proxy-forbidden");
    const denied = markRuntimePolicyResponse(publicFailure());
    let nativeCalls = 0;
    let fallbackCalls = 0;
    t.mock.method(native, "execute", async () => {
      nativeCalls++;
      if (kind === "throw") throw deniedError;
      return {
        response: kind === "response" ? denied : publicFailure(),
        url: "",
        headers: {},
        transformedBody: body,
      };
    });
    t.mock.method(fallback, "execute", async () => {
      fallbackCalls++;
      return {
        response: harness.buildOpenAIResponse("ordinary fallback"),
        url: "",
        headers: {},
        transformedBody: body,
      };
    });
    const wrapper = await resolveExecutorWithProxy("openai");
    const pending = wrapper.execute({ model: "gpt-4.1", body, stream: false, credentials: {} });
    if (kind === "throw") await assert.rejects(pending, (error) => error === deniedError);
    else {
      const result = await pending;
      assert.ok(!(result instanceof Response));
      if (kind === "response") assert.equal(result.response, denied);
      else assert.equal(result.response.status, 200);
    }
    assert.equal(nativeCalls, 1);
    assert.equal(fallbackCalls, kind === "ordinary" ? 1 : 0);
  });
}

for (const stream of [false, true]) {
  test(`chat ${stream ? "SSE" : "JSON"} preserves a locally marked executor response before auth refresh or key-health changes`, async (t) => {
    const { getExecutor } = await import("../../../open-sse/executors/index.ts");
    const first = await harness.seedConnection("openai", { apiKey: "sk-synthetic-local-response" });
    const executor = await getExecutor("openai");
    const denied = runtimePolicyErrorResponse();
    let calls = 0;
    let refreshes = 0;
    t.mock.method(executor, "execute", async () => {
      calls++;
      return { response: denied, url: "", headers: {}, transformedBody: body };
    });
    t.mock.method(executor, "refreshCredentials", async () => {
      refreshes++;
      return null;
    });
    const response = await harness.handleChat(
      harness.buildRequest({ body: { ...body, stream, model: "openai/gpt-4.1" } })
    );
    assert.equal(response.status, 403);
    assert.equal(calls, 1);
    assert.equal(refreshes, 0);
    if (!stream) assert.equal(isRuntimePolicyResponse(response), true);
    assert.match(await response.text(), /OMNI_RUNTIME_POLICY_DENIED/);
    assert.equal(getCircuitBreaker("openai").getStatus().failureCount, 0);
    const connection = await getProviderConnectionById(String(first.id));
    assert.equal(connection?.testStatus, "active");
    assert.equal(Boolean(connection?.rateLimitedUntil), false);
  });
}

for (const failure of [
  "model-unavailable",
  "context-overflow",
  "empty-content",
  "clinepass",
] as const) {
  for (const thrown of [false, true]) {
    test(`non-stream ${failure} recovery propagates ${thrown ? "thrown" : "returned"} denial`, async () => {
      const { runNonStreamingProviderLeg } =
        await import("../../../open-sse/handlers/chatCore/nonStreamingProviderLeg.ts");
      const denied = runtimePolicyErrorResponse();
      const error = new RuntimePolicyError("entrypoint-unapproved");
      let calls = 0;
      const initial =
        failure === "model-unavailable"
          ? Response.json({ error: { message: "model_not_found" } }, { status: 404 })
          : failure === "context-overflow"
            ? Response.json(
                { error: { message: "maximum context length exceeded" } },
                { status: 400 }
              )
            : failure === "clinepass"
              ? Response.json({ success: false, error: "empty content" })
              : harness.buildOpenAIResponse("");
      const pending = runNonStreamingProviderLeg({
        phase: "initial",
        sourceBody: body,
        translatedBody: body,
        provider: failure === "clinepass" ? "clinepass" : "gemini",
        model: "gemini-3-pro",
        connectionId: "fixture-connection",
        allowAccountRotation: true,
        allowModelFallback: true,
        setRequestWireState: noop,
        sleep: async () => {},
        executeProviderRequest: async () => {
          calls++;
          if (calls > 1 && thrown) throw error;
          return {
            response: calls === 1 ? initial : denied,
            url: "",
            headers: {},
            transformedBody: body,
          };
        },
      });
      if (thrown) await assert.rejects(pending, (actual) => actual === error);
      else {
        const result = await pending;
        assert.equal(result.kind, "error");
        if (result.kind === "error") assert.equal(result.result.response, denied);
        assert.equal(denied.bodyUsed, false);
      }
      assert.equal(calls, 2, "the first ordinary failure may recover; denial stops further sends");
    });
  }
}

for (const provenance of ["error", "originalError", "response", "public-string"] as const) {
  test(`image account retry recognizes ${provenance} without trusting public strings`, async () => {
    const { executeImageWithCredentialFallback } =
      await import("../../../src/sse/services/imageCredentialRetry.ts");
    const denied = new RuntimePolicyError("proxy-forbidden");
    const failure = {
      success: false,
      status: 401,
      retryable: true,
      ...(provenance === "response"
        ? { response: runtimePolicyErrorResponse() }
        : provenance === "originalError"
          ? { originalError: denied }
          : { error: provenance === "error" ? denied : "OMNI_RUNTIME_POLICY_DENIED" }),
    };
    let calls = 0;
    let selections = 0;
    const result = await executeImageWithCredentialFallback({
      provider: "fixture-image",
      requestedModel: "fixture-model",
      credentials: { connectionId: "fixture-first" },
      execute: async () => {
        calls++;
        return calls === 1 ? failure : { success: true };
      },
      selectNextCredentials: async () => {
        selections++;
        return { connectionId: "fixture-second" };
      },
    });
    assert.equal(calls, provenance === "public-string" ? 2 : 1);
    assert.equal(selections, provenance === "public-string" ? 1 : 0);
    if (provenance !== "public-string") assert.equal(result.result, failure);
  });
}

test("image credential refresh catch never rotates after a local policy denial", async () => {
  const { executeImageWithCredentialFallback } =
    await import("../../../src/sse/services/imageCredentialRetry.ts");
  const denied = new RuntimePolicyError("proxy-forbidden");
  let selections = 0;
  let calls = 0;
  // Credential materialization inside checkAndRefreshToken fails before any I/O.
  const credentials = {
    connectionId: "fixture-first",
    get expiresAt() {
      throw denied;
    },
  };
  await assert.rejects(
    executeImageWithCredentialFallback({
      provider: "fixture-image",
      requestedModel: "fixture-model",
      credentials,
      execute: async () => {
        calls++;
        return { success: true };
      },
      selectNextCredentials: async () => {
        selections++;
        return null;
      },
    }),
    (error) => error === denied
  );
  assert.equal(calls, 0);
  assert.equal(selections, 0);
});

for (const thrown of [false, true]) {
  test(`smart pipeline stops a ${thrown ? "thrown" : "returned"} denial before later stages/reflection`, async () => {
    const { handlePipelineCombo } =
      await import("../../../open-sse/services/autoCombo/pipelineRouter.ts");
    const denied = runtimePolicyErrorResponse();
    let calls = 0;
    const response = await handlePipelineCombo({
      body: {
        messages: [
          {
            role: "user",
            content: "Write a Python function to sort a list and explain its algorithm.",
          },
        ],
      },
      combo: {
        models,
        config: {
          pipeline_enabled: true,
          skip_pipeline_for_tokens_under: 0,
          max_reflection_loops: 3,
        },
      },
      log,
      settings: {},
      handleChatCore: async () => {
        calls++;
        if (thrown) throw new RuntimePolicyError("entrypoint-unapproved");
        return denied;
      },
    });
    assert.equal(isRuntimePolicyResponse(response), true);
    if (!thrown) assert.equal(response, denied);
    assert.equal(calls, 1);
    assert.equal(denied.bodyUsed, false);
  });

  test(`thinking-signature recovery preserves a ${thrown ? "thrown" : "returned"} denial`, async () => {
    const { recoverAnthropicThinkingSignature } =
      await import("../../../open-sse/handlers/chatCore/thinkingSignatureRecovery.ts");
    const denied = runtimePolicyErrorResponse();
    const error = new RuntimePolicyError("entrypoint-unapproved");
    let calls = 0;
    let parsed = 0;
    const pending = recoverAnthropicThinkingSignature({
      provider: "claude",
      statusCode: 400,
      message: "invalid signature in thinking block",
      body: {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "old" },
              { type: "text", text: "answer" },
            ],
          },
          { role: "user", content: "next" },
        ],
      },
      execute: async () => {
        calls++;
        if (thrown) throw error;
        return { response: denied };
      },
      parseError: async () => {
        parsed++;
        throw new Error("must not consume policy response");
      },
    });
    if (thrown) await assert.rejects(pending, (actual) => actual === error);
    else {
      const result = await pending;
      assert.equal(result.execution?.response, denied);
      assert.equal(result.error, null);
      assert.equal(denied.bodyUsed, false);
    }
    assert.equal(calls, 1);
    assert.equal(parsed, 0);
  });
}

function fixtureStream(chunks: string[], failure?: unknown): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
      else if (failure) controller.error(failure);
      else controller.close();
    },
  });
}

for (const responseDenial of [false, true]) {
  for (const phase of ["read", "reopen", "continue", "continue-read"] as const) {
    test(`stream ${phase} stops a local ${responseDenial ? "response" : "error"} denial and finalizes once`, async () => {
      const { createRecoverableStream, isRetryableStreamError } =
        await import("../../../open-sse/services/streamRecovery.ts");
      const denied = responseDenial
        ? runtimePolicyErrorResponse()
        : new RuntimePolicyError("proxy-forbidden");
      assert.equal(isRetryableStreamError(denied), false);
      const largeText = "x".repeat(100_000);
      const initial = phase.startsWith("continue")
        ? fixtureStream([
            `data: ${JSON.stringify({ choices: [{ delta: { content: largeText } }] })}\n\n`,
          ])
        : fixtureStream([], phase === "read" ? denied : undefined);
      let sends = 0;
      let finalized = 0;
      const stream = createRecoverableStream(
        initial,
        async () => {
          sends++;
          throw denied;
        },
        {
          finalize: () => {
            finalized++;
          },
          maxEarlyRetries: 3,
          maxContinuations: 3,
          continueStream: async () => {
            sends++;
            if (phase === "continue-read") return fixtureStream([], denied);
            throw denied;
          },
        }
      );
      await assert.rejects(new Response(stream).text(), (error) => error === denied);
      assert.equal(sends, phase === "read" ? 0 : 1);
      assert.equal(finalized, 1);
    });
  }
}

for (const responseDenial of [false, true]) {
  test(`chat stream readiness retains ${responseDenial ? "response" : "error"} denial from recovery send`, async (t) => {
    const { getExecutor } = await import("../../../open-sse/executors/index.ts");
    const connection = await harness.seedConnection("openai", {
      apiKey: "sk-synthetic-stream-recovery",
    });
    await harness.settingsDb.updateSettings({
      resilienceSettings: { streamRecovery: { enabled: true } },
    });
    const executor = await getExecutor("openai");
    let calls = 0;
    t.mock.method(executor, "execute", async () => {
      calls++;
      if (calls === 1)
        return {
          response: new Response(fixtureStream([]), {
            headers: { "content-type": "text/event-stream" },
          }),
          url: "",
          headers: {},
          transformedBody: body,
        };
      if (!responseDenial) throw new RuntimePolicyError("proxy-forbidden");
      return {
        response: runtimePolicyErrorResponse(),
        url: "",
        headers: {},
        transformedBody: body,
      };
    });
    const response = await harness.handleChat(
      harness.buildRequest({ body: { ...body, stream: true, model: "openai/gpt-4.1" } })
    );
    assert.equal(response.status, 403);
    assert.equal(
      calls,
      2,
      "initial truncation may reopen once; denial must not reopen/rotate again"
    );
    assert.match(await response.text(), /OMNI_RUNTIME_POLICY_DENIED/);
    assert.equal(getCircuitBreaker("openai").getStatus().failureCount, 0);
    assert.equal(getCooldownEntryCount(), 0);
    assert.equal((await getProviderConnectionById(String(connection.id)))?.testStatus, "active");
  });
}
