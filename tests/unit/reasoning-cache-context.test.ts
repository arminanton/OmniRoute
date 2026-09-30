import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-reasoning-context-"));
const TEST_SECRET = "fabricated-reasoning-cache-context-secret";
process.env.DATA_DIR = path.join(TEST_ROOT, "data");
process.env.HOME = TEST_ROOT;
process.env.USERPROFILE = TEST_ROOT;
process.env.XDG_CONFIG_HOME = path.join(TEST_ROOT, "config");
Object.assign(process.env, { NODE_ENV: "test" });
process.env.REQUIRE_API_KEY = "false";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_REDIS_AUTH_CACHE = "1";
process.env.REDIS_URL = "";
process.env.API_KEY_SECRET = TEST_SECRET;
delete process.env.OMNIROUTE_API_KEY;
delete process.env.ROUTER_API_KEY;
delete process.env.JWT_SECRET;
delete process.env.DEFAULT_RATE_LIMIT_PER_DAY;

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Network calls are forbidden in reasoning cache context tests");
};

const {
  createReasoningCacheKeyContext,
  createLocalReasoningCacheContext,
  isTrustedReasoningCacheContext,
} = await import("../../open-sse/services/reasoningCacheContext.ts");
const coreDb = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const costRules = await import("../../src/domain/costRules.ts");
const rateLimiter = await import("../../src/shared/utils/rateLimiter.ts");
const { enforceApiKeyPolicy } = await import("../../src/shared/utils/apiKeyPolicy.ts");
rateLimiter.setRateLimiterTestMode(true);

