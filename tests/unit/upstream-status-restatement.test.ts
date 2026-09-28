import test from "node:test";
import assert from "node:assert/strict";

/**
 * Gateways like agentrouter.org misstate TEMPORARY quota exhaustion as 403/400
 * (Chinese body "用户额度不足"), which Claude Code treats as permanent and dies.
 * applyStatusRestatement() rewrites such statuses to 429 (+ synthetic
 * Retry-After) in ONE place, before fallback classification and before the
 * status ever reaches the client. Registry-driven: future gateways with the
 * same defect register one rule array — no pipeline changes.
 */

const { applyStatusRestatement, statusRestatementRegistry } =
  await import("../../open-sse/config/upstreamStatusRestatement.ts");

test("R1: agentrouter 403 + 用户额度不足 → 429 with synthetic Retry-After", () => {
  const out = applyStatusRestatement({
    provider: "agentrouter",
    status: 403,
    message: '{"error":{"message":"用户额度不足","type":"insufficient_user_quota"}}',
    retryAfterMs: null,
  });
  assert.equal(out.status, 429);
  assert.equal(out.fromStatus, 403);
  assert.equal(out.ruleId, "agentrouter-quota-misstatus");
  assert.equal(out.retryAfterMs, 60_000);
});

test("R2: agentrouter 403 + 无权访问模型 (no model access) is NOT restated", () => {
  const out = applyStatusRestatement({
    provider: "agentrouter",
    status: 403,
    message: "无权访问模型 claude-sonnet-4",
    retryAfterMs: null,
  });
  assert.equal(out.status, 403);
  assert.equal(out.ruleId, null);
});

test("R3: quota marker in body (not message) still restates", () => {
  const out = applyStatusRestatement({
    provider: "agentrouter",
    status: 403,
    message: "Forbidden",
    body: { error: { message: "用户额度不足，请充值" } },
    retryAfterMs: null,
  });
  assert.equal(out.status, 429);
});

test("R4: upstream-provided retryAfterMs wins over the synthetic default", () => {
  const out = applyStatusRestatement({
    provider: "agentrouter",
    status: 403,
    message: "用户额度不足",
    retryAfterMs: 5_000,
  });
  assert.equal(out.status, 429);
  assert.equal(out.retryAfterMs, 5_000);
});

test("R5: agentrouter 400 with quota marker also restates (gateway variant)", () => {
  const out = applyStatusRestatement({
    provider: "agentrouter",
    status: 400,
    message: "额度不足",
    retryAfterMs: null,
  });
  assert.equal(out.status, 429);
});

test("R6: agentrouter 403 without quota markers is untouched (real auth error)", () => {
  const out = applyStatusRestatement({
    provider: "agentrouter",
    status: 403,
    message: "Invalid API key",
    retryAfterMs: null,
  });
  assert.equal(out.status, 403);
  assert.equal(out.ruleId, null);
});

test("R7: other providers never match agentrouter rules (registry-scoped)", () => {
  const out = applyStatusRestatement({
    provider: "openai",
    status: 403,
    message: "用户额度不足",
    retryAfterMs: null,
  });
  assert.equal(out.status, 403);
});

test("R8: statuses a rule does not list pass through (already-correct 429)", () => {
  const out = applyStatusRestatement({
    provider: "agentrouter",
    status: 429,
    message: "用户额度不足",
    retryAfterMs: 1_000,
  });
  assert.equal(out.status, 429);
  assert.equal(out.ruleId, null);
  assert.equal(out.retryAfterMs, 1_000);
});

test("R9: registry exposes agentrouter so future gateways copy the one-line recipe", () => {
  const rules = statusRestatementRegistry.get("agentrouter");
  assert.ok(rules && rules.length > 0);
});

test("R10: chatCore restates agentrouter errors before classifying account state", async () => {
  // Exercise both paths: streaming parses the upstream error in chatCore, while
  // non-streaming receives an error from the extracted provider execution pipeline.
  // A 402 quota control proves that the classifier places a model-quota lock.
  // The mixed Chinese/English 403 would get the same lock without restatement,
  // but must become a retryable 429 before the classifier sees it.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const originalDataDir = process.env.DATA_DIR;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-status-restate-"));
  const originalFetch = globalThis.fetch;
  let resetDbInstance: (() => void) | undefined;
  let clearModelLockouts: (() => void) | undefined;
  process.env.DATA_DIR = dataDir;
  try {
    ({ resetDbInstance } = await import("../../src/lib/db/core.ts"));
    const { createProviderConnection, getProviderConnectionById } =
      await import("../../src/lib/db/providers.ts");
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
    const { getModelLockoutInfo, clearAllModelLockouts } =
      await import("../../open-sse/services/accountFallback.ts");
    clearModelLockouts = clearAllModelLockouts;
    clearModelLockouts();
    let sends = 0;

    async function invoke(stream: boolean, message: string, status = 403) {
      const connection = await createProviderConnection({
        provider: "agentrouter",
        authType: "api_key",
        apiKey: "test-agentrouter-key",
        isActive: true,
        providerSpecificData: {},
      });
      const body = {
        model: "agentrouter/gpt-5.6-sol",
        messages: [{ role: "user", content: "hi" }],
        stream,
      };
      globalThis.fetch = async () => {
        sends += 1;
        return new Response(JSON.stringify({ error: { message } }), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      };
      const result = await handleChatCore({
        body: structuredClone(body),
        modelInfo: { provider: "agentrouter", model: "gpt-5.6-sol", extendedContext: false },
        credentials: {
          apiKey: "test-agentrouter-key",
          connectionId: connection.id,
          providerSpecificData: {},
        },
        connectionId: connection.id,
        log: { debug() {}, info() {}, warn() {}, error() {} },
        clientRawRequest: {
          endpoint: "/v1/chat/completions",
          body: structuredClone(body),
          headers: new Headers({ accept: "application/json" }),
        },
        userAgent: "unit-test",
      });
      const saved = await getProviderConnectionById(connection.id);
      assert.ok(saved, "classification fixture must have a persistent connection");
      return {
        result,
        saved,
        lockout: getModelLockoutInfo("agentrouter", connection.id, "gpt-5.6-sol"),
      };
    }

    for (const stream of [false, true]) {
      const control = await invoke(stream, "insufficient_quota", 402);
      assert.equal(control.result.success, false);
      assert.equal(control.result.status, 402, `control 402 stays 402 (stream=${stream})`);
      assert.equal(
        control.lockout?.reason,
        "quota_exhausted",
        `402 locks model quota (stream=${stream})`
      );

      const quota = await invoke(stream, "用户额度不足 (insufficient_quota)");
      assert.equal(quota.result.success, false);
      assert.equal(quota.result.status, 429, `quota 403 restates to 429 (stream=${stream})`);
      assert.equal(quota.result.retryAfterMs, 60_000, "client receives the synthetic retry delay");
      assert.equal(
        quota.saved.isActive,
        true,
        `restatement keeps account active (stream=${stream})`
      );
      assert.notEqual(quota.lockout?.reason, "quota_exhausted", `no quota lock (stream=${stream})`);
    }
    assert.equal(sends, 4, "one mocked upstream send per case; no live network");
  } finally {
    globalThis.fetch = originalFetch;
    // Let best-effort request logs settle before closing and removing their DB.
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    clearModelLockouts?.();
    resetDbInstance?.();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  }
});
