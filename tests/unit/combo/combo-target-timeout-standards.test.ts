/**
 * Behavioral evidence for Combo per-target timeout standards:
 *  - local timer returns typed 504 `combo_target_timeout` and fails over
 *  - that local timer must NOT record a provider circuit-breaker failure
 *  - a genuine upstream 504 still records breaker failure / connection exhaustion
 *
 * Decision seam for the breaker is the same composition handleComboChat uses:
 *   isComboRequestScopedFailure → shouldRecordProviderBreakerFailure(requestScopedFailure)
 * Exhaustion uses applyComboTargetExhaustion with the same structuredError path.
 * Orchestration uses public handleComboChat + injected handleSingleModel (not private mocks).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-combo-target-timeout-std-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "combo-target-timeout-std-secret";

const { handleComboChat } = await import("../../../open-sse/services/combo.ts");
const { isComboRequestScopedFailure, shouldRecordProviderBreakerFailure } =
  await import("../../../open-sse/services/combo/comboPredicates.ts");
const { isStreamReadinessFailureErrorBody } =
  await import("../../../open-sse/services/combo/comboPredicates.ts");
const { applyComboTargetExhaustion } =
  await import("../../../open-sse/services/combo/targetExhaustion.ts");
const { getProviderBreakerState } = await import("../../../open-sse/services/accountFallback.ts");
const { resetAllCircuitBreakers } = await import("../../../src/shared/utils/circuitBreaker.ts");
const { clearCooldownState, getCooldownEntryCount } =
  await import("../../../open-sse/services/providerCooldownTracker.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

type Body = Record<string, unknown>;

function okResponse(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function upstreamGatewayTimeoutResponse() {
  return new Response(
    JSON.stringify({
      error: {
        message: "Gateway Timeout",
        type: "server_error",
        code: "gateway_timeout",
      },
    }),
    { status: 504, headers: { "Content-Type": "application/json" } }
  );
}

/** Compose the exact breaker decision seam used by handleComboChat's failure branch. */
function decideProviderBreakerRecord(args: {
  status: number;
  errorText: string;
  structuredError?: { code?: string; type?: string };
  sameProviderNext?: boolean;
}) {
  const requestScopedFailure = isComboRequestScopedFailure(
    args.status,
    args.errorText,
    args.structuredError
  );
  return {
    requestScopedFailure,
    shouldRecord: shouldRecordProviderBreakerFailure({
      isStreamReadinessFailure: false,
      status: args.status,
      sameProviderNext: args.sameProviderNext === true,
      requestScopedFailure,
      error: args.errorText,
    }),
  };
}

function resolvedTarget(overrides: Record<string, unknown> = {}) {
  return {
    kind: "model" as const,
    modelStr: "openai/gpt-4o-mini",
    provider: "openai",
    providerId: null,
    connectionId: "conn-1",
    executionKey: "k",
    stepId: "s",
    weight: 1,
    label: null,
    ...overrides,
  } as Parameters<typeof applyComboTargetExhaustion>[0];
}

test.beforeEach(() => {
  resetAllCircuitBreakers();
  clearCooldownState();
});

// ── Decision seam: breaker + request-scoped classification ──────────────────

test("decision seam: typed combo_target_timeout 504 is request-scoped and does not record breaker failure", () => {
  const decision = decideProviderBreakerRecord({
    status: 504,
    errorText: "Model openai/slow timed out",
    structuredError: { code: "combo_target_timeout", type: "combo_target_timeout" },
    sameProviderNext: false,
  });
  assert.equal(decision.requestScopedFailure, true);
  assert.equal(
    decision.shouldRecord,
    false,
    "local per-target timer must not trip the provider circuit breaker"
  );
});

test("decision seam: generic upstream 504 is NOT request-scoped and still records breaker failure", () => {
  const decision = decideProviderBreakerRecord({
    status: 504,
    errorText: "Gateway Timeout",
    structuredError: { code: "gateway_timeout", type: "server_error" },
    sameProviderNext: false,
  });
  assert.equal(decision.requestScopedFailure, false);
  assert.equal(
    decision.shouldRecord,
    true,
    "genuine upstream 504 must retain connection-level breaker recording"
  );
});

