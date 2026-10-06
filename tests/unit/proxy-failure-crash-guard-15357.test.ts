import assert from "node:assert/strict";
import { test } from "node:test";
import proxyFetch, { runWithProxyContext } from "../../open-sse/utils/proxyFetch.ts";
import { shouldSwallowUncaught } from "../../src/shared/utils/httpClientAbortGuard.mjs";

const proxyConfig = { type: "http", host: "127.0.0.1", port: "9" };

async function failThroughProxy(failure) {
  let attempts = 0;
  let captured: unknown;
  await assert.rejects(
    runWithProxyContext(
      proxyConfig,
      () =>
        proxyFetch(
          "https://example.test/",
          {},
          {
            undiciFetch: async () => {
              attempts++;
              throw failure;
            },
            nativeFetch: async () => {
              throw new Error("unexpected direct fallback");
            },
          }
        ),
      { skipUnreachableProbe: true }
    ),
    (error) => {
      captured = error;
      return true;
    }
  );
  return { error: captured as Error & { code?: string; causeCode?: string }, attempts };
}

test("#15357 only exhausted known proxy network failures are recoverable", async () => {
  const { error, attempts } = await failThroughProxy(
    Object.assign(new Error("fetch failed"), { code: "UND_ERR_SOCKET" })
  );

  assert.equal(attempts, 2, "the network failure must exhaust its retry");
  assert.equal(error.code, "PROXY_REQUEST_FAILED");
  assert.equal(error.causeCode, "UND_ERR_SOCKET");
  assert.equal(shouldSwallowUncaught(error, "uncaughtException"), true);
  assert.equal(shouldSwallowUncaught(error, "uncaughtExceptionMonitor"), false);
});

test("#15357 uncoded and cause-only programming failures remain fatal", async () => {
  for (const failure of [
    new TypeError("programming failure"),
    new Error("wrapper", { cause: new TypeError("programming failure") }),
    new Error("UND_ERR_SOCKET"),
    Object.assign(new Error("programming failure"), { code: "ERR_ASSERTION" }),
  ]) {
    const { error } = await failThroughProxy(failure);
    assert.notEqual(error.code, "PROXY_REQUEST_FAILED");
    assert.equal(shouldSwallowUncaught(error, "uncaughtException"), false);
  }

  assert.equal(shouldSwallowUncaught(new TypeError("fetch failed"), undefined), false);
  assert.equal(
    shouldSwallowUncaught(
      Object.assign(new TypeError("fetch failed"), { cause: new TypeError("inner") }),
      undefined
    ),
    false
  );
  assert.equal(
    shouldSwallowUncaught(
      Object.assign(new Error("missing network cause"), { code: "PROXY_REQUEST_FAILED" }),
      undefined
    ),
    false
  );
});
