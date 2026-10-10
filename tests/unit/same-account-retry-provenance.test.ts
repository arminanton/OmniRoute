import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetrySameAccountTransport } from "../../src/sse/services/sameAccountTransportRetry.ts";
import {
  noteGenerationDispatchPhase,
  markUncertainGenerationAcceptance,
} from "../../open-sse/services/generationDispatchEvidence.ts";

for (const status of [502, 503, 504, 507]) {
  test(`provider HTTP${status}, including transport-looking JSON, does not prove a pre-send failure`, async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      Response.json(
        {
          error: {
            message: "ECONNRESET socket hang up; service capacity unavailable",
            phase: "transport_queue",
            requestStarted: false,
          },
        },
        { status }
      )
    );
    const response = await fetch("https://fixture.invalid/v1/responses", { method: "POST" });
    const payload = await response.json();
    assert.equal(
      shouldRetrySameAccountTransport({
        status: response.status,
        errorText: payload.error.message,
        originalError: payload.error,
        attempt: 0,
      }),
      false
    );
  });
}

for (const phase of ["absent", "started", "unknown", "pre-send"]) {
  test(`fake socket failure with ${phase} dispatch evidence`, async (t) => {
    const failure = Object.assign(new Error("ECONNRESET socket hang up"), { code: "ECONNRESET" });
    if (phase !== "absent")
      noteGenerationDispatchPhase(
        failure,
        "transport_queue",
        phase === "started" ? true : phase === "unknown" ? null : false
      );
    t.mock.method(globalThis, "fetch", async () => {
      throw failure;
    });
    let originalError: unknown;
    try {
      await fetch("https://fixture.invalid/v1/responses", { method: "POST" });
    } catch (error) {
      originalError = error;
    }
    assert.equal(
      shouldRetrySameAccountTransport({
        status: 502,
        errorText: String(originalError),
        originalError,
        attempt: 0,
      }),
      phase === "pre-send"
    );
  });
}

test("uncertainty, exhausted transport,429 and policy guards override pre-send evidence", () => {
  const failure = new Error("fixture pre-send transport");
  noteGenerationDispatchPhase(failure, "transport_queue", false);
  const options = {
    status: 503,
    errorText: "fixture pre-send transport",
    originalError: failure,
    attempt: 0,
  };
  assert.equal(shouldRetrySameAccountTransport({ ...options, status: 429 }), false);
  assert.equal(
    shouldRetrySameAccountTransport({
      ...options,
      errorText:
        "This request was blocked by our safety systems. Reason: Potentially unintended activity.",
    }),
    false
  );
  assert.equal(
    shouldRetrySameAccountTransport({ ...options, errorCode: "proxy_unreachable" }),
    false
  );
  markUncertainGenerationAcceptance(failure);
  assert.equal(shouldRetrySameAccountTransport(options), false);
});

test("verified pre-send retry remains bounded and cannot retry after output or under a pin", () => {
  const failure = new Error("fixture pre-send transport");
  noteGenerationDispatchPhase(failure, "transport_queue", false);
  const options = {
    status: 503,
    errorText: "fixture pre-send transport",
    originalError: failure,
    attempt: 0,
  };
  assert.equal(shouldRetrySameAccountTransport(options), true);
  assert.equal(shouldRetrySameAccountTransport({ ...options, attempt: 1 }), false);
  assert.equal(shouldRetrySameAccountTransport({ ...options, hasEmittedOutput: true }), false);
  assert.equal(shouldRetrySameAccountTransport({ ...options, hasForcedConnection: true }), false);
});