test("local readiness buffer overflow is request-scoped and excluded from all cooldown paths", () => {
  const errorBody = {
    error: {
      message: "Stream exceeded the local pre-readiness buffer limit",
      code: "STREAM_READINESS_BUFFER_LIMIT",
      type: "local_stream_buffer_limit",
    },
  };
  const response = new Response(JSON.stringify(errorBody), {
    status: 502,
    headers: { "Content-Type": "application/json" },
  });
  const structuredError = errorBody.error;
  const requestScopedFailure = isComboRequestScopedFailure(
    response,
    errorBody.error.message,
    structuredError
  );

  assert.equal(isStreamReadinessFailureErrorBody(errorBody), true);
  assert.equal(requestScopedFailure, true);
  assert.equal(
    shouldRecordProviderBreakerFailure({
      isStreamReadinessFailure: true,
      status: response.status,
      sameProviderNext: false,
      requestScopedFailure,
      error: errorBody.error.message,
    }),
    false,
    "local buffer protection must not trip the provider breaker"
  );

  const sets = {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
  };
  applyComboTargetExhaustion(resolvedTarget(), {
    result: response,
    fallbackResult: {},
    errorText: errorBody.error.message,
    rawModel: "gpt-4o-mini",
    isTokenLimitBreach: false,
    allAccountsRateLimited: false,
    requestScopedFailure,
    sets,
    log,
    tag: "COMBO",
    exhaustedLogLevel: "info",
    structuredError,
  });
  assert.equal(sets.exhaustedConnections.size, 0);
  assert.equal(sets.exhaustedProviders.size, 0);
  assert.equal(sets.transientRateLimitedProviders.size, 0);
});

test("decision seam: genuine Cloudflare 524 is not request-scoped (exhaustion, not breaker status set)", () => {
  // Breaker status set is 408/500/502/503/504 (not 524). 524 remains a connection-
  // exhaustion signal only — it does not go through request-scoped classification.
  const decision = decideProviderBreakerRecord({
    status: 524,
    errorText: "A Timeout Occurred",
    structuredError: undefined,
    sameProviderNext: false,
  });
  assert.equal(decision.requestScopedFailure, false);
  assert.equal(
    decision.shouldRecord,
    false,
    "524 is outside PROVIDER_BREAKER_FAILURE_STATUSES (exhaustion-only signal)"
  );
});

test("exhaustion: typed combo_target_timeout 504 does not poison connection; generic 504 does", () => {
  const base = {
    fallbackResult: {},
    isTokenLimitBreach: false,
    allAccountsRateLimited: false,
    log,
    tag: "COMBO",
    exhaustedLogLevel: "info" as const,
  };

  const localSets = {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
  };
  applyComboTargetExhaustion(resolvedTarget(), {
    ...base,
    result: { status: 504, headers: null },
    errorText: "Model openai/slow timed out",
    rawModel: "gpt-4o-mini",
    structuredError: { code: "combo_target_timeout", type: "combo_target_timeout" },
    sets: localSets,
  });
  assert.equal(localSets.exhaustedConnections.size, 0);
  assert.equal(localSets.exhaustedProviders.size, 0);

  const upstreamSets = {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
  };
  applyComboTargetExhaustion(resolvedTarget(), {
    ...base,
    result: { status: 504, headers: null },
    errorText: "Gateway Timeout",
    rawModel: "gpt-4o-mini",
    structuredError: { code: "gateway_timeout", type: "server_error" },
    sets: upstreamSets,
  });
  assert.ok(upstreamSets.exhaustedConnections.has("openai:conn-1"));
});

// ── Orchestration: public handleComboChat ───────────────────────────────────

test("handleComboChat: local per-target timeout aborts first target, fails over, succeeds, no breaker record", async () => {
  const calls: string[] = [];
  let firstAborted = false;

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "ping" }] },
    combo: {
      name: "timeout-failover-std",
      strategy: "priority",
      models: ["openai/slow-model", "claude/backup-model"],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        targetTimeoutMs: 40,
      },
    },
    handleSingleModel: async (_b: Body, modelStr: string, target) => {
      calls.push(modelStr);
      if (modelStr === "openai/slow-model") {
        return await new Promise<Response>((resolve) => {
          const sig = target?.modelAbortSignal;
          const onAbort = () => {
            firstAborted = true;
            // Loser branch; timeoutPromise already supplies the typed 504.
            resolve(new Response(null, { status: 599 }));
          };
          if (sig?.aborted) {
            onAbort();
            return;
          }
          sig?.addEventListener("abort", onAbort, { once: true });
        });
      }
      return okResponse("recovered-after-local-timeout");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });

  assert.equal(res.status, 200, "combo must succeed on the second target after local timeout");
  assert.deepEqual(calls, ["openai/slow-model", "claude/backup-model"]);
  assert.equal(firstAborted, true, "first target must be aborted by the per-target timer");

  const body = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  assert.equal(body.choices[0].message.content, "recovered-after-local-timeout");

  const breaker = getProviderBreakerState("openai");
  assert.equal(
    breaker?.failureCount ?? 0,
    0,
    "local combo_target_timeout must not record a provider circuit-breaker failure"
  );
});

