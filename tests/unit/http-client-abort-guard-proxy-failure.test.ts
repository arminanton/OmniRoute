// Raw PR #15357 proxyFetch terminal transport failure shape.
import test from "node:test";
import assert from "node:assert/strict";
import { shouldSwallowUncaught } from "../../src/shared/utils/httpClientAbortGuard.mjs";
import { proxyFetch, runWithProxyContext } from "../../open-sse/utils/proxyFetch.ts";

test("keeps ordinary errors and unwrapped network causes fatal", () => {
  for (const origin of ["uncaughtException", "unhandledRejection"]) {
    assert.equal(
      shouldSwallowUncaught(new TypeError("unexpected programming error"), origin),
      false
    );
    assert.equal(
      shouldSwallowUncaught(
        Object.assign(new Error("fetch failed"), { code: "ERR_HTTP2_STREAM_ERROR" }),
        origin
      ),
      false
    );
    assert.equal(
      shouldSwallowUncaught(
        Object.assign(new Error("fetch failed"), { causeCode: "ERR_HTTP2_STREAM_ERROR" }),
        origin
      ),
      false
    );
  }
});

async function captureProxyFetchFailure(error: Error, onAttempt?: () => void) {
  try {
    await runWithProxyContext(
      "http://127.0.0.1:8899",
      () =>
        proxyFetch("https://proxy-failure.example", {}, {
          undiciFetch: async () => {
            onAttempt?.();
            throw error;
          },
        }),
      { skipUnreachableProbe: true }
    );
  } catch (failure) {
    return failure as Error & { code?: string; causeCode?: string };
  }
  assert.fail("proxyFetch should reject");
}

test("proxyFetch brands native fetch failures only after retries are exhausted", async () => {
  let attempts = 0;
  const cause = Object.assign(new Error("HTTP/2 stream reset"), {
    code: "ERR_HTTP2_STREAM_ERROR",
  });
  const failure = await captureProxyFetchFailure(
    new TypeError("fetch failed", { cause }),
    () => {
      attempts += 1;
    }
  );

  assert.ok(attempts > 1, "proxyFetch must exhaust retries before rejecting");
  assert.equal(failure.code, "PROXY_REQUEST_FAILED");
  assert.equal(failure.causeCode, "ERR_HTTP2_STREAM_ERROR");
  for (const origin of ["uncaughtException", "unhandledRejection"]) {
    assert.equal(shouldSwallowUncaught(failure, origin), true);
  }
  assert.equal(shouldSwallowUncaught(failure, "domain"), false);
});

test("proxyFetch keeps plain and prototype-forged fetch failures fatal", async () => {
  const cause = () => Object.assign(new Error("HTTP/2 stream reset"), {
    code: "ERR_HTTP2_STREAM_ERROR",
  });
  const forgedTypeError = Object.assign(Object.create(TypeError.prototype), {
    message: "fetch failed",
    cause: cause(),
  }) as Error;
  for (const error of [
    new TypeError("unexpected programmer error"),
    Object.assign(new Error("programmer error"), { code: "PROXY_REQUEST_FAILED" }),
    new Error("fetch failed", { cause: cause() }),
    forgedTypeError,
  ]) {
    const failure = await captureProxyFetchFailure(error);
    assert.equal(failure.code, "PROXY_REQUEST_ERROR");
    for (const origin of ["uncaughtException", "unhandledRejection"]) {
      assert.equal(shouldSwallowUncaught(failure, origin), false);
    }
  }
});
