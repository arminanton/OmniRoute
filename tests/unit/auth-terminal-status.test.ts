import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { RuntimePolicyError, isRuntimePolicyError } from "../../src/shared/runtimePolicy.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-auth-terminal-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const auth = await import("../../src/sse/services/auth.ts");
const accountFallback = await import("../../open-sse/services/accountFallback.ts");

// Source-only fixture for the persistence boundary. The full auth module runs
// with synthetic dependencies; no additional app/DB/provider/helper is loaded.
// The real facade supplies only its pure error constructor and brand predicate.
function deferredWrite() {
  let resolve: () => void = () => assert.fail("deferred promise was not initialized");
  let reject: (error: unknown) => void = () => assert.fail("deferred promise was not initialized");
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function grokMarkFixture(settleWrite: (attempt: number) => Promise<void>) {
  const filename = new URL("../../src/sse/services/auth.ts", import.meta.url);
  const source = fs.readFileSync(filename, "utf8");
  const parsed = ts.createSourceFile(filename.pathname, source, ts.ScriptTarget.Latest, true);
  const imports: Record<string, unknown> = {};
  for (const statement of parsed.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      // Unused static dependencies are inert, never passed to the real loader.
      imports[statement.moduleSpecifier.text] = {};
    }
  }

  const connection: Record<string, unknown> = {
    id: "grok-write-fixture",
    provider: "grok-web",
    authType: "cookie",
    isActive: true,
    testStatus: "active",
    rateLimitedUntil: null,
    backoffLevel: 0,
  };
  const originalConnection = { ...connection };
  const events: string[] = [];
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const commits: Array<Record<string, unknown>> = [];
  const lockouts: Array<Parameters<typeof accountFallback.recordModelLockoutFailure>> = [];
  const invalidations: Array<{ provider: string; connectionId: string }> = [];
  const profile = { baseCooldownMs: 3_000 };
  const maxCooldownMs = 2_000;
  const unexpected = () => assert.fail("unexpected external effect in Grok write fixture");
  const noop = () => {};

  Object.assign(imports, {
    "@/shared/runtimePolicy": { isRuntimePolicyError },
    "@/lib/db/providers": {
      getProviderConnections: async () => [connection],
      updateProviderConnection: async (id: string, data: Record<string, unknown>) => {
        const patch = { ...data };
        writes.push({ id, data: patch });
        const attempt = writes.length;
        events.push(`write-start:${attempt}`);
        try {
          await settleWrite(attempt);
        } catch (error) {
          events.push(`write-rejected:${attempt}`);
          throw error;
        }
        // Synthetic transaction boundary. A denied admission never reaches it.
        commits.push(patch);
        Object.assign(connection, patch);
        events.push(`write-committed:${attempt}`);
        return connection;
      },
    },
    "@/lib/db/providers/lazyConnectionView": {
      toProviderConnection: (row: Record<string, unknown>) => row,
    },
    "@/lib/db/readCache": {
      getCachedSettings: async () => ({}),
      getCachedProviderNodes: async () => [],
    },
    "@/lib/resilience/modelLockoutSettings": {
      resolveModelLockoutSettings: () => ({ maxCooldownMs }),
    },
    "@omniroute/open-sse/services/accountFallback.ts": {
      isProviderModelUnsupported400: () => false,
      getRuntimeProviderProfile: async () => profile,
      checkFallbackError: () => ({ shouldFallback: true, cooldownMs: 3_000, reason: "forbidden" }),
      hasPerModelQuota: () => false,
      recordModelLockoutFailure: (
        ...args: Parameters<typeof accountFallback.recordModelLockoutFailure>
      ) => {
        lockouts.push(args);
        events.push(`lockout:${args[2]}`);
        return {
          cooldownMs: Math.min(args[5], args[7]?.maxCooldownMs ?? Infinity),
          failureCount: 1,
          resetAfterMs: 60_000,
        };
      },
    },
    "@omniroute/open-sse/config/constants.ts": {
      COOLDOWN_MS: { serviceUnavailable: 3_000 },
      RateLimitReason: { QUOTA_EXHAUSTED: "quota_exhausted" },
    },
    "@omniroute/open-sse/config/providerErrorRules.ts": {
      honorsRuleLockScope: () => false,
      isEgressBucketedLockScope: () => false,
    },
    "@omniroute/open-sse/services/errorClassifier.ts": {
      classifyProviderError: () => "forbidden",
    },
    "@omniroute/open-sse/services/alibabaFreeTier.ts": {
      rehydrateAlibabaFreeDrainedModelLocks: noop,
      isAlibabaModelStudioProvider: () => false,
    },
    "@/shared/constants/providers": {
      resolveProviderId: (provider: string) => (provider === "gw" ? "grok-web" : provider),
    },
    "@/shared/utils/probeOrigin": { shouldIsolateProbeFailures: async () => false },
    "./requestResourceHealth": { getResource404Bypass: () => null },
    "../utils/logger": { info: noop, warn: noop, debug: noop, error: noop },
    "@omniroute/open-sse/services/autoCombo/freeAccessQuota.ts": {
      invalidateFreeAccessState: (provider: string, connectionId: string) => {
        invalidations.push({ provider, connectionId });
        events.push("free-access-invalidated");
      },
    },
  });

  const module: { exports: Pick<typeof auth, "markAccountUnavailable"> } = {
    exports: { markAccountUnavailable: async () => unexpected() },
  };
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(
    compiled,
    {
      module,
      exports: module.exports,
      process: { env: {} },
      console: { log: noop, info: noop, warn: noop, error: noop },
      fetch: unexpected,
      setTimeout: unexpected,
      setInterval: unexpected,
      require: (id: string) => {
        if (Object.hasOwn(imports, id)) return imports[id];
        throw new Error(`Unexpected Grok fixture import: ${id}`);
      },
    },
    { filename: filename.pathname }
  );

  return {
    mark: module.exports.markAccountUnavailable,
    connection,
    originalConnection,
    events,
    writes,
    commits,
    lockouts,
    invalidations,
    profile,
    maxCooldownMs,
  };
}

