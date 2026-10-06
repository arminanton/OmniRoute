import test from "node:test";
import assert from "node:assert/strict";
import { cloneBoundedForLog, createRequestLogger } from "../../open-sse/utils/requestLogger.ts";

function withLimits(text: string | undefined, keys: string | undefined, run: () => void) {
  const priorText = process.env.CHAT_LOG_TEXT_LIMIT;
  const priorKeys = process.env.CHAT_LOG_MAX_OBJECT_KEYS;
  try {
    if (text === undefined) delete process.env.CHAT_LOG_TEXT_LIMIT;
    else process.env.CHAT_LOG_TEXT_LIMIT = text;
    if (keys === undefined) delete process.env.CHAT_LOG_MAX_OBJECT_KEYS;
    else process.env.CHAT_LOG_MAX_OBJECT_KEYS = keys;
    run();
  } finally {
    if (priorText === undefined) delete process.env.CHAT_LOG_TEXT_LIMIT;
    else process.env.CHAT_LOG_TEXT_LIMIT = priorText;
    if (priorKeys === undefined) delete process.env.CHAT_LOG_MAX_OBJECT_KEYS;
    else process.env.CHAT_LOG_MAX_OBJECT_KEYS = priorKeys;
  }
}
const record = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`field${i}`, i]));

test("pipeline clone retains a diagnostic tool result above the old 64K cap", () => {
  withLimits("131072", "120", () => {
    const result = "approved diagnostic result:" + "x".repeat(100000);
    assert.equal(cloneBoundedForLog(result), result);
    assert.deepEqual(cloneBoundedForLog(record), record);
  });
});
test("configured pipeline limits are bounded and idempotent", () => {
  withLimits("256", "3", () => {
    const input = { ...record, nested: "x".repeat(2000) };
    const cloned = cloneBoundedForLog(input) as Record<string, unknown>;
    assert.equal(cloned._omniroute_truncated_keys, 118);
    assert.equal(Object.keys(cloned).length, 4);
    const text = cloneBoundedForLog("x".repeat(2000)) as string;
    assert.ok(text.length <= 256);
    assert.deepEqual(cloneBoundedForLog(cloned), cloned);
    assert.equal(cloneBoundedForLog(text), text);
  });
});
test("zero object-key cap means all keys, matching the chatCore clone", () => {
  withLimits(undefined, "0", () => assert.deepEqual(cloneBoundedForLog(record), record));
});
test("defaults and invalid limits preserve 64K strings and 80 keys", () => {
  for (const [text, keys] of [
    [undefined, undefined],
    ["invalid", "-1"],
  ]) {
    withLimits(text, keys, () => {
      const str = cloneBoundedForLog("x".repeat(70000)) as string;
      assert.ok(str.length <= 65536);
      const obj = cloneBoundedForLog(record) as Record<string, unknown>;
      assert.equal(obj._omniroute_truncated_keys, 40);
      assert.equal(Object.keys(obj).length, 81);
    });
  }
});
test("even tiny configured string caps bound the truncation marker", () => {
  withLimits("8", undefined, () => {
    const result = cloneBoundedForLog("x".repeat(1000)) as string;
    assert.ok(result.length <= 8);
    assert.equal(cloneBoundedForLog(result), result);
  });
});
test("diagnostic limit changes preserve secret-header and binary redaction", async () => {
  const logger = await createRequestLogger(undefined, undefined, undefined, {
    captureStreamChunks: false,
  });
  withLimits("131072", "120", () => {
    const secret = "synthetic-private-authorization-credential";
    const content = "x".repeat(100000);
    logger.logTargetRequest(
      "https://synthetic.invalid",
      { authorization: secret, "x-api-key": secret },
      { opaque: new Uint8Array(500), content }
    );
    const payload = logger.getPipelinePayloads();
    assert.ok(payload);
    assert.ok(!JSON.stringify(payload).includes(secret));
    const body = payload.providerRequest?.body as Record<string, unknown>;
    assert.equal(body.opaque, "[binary 500 bytes]");
    assert.equal(body.content, content);
  });
});
