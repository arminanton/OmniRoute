import assert from "node:assert/strict";
import test from "node:test";
import { withCodexConversationIdentity } from "../../open-sse/services/codexConversationIdentity.ts";
import {
  resolveCodexFingerprintIdentity,
  withCodexFingerprintCredentials,
} from "../../open-sse/config/codexIdentity.ts";
import { CodexExecutor } from "../../open-sse/executors/codex.ts";

const base = {
  connectionId: "synthetic-account",
  accessToken: "synthetic",
  authType: "oauth",
  providerSpecificData: { codexFingerprintMode: "session", workspaceId: "synthetic-workspace" },
};

test("100 SDK conversations without native headers keep independent stable identities and cache keys", () => {
  const threads = new Set();
  const caches = new Set();
  const executor = new CodexExecutor();
  for (let i = 0; i < 100; i++) {
    const credentials = withCodexConversationIdentity(
      "codex",
      base,
      "principal",
      `conversation-${i}`
    );
    const identity = resolveCodexFingerprintIdentity({ credentials });
    assert.ok(identity);
    threads.add(identity.threadId);
    const body = executor.transformRequest(
      "gpt-6-luna",
      { input: "OK" },
      true,
      withCodexFingerprintCredentials(credentials)
    );
    caches.add(body.prompt_cache_key);
    assert.deepEqual(resolveCodexFingerprintIdentity({ credentials }).threadId, identity.threadId);
  }
  assert.equal(threads.size, 100);
  assert.equal(caches.size, 100);
  assert.equal(Object.hasOwn(base, "_codexConversationIdentity"), false);
});

test("SDK fallback separates principals and honors native thread, explicit cache key and fingerprint modes", () => {
  const first = withCodexConversationIdentity("codex", base, "first", "same");
  const second = withCodexConversationIdentity("codex", base, "second", "same");
  const resolve = (credentials, extra = {}) =>
    resolveCodexFingerprintIdentity({ credentials, ...extra });
  assert.notEqual(resolve(first).threadId, resolve(second).threadId);
  const native = { clientHeaders: { "thread-id": "native-thread" } };
  assert.equal(resolve(first, native).threadId, resolve(second, native).threadId);
  const explicit = { body: { prompt_cache_key: "explicit-key" } };
  assert.equal(resolve(first, explicit).threadId, resolve(second, explicit).threadId);
  assert.equal(resolve({ ...first, providerSpecificData: { codexFingerprintMode: "off" } }), null);
  assert.equal(
    resolve({ ...first, providerSpecificData: { codexFingerprintMode: "full" } }).threadId,
    resolve({ ...second, providerSpecificData: { codexFingerprintMode: "full" } }).threadId
  );
});
