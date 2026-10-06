// Production RELAY_TIMEOUT (open-sse/utils/proxyFetch.ts): the request layer
// handles this as a 504/fallback, but an escaped rejection must not kill the process.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isClientAbortError,
  isRecoverableUpstreamTimeoutError,
  shouldSwallowUncaught,
} from "../../src/shared/utils/httpClientAbortGuard.mjs";

function relayTimeout(fields: Record<string, unknown> = {}) {
  return Object.assign(new Error("[ProxyFetch] Relay timed out after 25000ms"), fields);
}

test("recognizes RELAY_TIMEOUT / relay_timeout fields and raw codes", () => {
  assert.equal(
    isRecoverableUpstreamTimeoutError(
      relayTimeout({ code: "RELAY_TIMEOUT", errorCode: "relay_timeout", statusCode: 504 })
    ),
    true
  );
  assert.equal(isRecoverableUpstreamTimeoutError(relayTimeout({ code: "RELAY_TIMEOUT" })), true);
  assert.equal(
    isRecoverableUpstreamTimeoutError(relayTimeout({ errorCode: "relay_timeout" })),
    true
  );
  assert.equal(isRecoverableUpstreamTimeoutError("RELAY_TIMEOUT"), true);
  assert.equal(isRecoverableUpstreamTimeoutError("relay_timeout"), true);
});

test("rejects unrelated errors and near-match codes", () => {
  assert.equal(isRecoverableUpstreamTimeoutError(new Error("relay timeout")), false);
  assert.equal(
    isRecoverableUpstreamTimeoutError(Object.assign(new Error("x"), { code: "ECONNRESET" })),
    false
  );
  assert.equal(
    isRecoverableUpstreamTimeoutError(Object.assign(new Error("x"), { errorCode: "relay_timeou" })),
    false
  );
  assert.equal(isRecoverableUpstreamTimeoutError(null), false);
  assert.equal(isRecoverableUpstreamTimeoutError(undefined), false);
});

test("does not broaden client-abort classification", () => {
  assert.equal(isClientAbortError(relayTimeout({ code: "RELAY_TIMEOUT" })), false);
});

test("process-level guard classification accepts both timeout fields at both origins", () => {
  assert.equal(
    shouldSwallowUncaught(relayTimeout({ code: "RELAY_TIMEOUT" }), "uncaughtException"),
    true
  );
  assert.equal(
    shouldSwallowUncaught(relayTimeout({ errorCode: "relay_timeout" }), "unhandledRejection"),
    true
  );
  assert.equal(shouldSwallowUncaught("RELAY_TIMEOUT", "unhandledRejection"), true);
  assert.equal(shouldSwallowUncaught("relay_timeout", "uncaughtException"), true);
});

test("preserves process-origin filtering", () => {
  assert.equal(shouldSwallowUncaught(relayTimeout({ code: "RELAY_TIMEOUT" }), "domain"), false);
});

test("genuine programmer errors still surface", () => {
  const programmerError = new TypeError("Cannot read properties of undefined");
  assert.equal(shouldSwallowUncaught(programmerError, "uncaughtException"), false);
  assert.equal(shouldSwallowUncaught(programmerError, "unhandledRejection"), false);
  assert.equal(
    shouldSwallowUncaught(
      Object.assign(new Error("mystery"), { code: "RELAY_TIMED_OUT" }),
      "unhandledRejection"
    ),
    false
  );
});

test("keeps existing client-abort handling", () => {
  assert.equal(shouldSwallowUncaught(new Error("aborted"), "uncaughtException"), true);
});
