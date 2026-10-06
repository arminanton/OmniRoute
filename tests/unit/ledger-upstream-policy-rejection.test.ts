import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyUpstreamPolicyRejection,
  UPSTREAM_POLICY_REJECTION,
} from "../../open-sse/services/upstreamPolicyRejection.ts";
import { isRetryablePreOutputTransportError } from "../../src/sse/services/sameAccountTransportRetry.ts";
import { checkFallbackError } from "../../open-sse/services/accountFallback.ts";
import { isModelUnavailableError } from "../../open-sse/services/modelFamilyFallback.ts";
import { isRetryableStreamError } from "../../open-sse/services/streamRecovery.ts";
import {
  normalizeStreamFailurePayload,
  prepareTranslatedStreamFailure,
} from "../../open-sse/utils/streamErrorFormat.ts";
import {
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
} from "../../open-sse/services/logicalRetryBudget.ts";
const message =
  "This request was blocked by our safety systems. Reason: Potentially unintended activity.";
const native = {
  type: "response.failed",
  response: {
    id: "resp_fixture",
    error: {
      message,
      type: "invalid_request_error",
      code: "bad_gateway",
      request_id: "req_fixture",
    },
  },
};

test("semantic safety rejection remains terminal when wire200 SSE was proxy-mapped502", () => {
  const decision = classifyUpstreamPolicyRejection(native)!;
  assert.equal(decision.code, "bad_gateway");
  assert.equal(decision.type, "invalid_request_error");
  assert.equal(decision.requestId, "req_fixture");
  assert.equal(isRetryablePreOutputTransportError(502, message, "bad_gateway"), false);
  const fallback = checkFallbackError(502, message, 0, "gpt-6.1-sol", "codex");
  assert.equal(fallback.shouldFallback, false);
  assert.equal(fallback.cooldownMs, 0);
  assert.equal(fallback.skipProviderBreaker, true);
  assert.equal(isModelUnavailableError(403, message + " model not available"), false);
  assert.equal(
    isRetryableStreamError(Object.assign(new Error(message), { code: "UND_ERR_SOCKET" })),
    false
  );
});
test("ordinary invalid requests and model-generated refusals are not mislabeled safety errors", () => {
  assert.equal(
    classifyUpstreamPolicyRejection({
      error: { type: "invalid_request_error", message: "unsupported parameter temperature" },
    }),
    null
  );
  assert.equal(
    classifyUpstreamPolicyRejection({ output: [{ content: [{ text: message }] }] }),
    null
  );
});
test("structured response failure retains native envelope and blocks later logical sends", () => {
  const budget = new LogicalRetryBudget(12, Date.now() + 10000);
  runWithLogicalRetryBudget(budget, () => {
    budget.consumeAttempt();
    const failure = normalizeStreamFailurePayload(native)!;
    assert.equal(failure.status, 502);
    assert.equal(failure.type, UPSTREAM_POLICY_REJECTION);
    assert.equal(failure.nativeError?.wireStatus, undefined);
    assert.equal(failure.nativeError?.requestId, "req_fixture");
    const prepared = prepareTranslatedStreamFailure(native)!;
    assert.ok(prepared.providerPayload.nativeError);
    assert.throws(() => budget.consumeAttempt(), /blocked by our safety systems/);
  });
});
