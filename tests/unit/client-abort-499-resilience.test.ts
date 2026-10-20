import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isLocalStreamLifecycleError } from "../../src/shared/utils/circuitBreaker.ts";
import { checkFallbackError } from "../../open-sse/services/accountFallback.ts";
import { shouldTripProviderBreakerForResult } from "../../src/sse/handlers/chatPredicates.ts";

describe("client-abort-499-resilience", () => {
  describe("isLocalStreamLifecycleError", () => {
    it("returns TRUE for standard DOMException AbortError", () => {
      const controller = new AbortController();
      controller.abort();
      assert.equal(isLocalStreamLifecycleError(controller.signal.reason), true);
    });

    it("returns TRUE for Undici codes (UND_ERR_ABORTED, ERR_ABORTED, ABORT_ERR)", () => {
      assert.equal(isLocalStreamLifecycleError({ code: "UND_ERR_ABORTED" }), true);
      assert.equal(isLocalStreamLifecycleError({ code: "ERR_ABORTED" }), true);
      assert.equal(isLocalStreamLifecycleError({ code: "ABORT_ERR" }), true);
    });

    it("returns TRUE for RequestAbortedError and aborted type", () => {
      const reqAbortErr = new Error("Request aborted");
      reqAbortErr.name = "RequestAbortedError";
      assert.equal(isLocalStreamLifecycleError(reqAbortErr), true);
      assert.equal(isLocalStreamLifecycleError({ type: "aborted" }), true);
    });

    it("returns TRUE for nested error causes", () => {
      const abortCause = new DOMException("This operation was aborted", "AbortError");
      const wrapperErr = new Error("fetch failed", { cause: abortCause });
      assert.equal(isLocalStreamLifecycleError(wrapperErr), true);
    });

    it("returns TRUE for various abort message strings", () => {
      assert.equal(isLocalStreamLifecycleError("Request aborted"), true);
      assert.equal(isLocalStreamLifecycleError("request_signal_aborted"), true);
      assert.equal(isLocalStreamLifecycleError("client disconnected"), true);
      assert.equal(isLocalStreamLifecycleError("The operation was aborted"), true);
      assert.equal(isLocalStreamLifecycleError("The user aborted a request."), true);
    });

    it("returns FALSE for timeouts, real provider errors, null and undefined", () => {
      assert.equal(isLocalStreamLifecycleError(null), false);
      assert.equal(isLocalStreamLifecycleError(undefined), false);

      const timeoutErr = new Error("Fetch timeout after 30000ms");
      timeoutErr.name = "TimeoutError";
      assert.equal(isLocalStreamLifecycleError(timeoutErr), false);

      const bodyTimeoutErr = new Error("Body timeout after 30000ms");
      bodyTimeoutErr.name = "BodyTimeoutError";
      assert.equal(isLocalStreamLifecycleError(bodyTimeoutErr), false);

      assert.equal(isLocalStreamLifecycleError(new Error("502 Bad Gateway")), false);
    });
  });

  describe("checkFallbackError abort safety", () => {
    it("returns shouldFallback=false, cooldownMs=0 for status 499", () => {
      const decision = checkFallbackError(499, "Request aborted", 0, "gemini-3.8-flash-high", "antigravity");
      assert.equal(decision.shouldFallback, false);
      assert.equal(decision.cooldownMs, 0);
      assert.equal(decision.skipProviderBreaker, true);
    });

    it("returns shouldFallback=false, cooldownMs=0 for abort error text even if status is not 499", () => {
      const decision = checkFallbackError(500, "request_signal_aborted", 0, "gemini-3.8-flash-high", "antigravity");
      assert.equal(decision.shouldFallback, false);
      assert.equal(decision.cooldownMs, 0);
      assert.equal(decision.skipProviderBreaker, true);
    });

    it("still returns shouldFallback=true for real upstream 502", () => {
      const decision = checkFallbackError(502, "Bad Gateway from upstream", 0, "gemini-3.8-flash-high", "antigravity");
      assert.equal(decision.shouldFallback, true);
      assert.ok(decision.cooldownMs > 0);
    });
  });

  describe("circuit breaker abort safety", () => {
    it("does NOT trip provider breaker on status 499", () => {
      const trip = shouldTripProviderBreakerForResult(
        {
          status: 499,
          error: "Request aborted",
          errorCode: null,
          errorType: null,
        },
        false,
        false
      );
      assert.equal(trip, false);
    });

    it("does NOT trip provider breaker on local stream lifecycle errors", () => {
      const trip = shouldTripProviderBreakerForResult(
        {
          status: 502,
          error: "request_signal_aborted",
          errorCode: null,
          errorType: null,
        },
        false,
        false
      );
      assert.equal(trip, false);
    });

    it("trips breaker on genuine upstream 502", () => {
      const trip = shouldTripProviderBreakerForResult(
        {
          status: 502,
          error: "upstream connect error or disconnect/reset before headers",
          errorCode: "upstream_502",
          errorType: null,
        },
        false,
        false
      );
      assert.equal(trip, true);
    });
  });
});
