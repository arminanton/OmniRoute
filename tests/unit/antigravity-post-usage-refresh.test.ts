import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPostUsageRefreshScheduler,
  resolvePostUsageRefreshDelayMs,
} from "../../src/lib/usage/providerLimits/postUsageRefresh.ts";

test("missing or empty refresh delay keeps the five-second coalescing window", () => {
  for (const raw of [undefined, "", "  ", "invalid", "-1"])
    assert.equal(
      resolvePostUsageRefreshDelayMs({ PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS: raw }),
      5000
    );
  assert.equal(
    resolvePostUsageRefreshDelayMs({ PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS: "0" }),
    0
  );
  assert.equal(
    resolvePostUsageRefreshDelayMs({ PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS: "250" }),
    250
  );
});

test("100 usage notifications coalesce while refresh is queued and in flight", async () => {
  let calls = 0;
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const schedule = createPostUsageRefreshScheduler(
    async () => {
      calls++;
      await pending;
    },
    () => 0
  );
  for (let i = 0; i < 100; i++) schedule("same-account");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  for (let i = 0; i < 100; i++) schedule("same-account");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  schedule("same-account");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
});

test("failed refresh releases its reservation so a later notification can recover", async () => {
  let calls = 0,
    errors = 0;
  const schedule = createPostUsageRefreshScheduler(
    async () => {
      calls++;
      throw new Error("synthetic");
    },
    () => 0,
    () => {
      errors++;
    }
  );
  schedule("account");
  await new Promise((resolve) => setTimeout(resolve, 10));
  schedule("account");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
  assert.equal(errors, 2);
});