test("handleComboChat: generic upstream 504 fails over but still records provider breaker failure", async () => {
  const calls: string[] = [];

  const res = await handleComboChat({
    body: { messages: [{ role: "user", content: "ping" }] },
    combo: {
      name: "upstream-504-failover-std",
      strategy: "priority",
      models: ["openai/primary", "claude/backup"],
      config: {
        maxRetries: 0,
        retryDelayMs: 0,
        fallbackDelayMs: 0,
        // Keep timeout high so this path is pure upstream 504, not the local timer.
        targetTimeoutMs: 60_000,
      },
    },
    handleSingleModel: async (_b: Body, modelStr: string) => {
      calls.push(modelStr);
      if (modelStr === "openai/primary") {
        return upstreamGatewayTimeoutResponse();
      }
      return okResponse("recovered-after-upstream-504");
    },
    isModelAvailable: async () => true,
    log,
    settings: null,
    allCombos: null,
  });

  assert.equal(res.status, 200);
  assert.deepEqual(calls, ["openai/primary", "claude/backup"]);
  const body = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  assert.equal(body.choices[0].message.content, "recovered-after-upstream-504");

  const breaker = getProviderBreakerState("openai");
  assert.ok(
    (breaker?.failureCount ?? 0) >= 1,
    "genuine upstream 504 must record at least one provider breaker failure"
  );
});

test("combo and round-robin stop replay after accepted HTTP 200 readiness failures", async () => {
  const acceptedReadinessFailures = [
    {
      name: "readiness timeout",
      status: 504,
      code: "STREAM_READINESS_TIMEOUT",
      type: "upstream_acceptance_uncertain",
    },
    {
      name: "source read error",
      status: 502,
      code: "STREAM_READ_ERROR",
      type: "upstream_acceptance_uncertain",
    },
    {
      name: "local buffer cap",
      status: 502,
      code: "STREAM_READINESS_BUFFER_LIMIT",
      type: "local_stream_buffer_limit",
    },
  ];

  for (const strategy of ["priority", "round-robin"] as const) {
    for (const failure of acceptedReadinessFailures) {
      resetAllCircuitBreakers();
      clearCooldownState();
      const calls: string[] = [];
      const comboName = `accepted-stream-${strategy}-${failure.code}-${Math.random().toString(16).slice(2)}`;
      const result = await handleComboChat({
        body: { messages: [{ role: "user", content: "do not replay an accepted stream" }] },
        combo: {
          name: comboName,
          strategy,
          models: ["openai/primary", "openai/backup"],
          config: {
            maxRetries: 2,
            retryDelayMs: 0,
            fallbackDelayMs: 0,
            targetTimeoutMs: 60_000,
          },
        },
        handleSingleModel: async (_b: Body, modelStr: string) => {
          calls.push(modelStr);
          return new Response(
            JSON.stringify({
              error: {
                message: `${failure.name} after upstream acceptance`,
                code: failure.code,
                type: failure.type,
              },
            }),
            { status: failure.status, headers: { "Content-Type": "application/json" } }
          );
        },
        isModelAvailable: async () => true,
        log,
        settings: null,
        allCombos: null,
      });

      assert.equal(result.status, failure.status, `${strategy} must preserve ${failure.name}`);
      assert.deepEqual(calls, ["openai/primary"], `${strategy} must not send the request twice`);
      const body = await result.json();
      assert.equal(body.error.code, failure.code, `${failure.name} diagnostic code must survive`);
      assert.equal(body.error.type, failure.type, `${failure.name} classification must survive`);
      assert.equal(
        getCooldownEntryCount(),
        0,
        `${failure.name} must not persist a provider cooldown`
      );
      assert.equal(
        getProviderBreakerState("openai")?.failureCount ?? 0,
        0,
        `${failure.name} must not increment provider breaker failures`
      );
    }
  }
});