function assertGrokModeLockout(fixture: ReturnType<typeof grokMarkFixture>, mode = "heavy") {
  assert.equal(fixture.lockouts.length, 1);
  const [provider, connectionId, model, reason, status, baseCooldown, profile, options] =
    fixture.lockouts[0];
  assert.equal(provider, "gw");
  assert.equal(connectionId, fixture.connection.id);
  assert.equal(model, mode);
  assert.equal(reason, "forbidden");
  assert.equal(status, 403);
  assert.equal(baseCooldown, fixture.profile.baseCooldownMs);
  assert.equal(profile, fixture.profile);
  assert.equal(options?.maxCooldownMs, fixture.maxCooldownMs);
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("getProviderCredentials skips credits_exhausted connections", async () => {
  await resetStorage();

  const exhausted = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-exhausted",
    isActive: true,
    testStatus: "credits_exhausted",
  });

  const healthy = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-healthy",
    isActive: true,
    testStatus: "active",
  });

  const selected = await auth.getProviderCredentials("openai");
  assert.ok(selected);
  assert.equal(selected.connectionId, healthy.id);
  assert.notEqual(selected.connectionId, exhausted.id);
});

test("getProviderCredentials reports allExpired when all active connections are terminal", async () => {
  await resetStorage();

  await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-only-exhausted",
    isActive: true,
    testStatus: "credits_exhausted",
  });

  const selected = await auth.getProviderCredentials("openai");
  assert.equal(selected?.allExpired, true);
  assert.equal(selected?.expiredStatus, "credits_exhausted");
  assert.equal(selected?.expiredCount, 1);
});

test("getProviderCredentials reports allExpired for isActive grok-cli with testStatus expired (#7611)", async () => {
  await resetStorage();

  await providersDb.createProviderConnection({
    provider: "grok-cli",
    authType: "oauth",
    accessToken: "gcli-access-token",
    isActive: true,
    testStatus: "expired",
    errorCode: "no_refresh_token",
    lastError: "No refresh token available — re-authenticate this account.",
  });

  const selected = await auth.getProviderCredentials("grok-cli");
  assert.equal(selected?.allExpired, true);
  assert.equal(selected?.expiredStatus, "expired");
  assert.equal(selected?.expiredCount, 1);
  assert.equal("connectionId" in (selected || {}), false);
});

test("getProviderCredentials can reuse a locally suppressed connection for combo live tests", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-live-test",
    isActive: true,
    testStatus: "credits_exhausted",
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  const selected = await auth.getProviderCredentials("openai", null, null, null, {
    allowSuppressedConnections: true,
    bypassQuotaPolicy: true,
  });

  assert.ok(selected);
  assert.equal(selected.connectionId, conn.id);
});

