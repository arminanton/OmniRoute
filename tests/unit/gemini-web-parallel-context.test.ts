import test from "node:test";
import assert from "node:assert/strict";
import { acquireBrowserPageLease, __resetBrowserPoolMetricsForTest, getBrowserPoolMetrics, shutdownPool } from "../../open-sse/services/browserPool.ts";
import { GeminiWebExecutor } from "../../open-sse/executors/gemini-web.ts";

const staleCookie =
  "__Secure-1PSID=sid; __Secure-1PSIDTS=old-ts; __Secure-1PSIDCC=cc";

test("Gemini inference calls get isolated parallel contexts and release each one", async () => {
  const { chromium } = await import("playwright");
  const originalLaunch = chromium.launch;
  const contexts: Array<{ closed: boolean; seeded: Array<{ name: string; value: string }> }> = [];
  let navigations = 0;
  let releaseNavigations!: () => void;
  const bothNavigating = new Promise<void>((resolve) => {
    releaseNavigations = resolve;
  });
  const contextKeys: string[] = [];
  const persistedCookies: string[] = [];

  chromium.launch = (async () => ({
    isConnected: () => true,
    close: async () => {},
    newContext: async () => {
      const state = { closed: false, seeded: [] as Array<{ name: string; value: string }> };
      contexts.push(state);
      return {
        addCookies: async (cookies: Array<{ name: string; value: string }>) => {
          state.seeded = cookies;
        },
        cookies: async () => [
          { name: "__Secure-1PSID", value: "sid" },
          { name: "__Secure-1PSIDTS", value: "rotated-ts" },
          { name: "__Secure-1PSIDCC", value: "cc" },
        ],
        newPage: async () => ({
          on: () => {},
          goto: async () => {
            navigations++;
            if (navigations === 2) releaseNavigations();
            await bothNavigating;
            assert.equal(contexts.filter((context) => !context.closed).length, 2);
          },
          waitForTimeout: async () => {},
          waitForSelector: async () => null,
          close: async () => {},
        }),
        close: async () => {
          state.closed = true;
        },
      };
    },
  })) as unknown as typeof originalLaunch;

  __resetBrowserPoolMetricsForTest();
  try {
    const executor = new GeminiWebExecutor(async (key, options, signal) => {
      contextKeys.push(key);
      return acquireBrowserPageLease(key, options, signal);
    });
    const input = {
      model: "gemini-3.1-pro",
      body: { messages: [{ role: "user", content: "hello" }], stream: false },
      stream: false,
      credentials: { connectionId: "gemini-account", apiKey: staleCookie },
      log: null,
      onCredentialsRefreshed: async (credentials: Record<string, unknown>) => {
        persistedCookies.push(String(credentials.apiKey));
      },
    };

    const [first, second] = await Promise.all([executor.execute(input), executor.execute(input)]);

    assert.equal(first.response.status, 401);
    assert.equal(second.response.status, 401);
    assert.equal(contextKeys.length, 2);
    assert.equal(new Set(contextKeys).size, 2);
    assert.equal(contexts.length, 2);
    assert.ok(contexts.every((context) => context.closed));
    assert.ok(contexts.every((context) => context.seeded.some((cookie) => cookie.name === "__Secure-1PSID" && cookie.value === "sid")));
    assert.deepEqual(persistedCookies, [
      "__Secure-1PSID=sid; __Secure-1PSIDTS=rotated-ts; __Secure-1PSIDCC=cc",
      "__Secure-1PSID=sid; __Secure-1PSIDTS=rotated-ts; __Secure-1PSIDCC=cc",
    ]);
    const { status, metrics } = getBrowserPoolMetrics();
    assert.equal(status.contexts, 0);
    assert.equal(status.activeLeases, 0);
    assert.equal(metrics.contextsCreated, 2);
    assert.equal(metrics.contextsReleased, 2);
  } finally {
    await shutdownPool("gemini-isolated-context-test");
    chromium.launch = originalLaunch;
  }
});
