import assert from "node:assert/strict";
import { test } from "node:test";
import proxyFetch, {
  isProxyFetchExhaustedTransportError,
  runWithProxyContext,
} from "../../open-sse/utils/proxyFetch.ts";
import * as proxyFetchExports from "../../open-sse/utils/proxyFetch.ts";
import { shouldSwallowUncaught } from "../../src/shared/utils/httpClientAbortGuard.mjs";
import * as abortGuardExports from "../../src/shared/utils/httpClientAbortGuard.mjs";

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

async function fastFailThroughProxy() {
  let captured: unknown;
  await assert.rejects(
    runWithProxyContext(proxyConfig, () =>
      proxyFetch("https://example.test/", {}, {
        undiciFetch: () => new Promise<Response>(() => {}),
      })
    ),
    (error) => {
      captured = error;
      return true;
    }
  );
  return captured as Error & { code?: string; errorCode?: string; statusCode?: number };
}

test("#15357 only exhausted known proxy network failures are recoverable", async () => {
  const { error, attempts } = await failThroughProxy(
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket failure"), { code: "UND_ERR_SOCKET" }),
    })
  );

  assert.equal(attempts, 2, "the network failure must exhaust its retry");
  assert.equal(error.code, "PROXY_REQUEST_FAILED");
  assert.equal(error.causeCode, "UND_ERR_SOCKET");
  assert.equal(isProxyFetchExhaustedTransportError(error), true);
  assert.equal(shouldSwallowUncaught(error, "uncaughtException"), true);
  assert.equal(shouldSwallowUncaught(error, "uncaughtExceptionMonitor"), false);

  const cloned = Object.assign(new Error(error.message), {
    code: error.code,
    causeCode: error.causeCode,
    cause: error.cause,
  });
  const forged = Object.assign(new Error(error.message), {
    code: "PROXY_REQUEST_FAILED",
    causeCode: "UND_ERR_SOCKET",
    cause: new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket failure"), { code: "UND_ERR_SOCKET" }),
    }),
  });
  assert.equal(isProxyFetchExhaustedTransportError(cloned), false);
  assert.equal(isProxyFetchExhaustedTransportError(forged), false);
  assert.equal(shouldSwallowUncaught(cloned, "uncaughtException"), false);
  assert.equal(shouldSwallowUncaught(forged, "uncaughtException"), false);
  assert.equal("markProxyFetchExhaustedTransportError" in proxyFetchExports, false);
  assert.equal("markProxyFetchExhaustedTransportError" in abortGuardExports, false);
});

test("#15357 forged causeCode stays fatal through proxyFetch", async () => {
  const { error, attempts } = await failThroughProxy(
    Object.assign(new Error("programming failure"), {
      code: "PROXY_REQUEST_FAILED",
      causeCode: "UND_ERR_SOCKET",
    })
  );

  assert.equal(attempts, 1);
  assert.equal(error.code, "PROXY_REQUEST_ERROR");
  assert.equal(error.causeCode, undefined);
  assert.equal(shouldSwallowUncaught(error, "uncaughtException"), false);
});

test("#15357 malformed error values fail closed without throwing", () => {
  const malformed = {
    name: "AbortError",
    message: {
      toString() {
        throw new Error("message must not be coerced");
      },
    },
    code: "ECONNRESET",
  };
  assert.doesNotThrow(() => {
    assert.equal(shouldSwallowUncaught(malformed, "uncaughtException"), false);
  });

  const throwingGetter = new Error("aborted");
  Object.defineProperty(throwingGetter, "code", {
    get() {
      throw new Error("code getter must not escape");
    },
  });
  assert.doesNotThrow(() => {
    assert.equal(shouldSwallowUncaught(throwingGetter, "uncaughtException"), false);
  });
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
  for (const spoof of [
    Object.assign(new Error("spoofed proxy failure"), {
      code: "PROXY_REQUEST_FAILED",
      causeCode: "UND_ERR_SOCKET",
    }),
    Object.assign(new Error("spoofed proxy failure"), {
      code: "PROXY_UNREACHABLE",
      errorCode: "proxy_unreachable",
      causeCode: "ECONNRESET",
    }),
  ]) {
    assert.equal(shouldSwallowUncaught(spoof, "uncaughtException"), false);
  }
});

test("#15357 local fast-fail metadata is not private provenance", async () => {
  const localFastFail = await fastFailThroughProxy();
  assert.equal(localFastFail.code, "PROXY_UNREACHABLE");
  assert.equal(localFastFail.statusCode, 503);
  assert.equal(isProxyFetchExhaustedTransportError(localFastFail), false);
  assert.equal(shouldSwallowUncaught(localFastFail, "uncaughtException"), false);

  const forgedFastFail = Object.assign(new Error(localFastFail.message), {
    code: localFastFail.code,
    errorCode: localFastFail.errorCode,
    statusCode: localFastFail.statusCode,
    causeCode: "UND_ERR_SOCKET",
    cause: Object.assign(new Error("socket failure"), { code: "UND_ERR_SOCKET" }),
  });
  const { error, attempts } = await failThroughProxy(forgedFastFail);
  assert.equal(attempts, 1);
  assert.equal(isProxyFetchExhaustedTransportError(error), false);
  assert.equal(shouldSwallowUncaught(error, "uncaughtException"), false);
});

test("#15357 prototype-forged fetch failure stays fatal through proxyFetch", async () => {
  const forgedCause = Object.assign(Object.create(Error.prototype), {
    message: "socket failure",
    code: "UND_ERR_SOCKET",
  });
  const forgedFetchFailure = Object.assign(Object.create(TypeError.prototype), {
    message: "fetch failed",
    cause: forgedCause,
    code: "PROXY_REQUEST_FAILED",
    causeCode: "UND_ERR_SOCKET",
    statusCode: 503,
  });
  const { error, attempts } = await failThroughProxy(forgedFetchFailure);
  assert.equal(attempts, 2);
  assert.equal(error.code, "PROXY_REQUEST_ERROR");
  assert.equal(isProxyFetchExhaustedTransportError(error), false);
  assert.equal(shouldSwallowUncaught(error, "uncaughtException"), false);
});