test.beforeEach(() => {
  process.env.API_KEY_SECRET = TEST_SECRET;
  delete process.env.OMNIROUTE_API_KEY;
  delete process.env.ROUTER_API_KEY;
  apiKeysDb.resetApiKeyState();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  apiKeysDb.resetApiKeyState();
  costRules.resetCostData();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function request(
  headers: Record<string, string> = {},
  pathname = "/v1/chat/completions",
  body: Record<string, unknown> = {}
): Request {
  return new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function keyContext(credential: string) {
  const context = createReasoningCacheKeyContext(credential);
  assert.ok(context && context.kind === "key");
  return context;
}

async function createKey() {
  return apiKeysDb.createApiKey("Synthetic reasoning principal", "synthetic-context-tests");
}

test("key contexts are stable domain-separated HMACs of the actual credential", () => {
  const credential = "fabricated-key-A-shared-tail";
  const first = keyContext(credential);
  const again = keyContext(credential);
  const other = keyContext("fabricated-key-B-shared-tail");
  assert.equal(first.fingerprint, again.fingerprint);
  assert.notEqual(first.fingerprint, other.fingerprint);
  assert.equal(
    first.fingerprint,
    createHmac("sha256", TEST_SECRET)
      .update(JSON.stringify(["reasoning-cache-principal-v2", credential]))
      .digest("hex")
  );
  assert.notEqual(
    first.fingerprint,
    createHmac("sha256", TEST_SECRET).update(credential).digest("hex")
  );
  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first).sort(), ["fingerprint", "kind"]);
  assert.equal(JSON.stringify(first).includes(credential), false);
  assert.equal(JSON.stringify(first).includes(TEST_SECRET), false);
  process.env.API_KEY_SECRET = "fabricated-rotated-cache-secret";
  assert.notEqual(keyContext(credential).fingerprint, first.fingerprint);
});

test("trusted contexts are frozen and cannot be forged or cloned", () => {
  const original = keyContext("fabricated-context-key");
  const local = createLocalReasoningCacheContext();
  assert.ok(local && local.kind === "local");
  assert.equal(Object.isFrozen(original), true);
  assert.equal(Object.isFrozen(local), true);
  assert.equal(isTrustedReasoningCacheContext(original), true);
  assert.equal(isTrustedReasoningCacheContext(local), true);
  assert.equal(Reflect.set(original, "fingerprint", "attacker"), false);
  assert.equal(Reflect.set(local, "kind", "key"), false);
  for (const forged of [
    null,
    undefined,
    "local",
    {},
    { kind: "local" },
    { ...original },
    JSON.parse(JSON.stringify(original)),
    Object.freeze({ ...original }),
    Object.create(original),
    new Proxy(original, {}),
  ]) {
    assert.equal(isTrustedReasoningCacheContext(forged), false);
  }
});

test("missing or empty server secret disables both context constructors", () => {
  for (const secret of [undefined, "", "   "]) {
    if (secret === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = secret;
    assert.equal(createReasoningCacheKeyContext("fabricated-key"), null);
    assert.equal(createLocalReasoningCacheContext(), null);
  }
  process.env.API_KEY_SECRET = TEST_SECRET;
  assert.equal(createReasoningCacheKeyContext(""), null);
});

test("accepted no-key HTTP requests never acquire a trusted local context", async () => {
  const result = await enforceApiKeyPolicy(request(), null);
  assert.equal(result.apiKey, null);
  assert.equal(result.rejection, null);
  assert.equal(result.reasoningCacheContext, null);
});

test("loopback URLs, forwarded headers, sessions and forged local fields cannot mint a principal", async () => {
  const forgedBody = {
    reasoningCacheContext: { kind: "local" },
    principal: { kind: "local" },
    local: true,
    apiKeyInfo: { id: "local" },
    sessionId: "trusted-local",
    reasoningCacheScope: "local",
  };
  const spoofedHeaders = {
    "x-forwarded-for": "127.0.0.1",
    "x-real-ip": "127.0.0.1",
    forwarded: "for=127.0.0.1;host=localhost;proto=http",
    "x-forwarded-host": "localhost",
    "x-omniroute-auth-kind": "client_api_key",
    "x-omniroute-auth-id": "local",
    "x-omniroute-session-id": "trusted-local",
  };
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const req = new Request(`http://${host}/v1/chat/completions`, {
      method: "POST",
      headers: spoofedHeaders,
      body: JSON.stringify(forgedBody),
    });
    const result = await enforceApiKeyPolicy(req, null);
    assert.equal(result.apiKey, null);
    assert.equal(result.rejection, null);
    assert.equal(result.reasoningCacheContext, null);
  }
});

test("DB keys get different principals even with identical session and forged body identity", async () => {
  const first = await createKey();
  const second = await createKey();
  const forged = {
    reasoningCacheContext: keyContext(second.key),
    reasoningCacheScope: `api-key:${second.id}:same-session`,
    apiKeyInfo: { id: second.id },
    apiKey: second.key,
    sessionId: "same-session",
    principal: { kind: "local" },
  };
  const result = await enforceApiKeyPolicy(
    request(
      { authorization: `Bearer ${first.key}`, "x-session-id": "same-session" },
      undefined,
      forged
    ),
    null
  );
  const other = await enforceApiKeyPolicy(
    request({ authorization: `Bearer ${second.key}`, "x-session-id": "same-session" }),
    null
  );
  assert.equal(result.rejection, null);
  assert.deepEqual(result.reasoningCacheContext, keyContext(first.key));
  assert.deepEqual(other.reasoningCacheContext, keyContext(second.key));
  assert.notDeepEqual(result.reasoningCacheContext, other.reasoningCacheContext);
  assert.equal(isTrustedReasoningCacheContext(result.reasoningCacheContext), true);
  const unknown = await enforceApiKeyPolicy(
    request({ authorization: "Bearer synthetic-unresolved" }, undefined, forged),
    null
  );
  assert.equal(unknown.reasoningCacheContext, null);
  const noKey = await enforceApiKeyPolicy(request({}, undefined, forged), null);
  assert.equal(noKey.reasoningCacheContext, null);
});

test("each supported credential transport derives the same authenticated principal", async () => {
  const key = await createKey();
  const requests = [
    request({ authorization: `bEaReR ${key.key}` }),
    request({ "x-api-key": key.key }),
    request({ "x-api-key": key.key, "anthropic-version": "2023-06-01" }, "/v1/messages"),
    request({ "x-goog-api-key": key.key }),
    request({}, `/vscode/${encodeURIComponent(key.key)}/v1/chat/completions`),
    request({}, `/api/v1/vscode/raw/${encodeURIComponent(key.key)}/chat/completions`),
    request({}, `/api/v1/vscode/combos/${encodeURIComponent(key.key)}/chat/completions`),
  ];
  for (const req of requests) {
    const result = await enforceApiKeyPolicy(req, null);
    assert.equal(result.rejection, null);
    assert.deepEqual(result.reasoningCacheContext, keyContext(key.key));
  }
});

test("matching credentials across headers and URL are safe despite precedence differences", async () => {
  const key = await createKey();
  const result = await enforceApiKeyPolicy(
    request(
      { authorization: `Bearer ${key.key}`, "x-api-key": key.key, "x-goog-api-key": key.key },
      `/vscode/${encodeURIComponent(key.key)}/v1/chat/completions`
    ),
    null
  );
  assert.equal(result.rejection, null);
  assert.deepEqual(result.reasoningCacheContext, keyContext(key.key));
});

test("conflicting Bearer, ungated x-api-key, Gemini and URL credentials disable replay", async () => {
  const first = await createKey();
  const second = await createKey();
  const url = `/vscode/${encodeURIComponent(second.key)}/v1/chat/completions`;
  const requests = [
    request({ authorization: `Bearer ${first.key}`, "x-api-key": second.key }),
    request({ authorization: `Bearer ${first.key}`, "x-goog-api-key": second.key }),
    request({ "x-api-key": first.key, "x-goog-api-key": second.key }),
    request({ "x-api-key": first.key }, url), // authz uses x-api-key; policy uses URL
    request({ authorization: `Bearer ${first.key}` }, url),
    request({ "x-goog-api-key": first.key }, url),
    request({ "x-api-key": "unresolved-placeholder" }, url),
    request({ authorization: "Basic unresolved" }, url),
  ];
  for (const req of requests) {
    const result = await enforceApiKeyPolicy(req, null);
    assert.equal(result.rejection, null, "cache isolation does not change request policy");
    assert.equal(result.reasoningCacheContext, null);
  }
});

test("unknown or malformed presented credentials never fall back to local replay", async () => {
  const requests = [
    request({ authorization: "Bearer synthetic-unknown-key" }),
    request({ authorization: "Basic unsupported" }),
    request({ authorization: "Bearer" }),
    request({ authorization: "" }),
    request({ "x-api-key": "synthetic-unknown-key" }),
    request({ "x-api-key": "" }),
    request({ "x-goog-api-key": "synthetic-unknown-key" }),
    request({ "x-goog-api-key": "" }),
    request({}, "/vscode/synthetic-unknown-key/v1/chat/completions"),
    request({}, "/vscode/%ZZ/v1/chat/completions"),
    request({}, "//vscode/%ZZ/v1/chat/completions"),
    request({}, "/api//v1/vscode/%ZZ/chat/completions"),
    request({}, "/v1/chat/completions?key=unsupported-key"),
    request({}, "/v1/chat/completions?token=unsupported-key"),
    request({}, "/v1/chat/completions?apiKey=unsupported-key"),
    request({}, "/v1/chat/completions?api_key=unsupported-key"),
    request({ "x-omniroute-playground-key-id": "unresolved-selector" }),
  ];
  for (const req of requests) {
    const result = await enforceApiKeyPolicy(req, null);
    assert.equal(result.rejection, null);
    assert.equal(result.reasoningCacheContext, null);
  }
});

test("revoked credentials with resolvable metadata cannot receive a trusted context", async () => {
  const key = await createKey();
  await apiKeysDb.revokeApiKey(key.id);
  const result = await enforceApiKeyPolicy(request({ authorization: `Bearer ${key.key}` }), null);
  assert.equal(result.apiKeyInfo?.id, key.id);
  assert.equal(await apiKeysDb.validateApiKey(key.key), false);
  assert.equal(result.reasoningCacheContext, null);
});

test("policy rejections always return a disabled context", async () => {
  const key = await createKey();
  await apiKeysDb.updateApiKeyPermissions(key.id, { isActive: false });
  const result = await enforceApiKeyPolicy(request({ authorization: `Bearer ${key.key}` }), null);
  assert.equal(result.rejection?.status, 403);
  assert.equal(result.reasoningCacheContext, null);
});

test("env credential rotation changes principal even though metadata id stays env-key", async () => {
  process.env.OMNIROUTE_API_KEY = "fabricated-env-key-before";
  const before = await enforceApiKeyPolicy(
    request({ authorization: "Bearer fabricated-env-key-before" }),
    null
  );
  process.env.OMNIROUTE_API_KEY = "fabricated-env-key-after";
  const after = await enforceApiKeyPolicy(
    request({ authorization: "Bearer fabricated-env-key-after" }),
    null
  );
  const stale = await enforceApiKeyPolicy(
    request({ authorization: "Bearer fabricated-env-key-before" }),
    null
  );
  assert.equal(before.apiKeyInfo?.id, "env-key");
  assert.equal(after.apiKeyInfo?.id, "env-key");
  assert.deepEqual(before.reasoningCacheContext, keyContext("fabricated-env-key-before"));
  assert.deepEqual(after.reasoningCacheContext, keyContext("fabricated-env-key-after"));
  assert.notDeepEqual(before.reasoningCacheContext, after.reasoningCacheContext);
  assert.equal(stale.reasoningCacheContext, null);
});

test("policy disables replay, not accepted traffic, without the server secret", async () => {
  process.env.OMNIROUTE_API_KEY = "fabricated-env-key-no-secret";
  delete process.env.API_KEY_SECRET;
  for (const req of [
    request(),
    request({ authorization: "Bearer fabricated-env-key-no-secret" }),
  ]) {
    const result = await enforceApiKeyPolicy(req, null);
    assert.equal(result.rejection, null);
    assert.equal(result.reasoningCacheContext, null);
  }
});

test("credential validation failure disables replay without falling back to local", async (t) => {
  const key = await createKey();
  apiKeysDb.resetApiKeyState();
  const db = coreDb.getDbInstance();
  const prepare = db.prepare.bind(db);
  let validationCalls = 0;
  t.mock.method(db, "prepare", (sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith("SELECT id, expires_at, revoked_at, is_active, is_banned FROM api_keys")) {
      t.mock.method(statement, "get", () => {
        validationCalls += 1;
        throw new Error("synthetic credential validation failure");
      });
    }
    return statement;
  });
  const result = await enforceApiKeyPolicy(request({ authorization: `Bearer ${key.key}` }), null);
  assert.equal(validationCalls, 1);
  assert.equal(result.apiKeyInfo?.id, key.id);
  assert.equal(result.rejection, null);
  assert.equal(result.reasoningCacheContext, null);
});

