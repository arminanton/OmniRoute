import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";

test.after(async () => {
  const { resetDbInstance } = await import("../../src/lib/db/core.ts");
  resetDbInstance();
});

const log = { debug() {}, info() {}, warn() {}, error() {} };
for (const name of ["retry-after", "x-ratelimit-reset-after"]) {
  test(`${name} preserves strict decimal seconds`, () => {
    const executor = new AntigravityExecutor();
    assert.equal(executor.parseRetryHeaders(new Headers({ [name]: "1.9" })), 1900);
    for (const value of [
      "1.9seconds",
      "2junk",
      "1e2",
      "Infinity",
      "-2",
      "+9999",
      "0x10",
      "9".repeat(400),
    ]) {
      assert.equal(executor.parseRetryHeaders(new Headers({ [name]: value })), null, value);
    }
  });
}

test("retry headers preserve HTTP dates and reset epoch seconds", () => {
  const executor = new AntigravityExecutor();
  const now = Date.now();
  const until = Math.ceil(now / 1000) * 1000 + 60_000;
  for (const headers of [
    new Headers({ "retry-after": new Date(until).toUTCString() }),
    new Headers({ "x-ratelimit-reset": String(until / 1000) }),
  ]) {
    const delay = executor.parseRetryHeaders(headers)!;
    assert.ok(delay > 59_000 && delay <= 61_000);
  }
});

async function runRegional(
  executor: AntigravityExecutor,
  t: TestContext,
  hint: string,
  skipUpstreamRetry = false,
  status = 429
) {
  const sends: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    if (
      init?.method !== "POST" ||
      !String(input).includes(".invalid/v1internal:streamGenerateContent?")
    ) {
      // Reactive404 model discovery is metadata, not another generation attempt.
      return Response.json({ tag_name: "1.19.6", models: {} });
    }
    sends.push(String(input));
    return Response.json(
      { error: { code: status, status: "RESOURCE_EXHAUSTED", message: "Too many requests" } },
      { status, headers: { "retry-after": hint } }
    );
  });
  t.mock.method(executor, "getFallbackCount", () => 2);
  t.mock.method(
    executor,
    "buildUrl",
    (_model: string, _stream: boolean, index: number) =>
      `https://region-${index}.invalid/v1internal:streamGenerateContent?alt=sse`
  );
  t.mock.method(executor, "buildHeaders", () => ({}));
  t.mock.method(executor, "transformRequest", async () => ({
    project: "synthetic-project",
    request: { contents: [] },
  }));
  const result = await executor.execute({
    model: "gemini-3.8-flash-high",
    body: { messages: [] },
    stream: true,
    credentials: { accessToken: "synthetic-only", connectionId: "regional-fixture" },
    skipUpstreamRetry,
    log,
  });
  return { sends, result };
}

test("long-hint429 returns to account fallback without dispatching the next region", async (t) => {
  const { sends, result } = await runRegional(new AntigravityExecutor(), t, "120");
  assert.equal(result.response.status, 429);
  assert.equal(sends.length, 1);
  assert.match(sends[0], /region-0/);
});

test("disabled same-account retry returns429 without regional dispatch", async (t) => {
  const { sends, result } = await runRegional(new AntigravityExecutor(), t, "1.9", true);
  assert.equal(result.response.status, 429);
  assert.equal(sends.length, 1);
});

test("short same-region retry remains bounded to initial send plus three retries", async (t) => {
  const actualSetTimeout = globalThis.setTimeout;
  // Accelerate waits only; every outgoing response remains a real429 fixture.
  t.mock.method(globalThis, "setTimeout", ((
    callback: (...args: unknown[]) => void,
    _ms?: number,
    ...args: unknown[]
  ) => actualSetTimeout(callback, 0, ...args)) as typeof setTimeout);
  const { sends, result } = await runRegional(new AntigravityExecutor(), t, "1.9");
  assert.equal(result.response.status, 429);
  assert.equal(sends.length, 4);
  assert.ok(sends.every((url) => url.includes("region-0")));
});

for (const status of [404, 502, 503, 504]) {
  test(`non429 ${status} retains regional fallback`, async (t) => {
    const { sends, result } = await runRegional(new AntigravityExecutor(), t, "120", true, status);
    assert.equal(result.response.status, status);
    assert.equal(sends.length, 2);
    assert.match(sends[0], /region-0/);
    assert.match(sends[1], /region-1/);
  });
}
