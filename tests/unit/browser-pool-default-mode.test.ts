import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveBrowserPoolHeadless,
  acquireBrowserPageLease,
  shutdownPool,
  getBrowserPoolStatus,
  type PooledContext,
} from "../../open-sse/services/browserPool.ts";
import { geminiBrowserContextKey } from "../../open-sse/executors/gemini-web.ts";

test("pool default mode is opt-in and caller overrides win", () => {
  assert.equal(resolveBrowserPoolHeadless({}, {}), true);
  assert.equal(
    resolveBrowserPoolHeadless({}, { OMNIROUTE_BROWSER_POOL_MODE: "headedXvfb" }),
    false
  );
  assert.equal(
    resolveBrowserPoolHeadless({ headless: true }, { OMNIROUTE_BROWSER_POOL_MODE: "headedXvfb" }),
    true
  );
  assert.equal(resolveBrowserPoolHeadless({ headless: false }, {}), false);
  assert.throws(() => resolveBrowserPoolHeadless({}, { OMNIROUTE_BROWSER_POOL_MODE: "invalid" }));
});

test("Gemini contexts isolate accounts, credentials and missing connection IDs", () => {
  const key = geminiBrowserContextKey("account-a", "secret-cookie");
  assert.equal(key, geminiBrowserContextKey("account-a", "secret-cookie"));
  assert.notEqual(key, geminiBrowserContextKey("account-b", "secret-cookie"));
  assert.notEqual(key, geminiBrowserContextKey("account-a", "rotated-cookie"));
  assert.notEqual(
    geminiBrowserContextKey(undefined, "same"),
    geminiBrowserContextKey(undefined, "same")
  );
  assert.ok(!key.includes("secret-cookie"));
  assert.ok(!key.includes("account-a"));
});

test("page leases close only their page on abort and cleanup is idempotent", async () => {
  let pageCloses = 0;
  let contextCloses = 0;
  const pooled = {
    context: {
      newPage: async () => ({
        close: async () => {
          pageCloses++;
        },
      }),
      close: async () => {
        contextCloses++;
      },
    },
  } as unknown as PooledContext;
  const deps = { acquire: async () => pooled };
  const controller = new AbortController();
  const a = await acquireBrowserPageLease(
    "account",
    { cookieDomain: "google.com" },
    controller.signal,
    deps
  );
  const b = await acquireBrowserPageLease(
    "account",
    { cookieDomain: "google.com" },
    undefined,
    deps
  );
  controller.abort();
  await a.release();
  assert.equal(pageCloses, 1);
  await b.release();
  await b.release();
  assert.equal(pageCloses, 2);
  assert.equal(contextCloses, 0);
  assert.equal(getBrowserPoolStatus().activeLeases, 0);
  await shutdownPool("test");
});

test("abort while acquiring or creating a page cleans up without touching another context", async () => {
  const controller = new AbortController();
  let closes = 0;
  const pooled = {
    context: {
      newPage: async () => {
        controller.abort();
        return {
          close: async () => {
            closes++;
          },
        };
      },
    },
  } as unknown as PooledContext;
  await assert.rejects(
    acquireBrowserPageLease("account", { cookieDomain: "google.com" }, controller.signal, {
      acquire: async () => pooled,
    })
  );
  assert.equal(closes, 1);
  assert.equal(getBrowserPoolStatus().activeLeases, 0);
  await shutdownPool("test");
});