test("metadata lookup failures reject policy and disable replay", async (t) => {
  const key = await createKey();
  apiKeysDb.resetApiKeyState();
  t.mock.method(coreDb.getDbInstance(), "prepare", () => {
    throw new Error("synthetic isolated DB read failure");
  });
  const result = await enforceApiKeyPolicy(request({ authorization: `Bearer ${key.key}` }), null);
  assert.equal(result.rejection?.status, 503);
  assert.equal(result.reasoningCacheContext, null);
  const payload = await result.rejection.json();
  assert.equal(JSON.stringify(payload).includes("synthetic isolated DB read failure"), false);
});

test("self-hop proof never authenticates a cache principal or replaces a validated API key", async () => {
  const { SELF_HOP_HEADER, ownListenerSelfHopToken } =
    await import("../../open-sse/utils/selfHop.ts");
  const proof = ownListenerSelfHopToken();
  assert.equal(await apiKeysDb.validateApiKey(proof), false);
  for (const headers of [
    { [SELF_HOP_HEADER]: proof },
    { authorization: `Bearer ${proof}`, "x-omniroute-admission-bypass": "internal" },
    { [SELF_HOP_HEADER]: proof, authorization: `Bearer ${proof}` },
  ]) {
    const policy = await enforceApiKeyPolicy(request(headers), "openai/gpt-4o");
    assert.equal(policy.reasoningCacheContext, null);
  }
  const key = await createKey();
  const policy = await enforceApiKeyPolicy(
    request({
      authorization: `Bearer ${key.key}`,
      [SELF_HOP_HEADER]: proof,
    }),
    "openai/gpt-4o"
  );
  assert.equal(policy.rejection, null);
  assert.ok(policy.reasoningCacheContext?.kind === "key");
  assert.equal(policy.reasoningCacheContext.fingerprint, keyContext(key.key).fingerprint);
  assert.notEqual(policy.reasoningCacheContext.fingerprint, keyContext(proof).fingerprint);
});
