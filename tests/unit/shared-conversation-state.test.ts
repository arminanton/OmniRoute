import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-state-handoff-"));
process.env.DATA_DIR = path.join(directory, "app");
process.env.OMNI_SHARED_ADMISSION = "true";
process.env.OMNI_COORDINATION_DB = path.join(directory, "coordination.sqlite");
process.env.STORAGE_ENCRYPTION_KEY = "synthetic-private-state-test-key-not-production";
process.env.OMNIROUTE_APP_GENERATION = "producer-fixture";
const state = await import("../../src/lib/db/sharedConversationState.ts");
const readiness = await import("../../open-sse/services/conversationState/readiness.ts");
const signatures = await import("../../open-sse/services/geminiThoughtSignatureStore.ts");
const scopes = await import("../../open-sse/services/conversationState/scope.ts");
const token = await import("../../open-sse/services/conversationState/codexTokenProvenance.ts");
const retention = await import("../../src/lib/db/sharedResponseContinuation.ts");
const identity = await import("../../open-sse/services/antigravityIdentity.ts");
const codexIdentity = await import("../../open-sse/services/codexConversationIdentity.ts");
const fingerprint = await import("../../open-sse/config/codexIdentity.ts");
const commit = await import("../../open-sse/services/conversationState/commitCodexState.ts");
const run = promisify(execFile);
async function worker(
  operation: string,
  value = "",
  extra = "",
  encryption = process.env.STORAGE_ENCRYPTION_KEY
) {
  const { stdout } = await run(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "tests/fixtures/shared-conversation-state-worker.ts",
      operation,
      value,
      extra,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STORAGE_ENCRYPTION_KEY: encryption,
        OMNIROUTE_APP_GENERATION: "consumer-fixture",
      },
      timeout: 15000,
    }
  );
  const line = stdout.trim().split("\n").at(-1)!;
  return JSON.parse(line).result;
}
test.after(() => {
  state.closeSharedConversationStateForTests();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("readiness requires an actual distinct-process encrypted functional handoff witness", async () => {
  const pending = readiness.getConversationStateReadiness();
  assert.equal(pending.ready, false);
  assert.ok(pending.challengeId);
  assert.equal(readiness.completeConversationStateHandoffChallenge(pending.challengeId), false);
  assert.equal(await worker("attest", pending.challengeId), true);
  assert.equal(readiness.getConversationStateReadiness().ready, true);
});

test("wrong encryption key cannot attest the same volume", async () => {
  const pending = readiness.getConversationStateReadiness();
  assert.ok(pending.challengeId);
  assert.equal(
    await worker("attest", pending.challengeId, "", "different-synthetic-encryption-key"),
    false
  );
});

test("cross-process overwrite and clear cannot resurrect stale in-memory opaque signatures", async () => {
  const scope = scopes.createConversationScope(
    "antigravity",
    { connectionId: "fixture-account", accessToken: "fixture-access" },
    "principal",
    "conversation",
    "model"
  )!;
  const key = `gs2:${state.conversationScopeKey(scope)}:call-tool`;
  signatures.storeGeminiThoughtSignature(key, "private-functional-signature-A");
  assert.equal(signatures.getGeminiThoughtSignature(key), "private-functional-signature-A");
  await worker("write-signature", key, "private-functional-signature-B");
  assert.equal(signatures.getGeminiThoughtSignature(key), "private-functional-signature-B");
  await worker("clear-signatures");
  assert.equal(signatures.getGeminiThoughtSignature(key), null);
});

test("exact returned tokens survive concurrent branches and isolate all ownership dimensions", () => {
  const scope = scopes.createConversationScope(
    "codex",
    { connectionId: "fixture-account", accessToken: "fixture-access" },
    "principal",
    "conversation",
    "model"
  )!;
  token.rememberCodexStateToken(scope, "private-returned-token-A");
  token.rememberCodexStateToken(scope, "private-returned-token-B");
  assert.equal(token.canEchoCodexStateToken(scope, "private-returned-token-A"), true);
  assert.equal(token.canEchoCodexStateToken(scope, "private-returned-token-B"), true);
  for (const field of [
    "principal",
    "conversation",
    "provider",
    "model",
    "account",
    "authGeneration",
  ] as const)
    assert.equal(
      token.canEchoCodexStateToken({ ...scope, [field]: "other" }, "private-returned-token-A"),
      false
    );
  assert.equal(token.canEchoCodexStateToken(scope, "never-delivered"), false);
});

test("fingerprint echo uses exact delivered proof and refreshed actual authorization generation", () => {
  const initial = {
    connectionId: "fixture-account",
    accessToken: "old-auth",
    providerSpecificData: { codexFingerprintMode: "off" as const },
  };
  const fresh = codexIdentity.withCodexConversationIdentity(
    "codex",
    { ...initial, accessToken: "fresh-auth" },
    "actor",
    "thread",
    "model"
  );
  const headers = { "thread-id": "thread", "x-codex-turn-state": "header-proof" };
  assert.equal(
    commit.commitCodexStateDelivery("codex", headers, initial, "actor", "thread", "model", {
      Authorization: "Bearer fresh-auth",
    }),
    true
  );
  assert.equal(
    fingerprint.withCodexFingerprintCredentials(fresh, headers).providerSpecificData
      .codexTurnStateEcho,
    "header-proof"
  );
  const stale = codexIdentity.withCodexConversationIdentity(
    "codex",
    initial,
    "actor",
    "thread",
    "model"
  );
  assert.equal(
    fingerprint.withCodexFingerprintCredentials(stale, headers).providerSpecificData
      .codexTurnStateEcho,
    null
  );
  assert.equal(
    commit.commitCodexStateDelivery("codex", {}, fresh, "actor", "thread", "model"),
    false
  );
});

test("retirement pins cannot be stolen or released by a different process", async () => {
  const pin = state.opaqueStateKey("private-active-conversation");
  const shared = state.getSharedConversationState()!;
  assert.equal(shared.pin(pin, 30000), true);
  assert.equal(await worker("claim-pin", pin), false);
  assert.equal(await worker("pin-owner", pin), shared.instance);
  assert.equal(readiness.getConversationStatePins(), 1);
  shared.unpin(pin);
  assert.equal(readiness.getConversationStatePins(), 0);
});

test("retained continuation rejects noLog, redacted, truncated and opaque account-bound data", () => {
  const permission = {
    loggingEnabled: true,
    noLog: false,
    videoRedacted: false,
    sourceReady: true,
    sourceTruncated: false,
  };
  const history = {
    input: [{ role: "user", content: "private-approved-retention-fixture" }],
    output: [{ type: "function_call", call_id: "call1", name: "read", arguments: "{}" }],
  };
  assert.equal(
    retention.retainSharedResponseContinuation("response", "actor", "model", history, permission),
    true
  );
  assert.deepEqual(
    retention.resolveSharedResponseContinuation("response", "actor", "model"),
    history
  );
  assert.equal(
    retention.resolveSharedResponseContinuation("response", "different-actor", "model"),
    null
  );
  assert.equal(
    retention.resolveSharedResponseContinuation("response", "actor", "different-model"),
    null
  );
  for (const bad of [
    { ...permission, noLog: true },
    { ...permission, videoRedacted: true },
    { ...permission, sourceTruncated: true },
    { ...permission, loggingEnabled: false },
  ])
    assert.equal(
      retention.retainSharedResponseContinuation("blocked", "actor", "model", history, bad),
      false
    );
  assert.equal(
    retention.retainSharedResponseContinuation(
      "opaque",
      "actor",
      "model",
      { ...history, output: [{ type: "reasoning", encrypted_content: "private-native-opaque" }] },
      permission
    ),
    false
  );
});

test("ciphertext is bound to record scope and TTL, never stored as plaintext", () => {
  const shared = state.getSharedConversationState()!;
  const scopeA = state.opaqueStateKey("scope-A"),
    scopeB = state.opaqueStateKey("scope-B");
  shared.put("fixture", "key", scopeA, { secret: "private-plaintext-marker" }, 60000);
  const db = new DatabaseSync(process.env.OMNI_COORDINATION_DB!);
  const row = db
    .prepare("SELECT value,expires FROM conversation_state_records WHERE kind='fixture'")
    .get()!;
  assert.match(String(row.value), /^enc:v1:/);
  assert.ok(!String(row.value).includes("private-plaintext-marker"));
  db.prepare("INSERT INTO conversation_state_records VALUES(?,?,?,?,?)").run(
    "fixture",
    state.opaqueStateKey("key"),
    scopeB,
    row.value,
    row.expires
  );
  assert.equal(shared.get("fixture", "key", scopeB), null);
  db.close();
});

test("model/auth generation change invalidates signatures without changing stable AG conversation ID", () => {
  const credentials = { connectionId: "account", accessToken: "first-token" };
  const a = identity.withAntigravityConversationIdentity(
    "antigravity",
    credentials,
    "actor",
    "thread",
    "gemini-model"
  );
  const b = identity.withAntigravityConversationIdentity(
    "antigravity",
    { ...credentials, accessToken: "second-token" },
    "actor",
    "thread",
    "gemini-model"
  );
  assert.notEqual(a._signatureNamespace, b._signatureNamespace);
  assert.equal(a._antigravitySessionId, b._antigravitySessionId);
});

test("private credential owner getter rejects forged scope-shaped data and isolates principals", () => {
  const credentials = { connectionId: "account", accessToken: "token" };
  const a = codexIdentity.withCodexConversationIdentity(
    "codex",
    credentials,
    "actor-A",
    "same-thread",
    "model"
  );
  const b = codexIdentity.withCodexConversationIdentity(
    "codex",
    credentials,
    "actor-B",
    "same-thread",
    "model"
  );
  assert.ok(codexIdentity.getCodexConversationOwnerKey(a));
  assert.notEqual(
    codexIdentity.getCodexConversationOwnerKey(a),
    codexIdentity.getCodexConversationOwnerKey(b)
  );
  assert.equal(
    codexIdentity.getCodexConversationOwnerKey({
      ...credentials,
      _codexTurnStateScope: { ...a._codexTurnStateScope! },
    }),
    null
  );
});

test("response-ID receipts persist only ownership metadata and reject foreign owners", async () => {
  const ownership =
    await import("../../open-sse/services/conversationState/codexResponseOwnership.ts");
  const scope = scopes.createConversationScope(
    "codex",
    { connectionId: "account", accessToken: "token" },
    "actor",
    "thread",
    "model"
  )!;
  assert.equal(ownership.getCodexResponseIdOwnership(scope, "untracked"), "unknown");
  assert.equal(ownership.rememberCodexResponseId(scope, "delivered-response-id"), true);
  assert.equal(ownership.getCodexResponseIdOwnership(scope, "delivered-response-id"), "owned");
  assert.equal(
    ownership.getCodexResponseIdOwnership(
      { ...scope, principal: "another-actor" },
      "delivered-response-id"
    ),
    "foreign"
  );
});

test("proven operational capability survives overlap TTL expiry with live functional checks", () => {
  const realNow = Date.now;
  const now = realNow();
  try {
    Date.now = () => now + 61000;
    const status = readiness.getConversationStateReadiness();
    assert.equal(status.ready, true);
    assert.equal(status.handoffFresh, false);
  } finally {
    Date.now = realNow;
  }
});

test("sealed capability invalidates on current generation identity changes", () => {
  const generation = process.env.OMNIROUTE_APP_GENERATION;
  try {
    process.env.OMNIROUTE_APP_GENERATION = "different-generation";
    assert.equal(readiness.getConversationStateReadiness().ready, false);
  } finally {
    process.env.OMNIROUTE_APP_GENERATION = generation;
  }
});
