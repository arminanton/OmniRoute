import test from "node:test";
import assert from "node:assert/strict";
import {
  SELF_HOP_HEADER,
  isOwnListenerUrl,
  isOwnListenerSelfHop,
  ownListenerSelfHopToken,
  stampOwnListenerSelfHop,
} from "../../open-sse/utils/selfHop.ts";
import { isInternalAdmissionBypass } from "../../src/shared/middleware/chatAdmissionIdentity.ts";
import { proxyFetch } from "../../open-sse/utils/proxyFetch.ts";

function portEnv() {
  const prior = process.env.PORT;
  process.env.PORT = "20128";
  return () => {
    if (prior === undefined) delete process.env.PORT;
    else process.env.PORT = prior;
  };
}

test("own listener is exact HTTP loopback and current port, not arbitrary local services", () => {
  const restore = portEnv();
  try {
    for (const host of ["localhost", "127.0.0.1", "[::1]"])
      assert.equal(isOwnListenerUrl(`http://${host}:20128/v1/chat/completions`), true);
    for (const url of [
      "http://localhost:20129",
      "http://localhost.evil.test:20128",
      "http://192.168.1.1:20128",
      "https://localhost:20128",
      "ftp://localhost:20128",
      "http://user:pass@localhost:20128",
      "invalid",
    ])
      assert.equal(isOwnListenerUrl(url), false, url);
    process.env.PORT = "invalid";
    assert.equal(isOwnListenerUrl("http://localhost:20128"), false);
  } finally {
    restore();
  }
});

test("stamping keeps API credentials separate and replaces forged proof", () => {
  const restore = portEnv();
  try {
    const request = new Request("http://localhost:20128/v1/chat/completions", {
      headers: { authorization: "Bearer valid-api-key", [SELF_HOP_HEADER]: "spoof" },
    });
    const options: RequestInit = {};
    assert.equal(stampOwnListenerSelfHop(request, options), true);
    const headers = new Headers(options.headers);
    assert.equal(headers.get("authorization"), "Bearer valid-api-key");
    assert.equal(headers.get(SELF_HOP_HEADER), ownListenerSelfHopToken());
    assert.equal(options.redirect, "manual");
    assert.equal(request.headers.get(SELF_HOP_HEADER), "spoof", "input remains untouched");
    assert.equal(isInternalAdmissionBypass(new Request(request.url, options)), true);
    assert.equal(isOwnListenerSelfHop(ownListenerSelfHopToken().toUpperCase()), false);
  } finally {
    restore();
  }
});

test("forwarded proof is removed from non-owned targets without changing API auth", () => {
  const options: RequestInit = {
    headers: {
      authorization: "Bearer valid-api-key",
      [SELF_HOP_HEADER]: ownListenerSelfHopToken(),
    },
  };
  assert.equal(stampOwnListenerSelfHop("https://provider.example/v1", options), false);
  assert.equal(new Headers(options.headers).get(SELF_HOP_HEADER), null);
  assert.equal(new Headers(options.headers).get("authorization"), "Bearer valid-api-key");
});

test("proxyFetch owns exact self-hop transport: one direct send, no dispatcher or redirect leakage", async () => {
  const restore = portEnv();
  const seen: RequestInit[] = [];
  const options = {
    method: "POST",
    body: "{}",
    dispatcher: {},
    headers: {
      authorization: "Bearer valid-api-key",
      [SELF_HOP_HEADER]: ownListenerSelfHopToken(),
    },
    redirect: "follow" as const,
  };
  try {
    const response = await proxyFetch("http://localhost:20128/v1/chat/completions", options, {
      nativeFetch: async (_input, init) => {
        seen.push(init);
        return new Response(null, {
          status: 307,
          headers: { location: "https://external.example" },
        });
      },
      undiciFetch: async () => {
        assert.fail("own listener must not use an arbitrary dispatcher");
      },
      findWorkingProxy: async () => {
        assert.fail("own listener must not use a proxy fallback");
      },
    });
    assert.equal(response.status, 307);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].redirect, "manual");
    assert.equal("dispatcher" in seen[0], false);
    assert.equal(new Headers(seen[0].headers).get(SELF_HOP_HEADER), ownListenerSelfHopToken());
    assert.equal(new Headers(seen[0].headers).get("authorization"), "Bearer valid-api-key");
    assert.equal(options.redirect, "follow", "caller options are not mutated");
  } finally {
    restore();
  }
});

