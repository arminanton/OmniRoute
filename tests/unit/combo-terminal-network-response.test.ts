import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-terminal-network-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "terminal-network-test-secret";

const { handleComboChat } = await import("../../open-sse/services/combo.ts");
const { isExhaustedNetworkResponse, markExhaustedNetworkResponse } =
  await import("../../open-sse/services/exhaustedNetworkResponse.ts");

const noop = () => {};
const log = { info: noop, warn: noop, debug: noop, error: noop };

function makeFailure(contentType: string): Response {
  return new Response(
    contentType === "text/event-stream"
      ? 'data: {"error":{"code":"proxy_unreachable"}}\n\n'
      : JSON.stringify({ error: { code: "proxy_unreachable" } }),
    { status: 503, headers: { "content-type": contentType } }
  );
}

for (const contentType of ["application/json", "text/event-stream"]) {
  test(`marker covers ${contentType} without classifying an ordinary provider 503`, () => {
    const exhausted = makeFailure(contentType);
    const providerFailure = makeFailure(contentType);

    assert.equal(isExhaustedNetworkResponse(exhausted), false);
    assert.equal(markExhaustedNetworkResponse(exhausted), exhausted);
    assert.equal(isExhaustedNetworkResponse(exhausted), true);
    assert.equal(isExhaustedNetworkResponse(providerFailure), false);
  });
}

for (const strategy of ["priority", "round-robin"]) {
  test(`${strategy} returns a marked exhausted-network response without advancing targets`, async () => {
    const terminal = markExhaustedNetworkResponse(makeFailure("application/json"));
    const calls: string[] = [];
    const result = await handleComboChat({
      body: { messages: [{ role: "user", content: "hello" }] },
      combo: {
        name: `terminal-network-${strategy}`,
        strategy,
        models: ["openai/first", "anthropic/second"],
        config: { maxRetries: 2, concurrencyPerModel: 1, queueTimeoutMs: 100 },
      },
      handleSingleModel: async (_body: unknown, modelStr: string) => {
        calls.push(modelStr);
        return terminal;
      },
      isModelAvailable: async () => true,
      log,
      settings: null,
      allCombos: null,
      relayOptions: null,
    });

    assert.equal(result, terminal, "the original terminal response must be preserved");
    assert.equal(isExhaustedNetworkResponse(result), true);
    assert.deepEqual(calls, ["openai/first"]);
  });
}

test("direct and global fallback guards run before redispatch", () => {
  const chatSource = fs.readFileSync(path.join(process.cwd(), "src/sse/handlers/chat.ts"), "utf8");
  const terminalGuard = chatSource.indexOf("if (isProxyFetchExhaustedFailure(result.errorCode))");
  const emergencyFallback = chatSource.indexOf("// Emergency fallback for budget exhaustion");
  const globalFallback = chatSource.indexOf("// ── Global Fallback Provider");

  assert.ok(terminalGuard >= 0, "direct exhausted-network guard must exist");
  assert.ok(
    terminalGuard < emergencyFallback,
    "direct exhausted-network guard must run before emergency fallback"
  );
  assert.match(
    chatSource.slice(terminalGuard, emergencyFallback),
    /markExhaustedNetworkResponse/,
    "direct failure response must be marked"
  );
  assert.match(
    chatSource.slice(globalFallback, globalFallback + 700),
    /!isExhaustedNetworkResponse\(response\)/,
    "marked combo responses must suppress global fallback"
  );
});

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});