test("markAccountUnavailable does not overwrite terminal status", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-terminal",
    isActive: true,
    testStatus: "credits_exhausted",
    lastError: "insufficient_quota",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    503,
    "temporary upstream error",
    "openai",
    "gpt-4.1"
  );

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);

  const after = await providersDb.getProviderConnectionById((conn as any).id);
  assert.equal(after.testStatus, "credits_exhausted");
});

test("markAccountUnavailable marks 401 connections as expired without adding cooldown", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-expired",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    401,
    "unauthorized",
    "openai",
    "gpt-4.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(after.testStatus, "expired");
  assert.ok(!after.rateLimitedUntil);
});

test("markAccountUnavailable marks 402 connections as credits_exhausted without adding cooldown", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-credits",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    402,
    "payment required",
    "openai",
    "gpt-4.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(after.testStatus, "credits_exhausted");
  assert.ok(!after.rateLimitedUntil);
});

test("markAccountUnavailable treats API-key 403 as a recoverable cooldown", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "glm",
    authType: "apikey",
    apiKey: "sk-recoverable",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    403,
    "forbidden",
    "glm",
    "glm-5.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.equal(after.testStatus, "unavailable");
  assert.ok(after.rateLimitedUntil);
  assert.equal(after.lastErrorType ?? null, null);
});

test("markAccountUnavailable keeps Grok Web alias 403 errors mode-local", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "grok-web",
    authType: "cookie",
    apiKey: "sso=grok-cookie",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    403,
    "forbidden",
    "gw",
    "heavy"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);
  const lockout = accountFallback.getModelLockoutInfo("gw", (conn as any).id, "heavy");

  assert.equal(result.shouldFallback, true);
  assert.ok(result.cooldownMs > 0);
  assert.equal(after.testStatus, "active");
  assert.equal(after.lastErrorType, "forbidden");
  assert.ok(!after.rateLimitedUntil);
  assert.equal(lockout?.reason, "forbidden");
});

test("Grok Web 403 waits for metadata persistence before mode lockout and fallback", async () => {
  const started = deferredWrite();
  const write = deferredWrite();
  const fixture = grokMarkFixture(async () => {
    started.resolve();
    await write.promise;
  });
  let settled = false;
  const mark = fixture.mark("grok-write-fixture", 403, "forbidden", "gw", "heavy").then(
    (result) => {
      settled = true;
      return result;
    },
    (error) => {
      settled = true;
      throw error;
    }
  );
  await Promise.race([started.promise, mark.then(() => assert.fail("write was not reached"))]);
  // Flush an already queued completion reaction; no timer or wall-clock wait.
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(fixture.writes.length, 1);
  assert.equal(fixture.commits.length, 0);
  assert.equal(fixture.lockouts.length, 0);
  assert.deepEqual(fixture.connection, fixture.originalConnection);
  assert.deepEqual(fixture.events, ["free-access-invalidated", "write-start:1"]);

  write.resolve();
  const result = await mark;
  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, fixture.maxCooldownMs);
  assert.equal(fixture.commits.length, 1);
  assert.equal(fixture.writes[0].id, fixture.connection.id);
  const patch = fixture.writes[0].data;
  assert.ok(typeof patch.lastErrorAt === "string");
  assert.ok(Number.isFinite(Date.parse(patch.lastErrorAt)));
  assert.deepEqual(patch, {
    lastErrorType: "forbidden",
    lastError: "Mode heavy forbidden for this Grok account",
    lastErrorAt: patch.lastErrorAt,
    errorCode: 403,
  });
  assert.deepEqual(fixture.connection, { ...fixture.originalConnection, ...patch });
  assertGrokModeLockout(fixture);
  assert.deepEqual(fixture.events, [
    "free-access-invalidated",
    "write-start:1",
    "write-committed:1",
    "lockout:heavy",
  ]);
});

const publicDenial = new RuntimePolicyError("entrypoint-unapproved");
for (const failure of [
  { label: "ordinary error", error: new Error("synthetic persistence failure") },
  {
    label: "unbranded public policy lookalike",
    error: Object.assign(new Error(publicDenial.message), {
      name: publicDenial.name,
      code: publicDenial.code,
      reason: publicDenial.reason,
    }),
  },
]) {
  test(`Grok Web 403 keeps best-effort lockout and fallback on ${failure.label}`, async () => {
    assert.equal(isRuntimePolicyError(failure.error), false);
    const fixture = grokMarkFixture(async () => {
      throw failure.error;
    });
    let fallbackContinuations = 0;
    const result = await fixture
      .mark("grok-write-fixture", 403, "forbidden", "gw", "heavy")
      .then((value) => {
        if (value.shouldFallback) fallbackContinuations++;
        return value;
      });
    assert.equal(result.shouldFallback, true);
    assert.equal(result.cooldownMs, fixture.maxCooldownMs);
    assert.equal(fallbackContinuations, 1);
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.commits.length, 0);
    assert.deepEqual(fixture.connection, fixture.originalConnection);
    assertGrokModeLockout(fixture);
    assert.deepEqual(fixture.events, [
      "free-access-invalidated",
      "write-start:1",
      "write-rejected:1",
      "lockout:heavy",
    ]);
  });
}

