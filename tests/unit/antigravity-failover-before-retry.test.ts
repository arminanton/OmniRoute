import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";

test("configured failover-before-retry avoids Antigravity's same-account Retry-After sleep", async () => {
  const executor = new AntigravityExecutor();
  const attempts: Record<number, number> = { 0: 0 };
  const response = new Response(JSON.stringify({ error: { message: "Too many requests" } }), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": "1" },
  });
  const outcome = await executor.handleAntigravityRateLimit({
    url: "https://synthetic.invalid/generate",
    model: "gemini-3.8-flash-high",
    headers: {},
    transformedBody: {},
    credentials: { accessToken: "synthetic-only", connectionId: "synthetic-account" },
    stream: true,
    signal: undefined,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    accountId: "synthetic-account",
    creditsMode: "off",
    creditsRetryState: { attempted: false },
    urlIndex: 0,
    retryAttemptsByUrl: attempts,
    fallbackCount: 2,
    response,
    finalHeaders: {},
    skipUpstreamRetry: true,
  } as Parameters<AntigravityExecutor["handleAntigravityRateLimit"]>[0]);
  assert.equal(outcome.action, "retryNextUrl");
  assert.equal(attempts[0], 0);
});
