import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import {
  proxyFetch,
  runWithProxyContext,
  setTlsClientForTest,
} from "../../open-sse/utils/proxyFetch.ts";
import { clearDispatcherCache } from "../../open-sse/utils/proxyDispatcherCache.ts";
import {
  canReplayHttpDispatch,
  isUncertainGenerationAcceptance,
  getGenerationDispatchPhase,
} from "../../open-sse/services/generationReplay.ts";
import {
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
  runGenerationDispatch,
} from "../../open-sse/services/logicalRetryBudget.ts";

const envNames = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "PROXY_AUTO_SELECT_ENABLED",
];
const oldEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
for (const name of envNames) delete process.env[name];
process.env.PROXY_AUTO_SELECT_ENABLED = "false";
setTlsClientForTest({
  available: false,
  fetch: async () => {
    throw new Error("unexpected TLS fixture send");
  },
});
test.after(() => {
  clearDispatcherCache();
  setTlsClientForTest(null);
  for (const name of envNames) {
    if (oldEnv[name] === undefined) delete process.env[name];
    else process.env[name] = oldEnv[name];
  }
});

type Phase = "queued" | "started" | "unknown";
function transportFixture(t: TestContext, phase: Phase, failures = 1) {
  let attempts = 0,
    native = 0;
  const events: unknown[] = [];
  const failure = () =>
    Object.assign(new Error("fetch failed: fixture socket"), { code: "UND_ERR_SOCKET" });
  const dispatch = (_options: unknown, handler: Dispatcher.DispatchHandler) => {
    attempts++;
    events.push({ kind: "dispatch", options: _options });
    if (phase === "started") handler.onRequestStart?.(undefined as never);
    if (attempts <= failures) handler.onError?.(failure());
    else (handler as Dispatcher.DispatchHandler & { fixtureComplete(): void }).fixtureComplete();
    return true;
  };
  t.mock.method(Agent.prototype, "dispatch", dispatch);
  t.mock.method(ProxyAgent.prototype, "dispatch", dispatch);
  const undiciFetch = async (
    input: RequestInfo | URL,
    init: RequestInit & { dispatcher?: Dispatcher }
  ) => {
    events.push({ kind: "fetch", url: String(input) });
    if (phase === "unknown") {
      attempts++;
      throw failure();
    }
    return new Promise<Response>((resolve, reject) => {
      const handler = {
        onRequestStart() {},
        onError: reject,
        fixtureComplete() {
          resolve(new Response("fixture success"));
        },
      };
      init.dispatcher!.dispatch(
        {
          origin: "https://provider.invalid",
          path: new URL(String(input)).pathname,
          method: init.method as Dispatcher.HttpMethod,
        },
        handler
      );
    });
  };
  return {
    events,
    deps: {
      undiciFetch,
      nativeFetch: async () => {
        native++;
        return new Response("unexpected native fallback");
      },
    },
    counts: () => ({ attempts, native }),
  };
}
const proxy = "http://127.0.0.1:9";
const uri = "https://provider.invalid/v1/images/generations";
for (const route of ["direct", "optional-proxy"] as const) {
  const run = <T>(fn: () => T) =>
    route === "direct" ? fn() : runWithProxyContext(proxy, fn, { skipUnreachableProbe: true });
  test(`${route} POST with observed pre-start queue failure retries once`, async (t) => {
    const fixture = transportFixture(t, "queued");
    const response = await run(() => proxyFetch(uri, { method: "POST", body: "{}" }, fixture.deps));
    assert.equal(await response.text(), "fixture success");
    assert.deepEqual(fixture.counts(), { attempts: 2, native: 0 });
  });
  for (const phase of ["started", "unknown"] as const) {
    test(`${route} POST ${phase} evidence never retries or invokes native fallback`, async (t) => {
      const fixture = transportFixture(t, phase);
      await assert.rejects(
        run(() => proxyFetch(uri, { method: "POST", body: "{}" }, fixture.deps)),
        (error) => {
          assert.ok(isUncertainGenerationAcceptance(error));
          assert.notEqual(getGenerationDispatchPhase(error)?.requestStarted, false);
          return true;
        }
      );
      assert.deepEqual(fixture.counts(), { attempts: 1, native: 0 });
    });
  }
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    test(`${route} safe ${method} retains retry after a started failure`, async (t) => {
      const fixture = transportFixture(t, "started");
      const response = await run(() => proxyFetch(uri, { method }, fixture.deps));
      await response.text();
      assert.deepEqual(fixture.counts(), { attempts: 2, native: 0 });
    });
  }
}

test("unsafe methods and serialized request bodies cannot forge object-identity evidence", () => {
  const fake = { phase: "transport_queue", requestStarted: false };
  for (const method of ["POST", "PUT", "PATCH", "DELETE"])
    assert.equal(canReplayHttpDispatch(uri, { method }, fake), false);
  assert.equal(
    canReplayHttpDispatch(new Request(uri, { method: "POST", body: "{}" }), undefined, fake),
    false
  );
});

test("chat generation attempts still consume the existing budget", async (t) => {
  const fixture = transportFixture(t, "queued");
  const budget = new LogicalRetryBudget(2, Date.now() + 5000);
  const response = await runWithLogicalRetryBudget(budget, () =>
    runGenerationDispatch(() =>
      proxyFetch(
        "https://provider.invalid/v1/responses",
        { method: "POST", body: "{}" },
        fixture.deps
      )
    )
  );
  await response.text();
  assert.equal(budget.snapshot().attempts, 2);
  assert.equal(fixture.counts().attempts, 2, JSON.stringify(fixture.events));
});

test("generic media replay authorization does not borrow chat budget or admission backoff hooks", async (t) => {
  const fixture = transportFixture(t, "queued");
  const budget = new LogicalRetryBudget(1, Date.now() + 5000);
  budget.consumeAttempt();
  let hooks = 0;
  const response = await runWithLogicalRetryBudget(budget, () =>
    runGenerationDispatch(() => proxyFetch(uri, { method: "POST", body: "{}" }, fixture.deps), {
      withPermitReleased: async (wait) => {
        hooks++;
        await wait();
      },
    })
  );
  await response.text();
  assert.equal(budget.snapshot().attempts, 1);
  assert.equal(hooks, 0);
  assert.equal(fixture.counts().attempts, 2);
});
