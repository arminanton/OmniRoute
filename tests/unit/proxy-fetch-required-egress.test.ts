import test from "node:test";
import assert from "node:assert/strict";
import {
  proxyFetch,
  runWithProxyContext,
  runWithDirectFetchContext,
  runWithTlsTracking,
  setTlsClientForTest,
} from "../../open-sse/utils/proxyFetch.ts";
import { SELF_HOP_HEADER, ownListenerSelfHopToken } from "../../open-sse/utils/selfHop.ts";

const proxy = { type: "http", host: "127.0.0.2", port: 18888 };
const strict = { requireProxy: true, skipUnreachableProbe: true };
const requiredError = (error: unknown) =>
  (error as { code?: string }).code === "PROXY_REQUIRED_EGRESS";
function env(overrides: Record<string, string | undefined>) {
  const prior = Object.fromEntries(Object.keys(overrides).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

for (const target of [
  "http://127.0.0.1:20128/v1/chat/completions",
  "http://192.168.10.1/token",
  "http://[::1]:20128/token",
  "http://service.internal/token",
  "https://provider.example/token",
]) {
  test(`required proxy denies direct resolution before any send: ${target}`, async () => {
    const restore = env({
      NO_PROXY: "provider.example",
      no_proxy: undefined,
      ENABLE_TLS_FINGERPRINT: "false",
    });
    let sends = 0;
    try {
      await assert.rejects(
        runWithProxyContext(
          proxy,
          () =>
            proxyFetch(
              target,
              { method: "POST", body: "credential" },
              {
                nativeFetch: async () => {
                  sends++;
                  return new Response("unexpected");
                },
                undiciFetch: async () => {
                  sends++;
                  return new Response("unexpected");
                },
                findWorkingProxy: async () => {
                  sends++;
                  return null;
                },
              }
            ),
          strict
        ),
        requiredError
      );
      assert.equal(sends, 0);
    } finally {
      restore();
    }
  });
}

test("required proxy rejects missing/empty config before executing credential work", async () => {
  for (const config of [null, {}]) {
    let work = 0;
    await assert.rejects(
      runWithProxyContext(
        config,
        () => {
          work++;
          return "unexpected";
        },
        strict
      ),
      requiredError
    );
    assert.equal(work, 0);
  }
});

test("strict inheritance cannot be lowered by false, direct context, or caller dispatcher", async () => {
  const restore = env({ NO_PROXY: "*", no_proxy: undefined, ENABLE_TLS_FINGERPRINT: "false" });
  let sends = 0;
  const deps = {
    nativeFetch: async () => {
      sends++;
      return new Response("unexpected");
    },
    undiciFetch: async () => {
      sends++;
      return new Response("unexpected");
    },
  };
  try {
    await runWithProxyContext(
      proxy,
      async () => {
        await assert.rejects(
          runWithProxyContext(null, () => proxyFetch("https://provider.example/token", {}, deps), {
            requireProxy: false,
            skipUnreachableProbe: true,
          }),
          requiredError
        );
        assert.throws(
          () =>
            runWithDirectFetchContext(() => {
              sends++;
            }),
          requiredError
        );
        await assert.rejects(
          proxyFetch("https://provider.example/token", { dispatcher: {} } as RequestInit, deps),
          requiredError
        );
      },
      strict
    );
    assert.equal(sends, 0);
  } finally {
    restore();
  }
});

test("valid internal hop proof cannot escape required refresh egress", async () => {
  const restore = env({ PORT: "20128" });
  let sends = 0;
  try {
    await assert.rejects(
      runWithProxyContext(
        proxy,
        () =>
          proxyFetch(
            "http://localhost:20128/v1/chat/completions",
            { headers: { [SELF_HOP_HEADER]: ownListenerSelfHopToken() } },
            {
              nativeFetch: async () => {
                sends++;
                return new Response("unexpected");
              },
              undiciFetch: async () => {
                sends++;
                return new Response("unexpected");
              },
            }
          ),
        strict
      ),
      requiredError
    );
    assert.equal(sends, 0);
  } finally {
    restore();
  }
});

test("required public POST uses the selected proxy once despite global fail-open toggles", async () => {
  const restore = env({
    NO_PROXY: undefined,
    no_proxy: undefined,
    ENABLE_TLS_FINGERPRINT: "false",
    PROXY_FAIL_OPEN: "true",
    OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK: "true",
  });
  let native = 0;
  let proxied = 0;
  const failure = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
  try {
    await assert.rejects(
      runWithProxyContext(
        proxy,
        () =>
          proxyFetch(
            "https://provider.example/token",
            { method: "POST", body: "credential" },
            {
              nativeFetch: async () => {
                native++;
                return new Response("unexpected");
              },
              undiciFetch: async (_input, init) => {
                proxied++;
                assert.ok(init.dispatcher);
                throw failure;
              },
              findWorkingProxy: async () => {
                assert.fail("required refresh never selects a fallback");
              },
            }
          ),
        strict
      )
    );
    assert.equal(native, 0);
    assert.equal(proxied, 1);
  } finally {
    restore();
  }
});

test("strict denies caller direct-fallback opt-in and never probes or uses direct TLS", async () => {
  const { Socket } = await import("node:net");
  const originalConnect = Socket.prototype.connect;
  const restore = env({
    NO_PROXY: "provider.example",
    no_proxy: undefined,
    ENABLE_TLS_FINGERPRINT: "true",
    OMNIROUTE_CONTROL_PLANE_PROXY_DIRECT_FALLBACK: "true",
  });
  let tlsSends = 0;
  let sends = 0;
  Socket.prototype.connect = function () {
    assert.fail("strict refresh must never run a reachability probe");
  };
  setTlsClientForTest({
    available: true,
    fetch: async () => {
      tlsSends++;
      return new Response("unexpected");
    },
  });
  try {
    await assert.rejects(
      runWithProxyContext(
        proxy,
        () =>
          runWithTlsTracking({ provider: "maxai", sessionScope: "test" }, () =>
            proxyFetch(
              "https://provider.example/token",
              { method: "POST", body: "credential" },
              {
                nativeFetch: async () => {
                  sends++;
                  return new Response("unexpected");
                },
                undiciFetch: async () => {
                  sends++;
                  return new Response("unexpected");
                },
              }
            )
          ),
        { requireProxy: true, directFallbackOnUnreachable: true }
      ),
      requiredError
    );
    assert.equal(sends, 0);
    assert.equal(tlsSends, 0);
  } finally {
    Socket.prototype.connect = originalConnect;
    setTlsClientForTest(null);
    restore();
  }
});

test("required credential sends never follow redirects automatically", async () => {
  const restore = env({
    NO_PROXY: undefined,
    no_proxy: undefined,
    ENABLE_TLS_FINGERPRINT: "false",
  });
  let sends = 0;
  try {
    const response = await runWithProxyContext(
      proxy,
      () =>
        proxyFetch(
          "https://provider.example/token",
          { method: "POST", body: "refresh_token=secret", redirect: "follow" },
          {
            undiciFetch: async (_input, init) => {
              sends++;
              assert.equal(init.redirect, "manual");
              return new Response(null, {
                status: 307,
                headers: { location: "https://other.example/token" },
              });
            },
          }
        ),
      strict
    );
    assert.equal(response.status, 307);
    assert.equal(sends, 1);
  } finally {
    restore();
  }
});

test("required credential TLS transport never falls back and replays a GET", async () => {
  const restore = env({
    NO_PROXY: undefined,
    no_proxy: undefined,
    ENABLE_TLS_FINGERPRINT: "true",
    TLS_FINGERPRINT_PROVIDERS: "maxai",
  });
  let tlsSends = 0;
  let alternateSends = 0;
  setTlsClientForTest({
    available: true,
    fetch: async (_url, init) => {
      tlsSends++;
      assert.ok(init?.proxy);
      throw new Error("mock TLS error");
    },
  });
  try {
    await assert.rejects(
      runWithProxyContext(
        proxy,
        () =>
          runWithTlsTracking({ provider: "maxai", sessionScope: "test" }, () =>
            proxyFetch(
              "https://provider.example/token",
              { headers: { authorization: "Bearer test-token" } },
              {
                undiciFetch: async () => {
                  alternateSends++;
                  return new Response("unexpected");
                },
                nativeFetch: async () => {
                  alternateSends++;
                  return new Response("unexpected");
                },
              }
            )
          ),
        strict
      )
    );
    assert.equal(tlsSends, 1);
    assert.equal(alternateSends, 0);
  } finally {
    setTlsClientForTest(null);
    restore();
  }
});