test("Grok Web write denial preserves identity, skips fallback, and releases its mutex", async () => {
  const denied = new RuntimePolicyError("entrypoint-unapproved");
  assert.equal(isRuntimePolicyError(denied), true);
  const firstStarted = deferredWrite();
  const nextStarted = deferredWrite();
  const firstWrite = deferredWrite();
  const nextWrite = deferredWrite();
  const fixture = grokMarkFixture(async (attempt) => {
    if (attempt === 1) {
      firstStarted.resolve();
      await firstWrite.promise;
    } else {
      nextStarted.resolve();
      await nextWrite.promise;
    }
  });
  let fallbackContinuations = 0;
  const mark = fixture.mark("grok-write-fixture", 403, "forbidden", "gw", "heavy").then((value) => {
    // Model the caller's continuation after awaiting mark, not a chat E2E test.
    if (value.shouldFallback) fallbackContinuations++;
    return value;
  });
  await Promise.race([firstStarted.promise, mark.then(() => assert.fail("write was not reached"))]);
  // This prior cache effect is intentionally preserved, not claimed to roll back.
  assert.deepEqual(fixture.invalidations, [{ provider: "gw", connectionId: "grok-write-fixture" }]);
  assert.equal(fixture.lockouts.length, 0);

  // Queue another mark on the SAME connection before rejecting the first write.
  // It must resume through the real finally release, without polling or timers.
  const next = fixture.mark("grok-write-fixture", 403, "forbidden", "gw", "fast");
  const rejection = assert.rejects(mark, (error: unknown) => {
    assert.equal(error, denied);
    return true;
  });
  firstWrite.reject(denied);
  await rejection;
  await Promise.race([
    nextStarted.promise,
    next.then(() => assert.fail("next write was not reached")),
  ]);
  assert.equal(fallbackContinuations, 0);
  assert.equal(fixture.writes.length, 2);
  assert.equal(fixture.commits.length, 0, "no denied metadata transaction");
  assert.equal(fixture.lockouts.length, 0, "no mode penalty after the denial");
  assert.deepEqual(fixture.connection, fixture.originalConnection);
  assert.deepEqual(fixture.events, [
    "free-access-invalidated",
    "write-start:1",
    "write-rejected:1",
    "free-access-invalidated",
    "write-start:2",
  ]);

  nextWrite.resolve();
  const nextResult = await next;
  assert.equal(nextResult.shouldFallback, true);
  assert.equal(nextResult.cooldownMs, fixture.maxCooldownMs);
  assert.equal(fixture.commits.length, 1);
  assert.equal(fixture.connection.lastError, "Mode fast forbidden for this Grok account");
  assert.equal(fixture.connection.testStatus, "active");
  assert.equal(fixture.connection.rateLimitedUntil, null);
  assert.equal(fixture.connection.backoffLevel, 0);
  assertGrokModeLockout(fixture, "fast");
});

test("markAccountUnavailable keeps project-route 403 errors non-terminal", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-project-route",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    403,
    "The service has not been used in project",
    "openai",
    "gpt-4.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(after.testStatus, "active");
  assert.equal(after.lastErrorType, "project_route_error");
  assert.ok(!after.rateLimitedUntil);
});

test("markAccountUnavailable keeps oauth-invalid 401 errors non-terminal", async () => {
  await resetStorage();

  const conn = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    apiKey: "sk-oauth-invalid",
    isActive: true,
    testStatus: "active",
  });

  const result = await auth.markAccountUnavailable(
    (conn as any).id,
    401,
    "Invalid authentication credentials provided",
    "openai",
    "gpt-4.1"
  );
  const after = await providersDb.getProviderConnectionById((conn as any).id);

  assert.equal(result.shouldFallback, true);
  assert.equal(result.cooldownMs, 0);
  assert.equal(after.testStatus, "active");
  assert.equal(after.lastErrorType, "oauth_invalid_token");
  assert.ok(!after.rateLimitedUntil);
});