test("failed own-listener POST is not replayed or moved to a provider proxy", async () => {
  const restore = portEnv();
  const failure = new Error("simulated connection failure");
  let sends = 0;
  try {
    await assert.rejects(
      proxyFetch(
        "http://localhost:20128/v1/chat/completions",
        {
          method: "POST",
          body: "{}",
          dispatcher: {},
          headers: { [SELF_HOP_HEADER]: ownListenerSelfHopToken() },
        } as RequestInit,
        {
          nativeFetch: async () => {
            sends++;
            throw failure;
          },
          undiciFetch: async () => {
            assert.fail("self-hop must be direct, not redispatched");
          },
          findWorkingProxy: async () => {
            assert.fail("must not fallback");
          },
        }
      ),
      (error) => error === failure
    );
    assert.equal(sends, 1);
  } finally {
    restore();
  }
});

test("proxyFetch strips copied proof from provider requests", async () => {
  const headers = {
    authorization: "Bearer provider-key",
    [SELF_HOP_HEADER]: ownListenerSelfHopToken(),
  };
  await proxyFetch("https://provider.example/v1", { headers, dispatcher: {} } as RequestInit, {
    undiciFetch: async (_input, init) => {
      assert.equal(new Headers(init.headers).get(SELF_HOP_HEADER), null);
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer provider-key");
      return new Response("ok");
    },
  });
});

test("authenticated self-hop avoids public pressure but never bypasses actual-byte limits", async () => {
  const { ChatAdmissionController, admitChatRequest } =
    await import("../../src/shared/middleware/chatBodyAdmission.ts");
  const restore = portEnv();
  const controller = new ChatAdmissionController(1, undefined, 0, () => undefined, {
    checkPressureSeverity: () => "critical",
  });
  const parent = controller.tryAcquireHeavy()!;
  try {
    const input = (body: string) =>
      new Request("http://localhost:20128/v1/chat/completions", {
        method: "POST",
        headers: { [SELF_HOP_HEADER]: ownListenerSelfHopToken() },
        body,
      });
    const admitted = await admitChatRequest(input("1234"), {
      controller,
      largeBodyBytes: 1,
      hardMaxBytes: 8,
    });
    assert.equal(admitted.admit, true);
    assert.equal(controller.activeHeavy, 1);
    if (admitted.admit) assert.equal(await admitted.request.text(), "1234");
    const rejected = await admitChatRequest(input("123456789"), {
      controller,
      largeBodyBytes: 1,
      hardMaxBytes: 8,
    });
    assert.equal(rejected.admit, false);
    if (!rejected.admit) assert.equal(rejected.response.status, 413);
    assert.equal(controller.activeHeavy, 1);
  } finally {
    parent.release();
    restore();
  }
});

test("URL alone or forged proof never opts an ordinary localhost request into self-hop transport", async () => {
  const restore = portEnv();
  try {
    for (const proof of [null, "forged"]) {
      let ordinarySends = 0;
      await proxyFetch(
        "http://localhost:20128/v1/chat/completions",
        { dispatcher: {}, headers: proof ? { [SELF_HOP_HEADER]: proof } : {} } as RequestInit,
        {
          nativeFetch: async () => {
            assert.fail("URL alone must not activate privileged transport");
          },
          undiciFetch: async (_input, init) => {
            ordinarySends++;
            assert.equal(new Headers(init.headers).get(SELF_HOP_HEADER), null);
            return new Response("ok");
          },
        }
      );
      assert.equal(ordinarySends, 1);
    }
  } finally {
    restore();
  }
});

test("valid proof on the wrong port, authority or API path is stripped instead of honored", async () => {
  const restore = portEnv();
  try {
    for (const url of [
      "http://localhost:20129/v1/chat/completions",
      "https://provider.example/v1/chat/completions",
      "http://localhost:20128/api/oauth/token",
      "http://2130706433:20128/v1/chat/completions",
    ]) {
      await proxyFetch(
        url,
        {
          dispatcher: {},
          headers: { [SELF_HOP_HEADER]: ownListenerSelfHopToken() },
        } as RequestInit,
        {
          nativeFetch: async () => {
            assert.fail("wrong target must not activate self-hop");
          },
          undiciFetch: async (_input, init) => {
            assert.equal(new Headers(init.headers).get(SELF_HOP_HEADER), null);
            return new Response("ok");
          },
        }
      );
    }
  } finally {
    restore();
  }
});
