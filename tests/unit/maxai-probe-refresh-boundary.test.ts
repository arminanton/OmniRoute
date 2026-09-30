/**
 * Offline MaxAI refresh/probe boundary tests. Tokens, HTTP, stores and transport
 * are synthetic. Keep the real coordinator, MaxAiExecutor override, executor
 * factory/registry, probe AsyncLocalStorage, rateLimitManager and Bottleneck.
 *
 * BaseExecutor is only a constructor/getProvider shell. This is NOT a full
 * chatCore/BaseExecutor or real DB/TLS/provider integration test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { AsyncLocalStorage } from "node:async_hooks";
import { Socket } from "node:net";
import dns from "node:dns";
import Bottleneck from "bottleneck";
import type { ExecuteInput, ExecutorExecuteResult } from "../../open-sse/executors/base.ts";
import type { MaxaiCredential } from "../../open-sse/executors/maxai/credentials.ts";
import type {
  EnsureFreshMaxaiCredentialInput,
  MaxaiRefreshStore,
  MaxaiRefreshLease,
  MaxaiRefreshAcquireInput,
  MaxaiRefreshCommitInput,
  MaxaiStoredCredential,
} from "../../open-sse/executors/maxai/refresh.ts";

const isolation = {
  ambientFetchAttempts: 0,
  socketAttempts: 0,
  dnsAttempts: 0,
  dbImports: 0,
  nativeTransportImports: 0,
  unexpectedBoundaryCalls: 0,
};
const probePolicy = {
  probeCanDisable: false,
  featureFlag: false,
  settingsReads: 0,
  flagReads: 0,
};
const policySymbol = Symbol.for("omniroute.maxai-probe-policy-fixture");
Object.defineProperty(globalThis, policySymbol, { value: probePolicy, configurable: true });
const fixtureSymbol = Symbol.for("omniroute.maxai-probe-refresh-boundary");
Object.defineProperty(globalThis, fixtureSymbol, { value: isolation, configurable: true });
const prelude = `
  const s = globalThis[Symbol.for("omniroute.maxai-probe-refresh-boundary")];
  const p = globalThis[Symbol.for("omniroute.maxai-probe-policy-fixture")];
  function unexpected() {
    s.unexpectedBoundaryCalls++;
    throw new Error("Unexpected boundary in offline MaxAI probe fixture");
  }
`;
const nativeFetch = globalThis.fetch;
const nativeNow = Date.now;
const offlineFetch: typeof fetch = async () => {
  isolation.ambientFetchAttempts++;
  throw new Error("Ambient fetch is prohibited in MaxAI probe tests");
};
globalThis.fetch = offlineFetch;
test.mock.method(Socket.prototype, "connect", () => {
  isolation.socketAttempts++;
  throw new Error("Socket is prohibited in MaxAI probe tests");
});
test.mock.method(dns, "lookup", () => {
  isolation.dnsAttempts++;
  throw new Error("DNS is prohibited in MaxAI probe tests");
});
test.mock.method(dns.promises, "lookup", async () => {
  isolation.dnsAttempts++;
  throw new Error("DNS is prohibited in MaxAI probe tests");
});

const sanitizerUrl = new URL("../../open-sse/utils/errorSanitization.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier.endsWith("/executors/base.ts") || specifier === "./base.ts") {
      source = `export class BaseExecutor {
        constructor(provider, config) { this.provider = provider; this.config = config; }
        getProvider() { return this.provider; }
        execute() { return unexpected(); }
      }`;
    } else if (specifier.endsWith("/maxaiTransport.ts")) {
      source = `export const maxaiFetch = unexpected;
        export const runMaxaiConnectionTransport = unexpected;
        export const withMaxaiTransportOwner = unexpected;`;
    } else if (specifier.endsWith("/credentialLoader.ts")) {
      // Do not open provider-credentials.json. All fixture tokens are in memory.
      source = "export const loadProviderCredentials = providers => providers;";
    } else if (specifier === "./default.ts" && context.parentURL?.includes("/executors/")) {
      source = "export class DefaultExecutor { constructor() { unexpected(); } }";
    } else if (
      context.parentURL?.includes("/executors/maxai.ts") &&
      specifier === "../utils/error.ts"
    ) {
      // Preserve the actual sanitizer, without loading unrelated log/DB code.
      source = `export { sanitizeErrorMessage } from ${JSON.stringify(sanitizerUrl)};`;
    } else if (context.parentURL?.includes("/shared/utils/probeOrigin.ts")) {
      // Actual shouldIsolateProbeFailures, with only its flag/settings I/O replaced.
      if (specifier === "@/shared/utils/featureFlags") {
        source = `export function isFeatureFlagEnabled(name) {
          if (name !== "PROBE_CAN_DISABLE") return unexpected();
          p.flagReads++;
          return p.featureFlag;
        }`;
      } else if (specifier === "@/lib/db/readCache") {
        source = `export async function getCachedSettings() {
          p.settingsReads++;
          return { probeCanDisable: p.probeCanDisable };
        }`;
      }
    } else if (context.parentURL?.includes("/services/rateLimitManager.ts")) {
      if (specifier === "./accountFallback.ts") {
        source = "export const parseRetryAfterFromBody = unexpected;";
      } else if (specifier === "../executors/codex.ts") {
        source = "export const getCodexRateLimitKey = unexpected;";
      } else if (specifier === "../config/providerRegistry.ts") {
        source = "export const getProviderCategory = unexpected;";
      } else if (specifier === "../../src/lib/resilience/settings") {
        source = `export const DEFAULT_RESILIENCE_SETTINGS = { requestQueue: {
          autoEnableApiKeyProviders: false, requestsPerMinute: 0,
          minTimeBetweenRequestsMs: 0, concurrentRequests: 1,
          globalConcurrentRequests: 0, maxWaitMs: 300000,
          executionMaxWaitMs: 0, maxQueueDepth: 0
        }};
        export const resolveResilienceSettings = unexpected;`;
      }
    }
    if (source !== undefined) {
      return {
        url: "data:text/javascript," + encodeURIComponent(prelude + source),
        shortCircuit: true,
      };
    }
    const resolved = nextResolve(specifier, context);
    if (resolved.url.includes("/src/lib/db/")) {
      isolation.dbImports++;
      throw new Error("Real DB import is prohibited in MaxAI probe tests");
    }
    if (
      /\/(?:tlsClient|proxyFetch|proxyDispatcher)\.(?:ts|js)(?:\?|$)/.test(resolved.url) ||
      resolved.url.includes("/wreq-js/") ||
      resolved.url.endsWith(".node")
    ) {
      isolation.nativeTransportImports++;
      throw new Error("Native transport import is prohibited in MaxAI probe tests");
    }
    return resolved;
  },
});
// Register even import-failure cleanup before any project module is loaded.
test.after(() => {
  hooks.deregister();
  test.mock.restoreAll();
  globalThis.fetch = nativeFetch;
  Date.now = nativeNow;
  Reflect.deleteProperty(globalThis, fixtureSymbol);
  Reflect.deleteProperty(globalThis, policySymbol);
});

const {
  ensureFreshMaxaiCredential,
  maxaiRefreshGeneration,
  maxaiAccessTokenNeedsRefresh,
  MAXAI_REFRESH_PATH,
  MAXAI_REFRESH_ERRORS,
  MAXAI_REFRESH_FAILURE_COOLDOWN_MS,
  MaxaiRefreshError,
  __resetMaxaiRefreshStateForTest,
  __maxaiRefreshStateSizeForTest,
  __setMaxaiRefreshOwnerForTest,
} = await import("../../open-sse/executors/maxai/refresh.ts");
const { __setMaxaiConstantsForTest } =
  await import("../../open-sse/executors/maxai/constantsStore.ts");
const { MAXAI_WEBAPP_ORIGIN, MAXAI_WEBAPP_APP_PATH } =
  await import("../../open-sse/executors/maxai/constants.ts");
const { MAXAI_BASE_URL, MAXAI_CHAT_PATH } =
  await import("../../open-sse/executors/maxai/protocol.ts");
const { MOCK_CONSTANTS } = await import("./helpers/maxaiMockConstants.ts");
const { runAsProbe, isProbeContext, shouldIsolateProbeFailures } =
  await import("../../src/shared/utils/probeOrigin.ts");
const { MaxAiExecutor } = await import("../../open-sse/executors/maxai.ts");
const { BaseExecutor, getExecutor, hasSpecializedExecutor } =
  await import("../../open-sse/executors/index.ts");
const { getRegistryEntry } = await import("../../open-sse/config/providerRegistry.ts");
const { RuntimePolicyError, isRuntimePolicyError } =
  await import("../../src/shared/runtimePolicy.ts");
const rateLimits = await import("../../open-sse/services/rateLimitManager.ts");

function assertOffline(): void {
  assert.deepEqual(isolation, {
    ambientFetchAttempts: 0,
    socketAttempts: 0,
    dnsAttempts: 0,
    dbImports: 0,
    nativeTransportImports: 0,
    unexpectedBoundaryCalls: 0,
  });
}

test.before(() => {
  assertOffline();
});
test.beforeEach(() => {
  assert.equal(isProbeContext(), false);
  Date.now = () => NOW;
  globalThis.fetch = offlineFetch;
  __resetMaxaiRefreshStateForTest();
  __setMaxaiConstantsForTest(MOCK_CONSTANTS);
  probePolicy.probeCanDisable = false;
  probePolicy.featureFlag = false;
  probePolicy.settingsReads = 0;
  probePolicy.flagReads = 0;
});
test.afterEach(async () => {
  try {
    assertOffline();
    assert.equal(isProbeContext(), false, "probe state must not leak to the test caller");
  } finally {
    __resetMaxaiRefreshStateForTest();
    __setMaxaiRefreshOwnerForTest(null);
    __setMaxaiConstantsForTest(null);
    Date.now = nativeNow;
    await rateLimits.__resetRateLimitManagerForTests();
  }
});

const NOW = Date.parse("2026-09-29T12:00:00Z");
const CONNECTION = "synthetic-maxai-probe-connection";
const MODEL = "gpt-5.6";
const PRIVATE_DETAIL = "SYNTHETIC_REFRESH_DETAIL_NOT_FOR_RESPONSE";

function jwt(claims: Record<string, unknown>): string {
  return `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
}

function credential(ttlSeconds = 30, generation = "old"): MaxaiCredential {
  return {
    accessToken: jwt({ sub: "fixture-user", exp: NOW / 1000 + ttlSeconds, generation }),
    refreshToken: jwt({
      sub: "fixture-user",
      exp: NOW / 1000 + 864000,
      generation: `refresh-${generation}`,
    }),
    deviceId: "fixture-device",
    userId: "fixture-user",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {
    throw new Error("Deferred resolver was not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

type FixtureLease = MaxaiRefreshAcquireInput & { sent: boolean };

/** In-memory CAS contract only. Real encrypted transactions are tested separately. */
class MemoryStore implements MaxaiRefreshStore {
  readonly calls: string[] = [];
  readonly acquisitions: MaxaiRefreshAcquireInput[] = [];
  row: MaxaiCredential;
  revision = 0;
  lease: FixtureLease | null = null;
  sends = 0;
  commits = 0;

  constructor(
    initial: MaxaiCredential,
    private readonly events: string[]
  ) {
    this.row = { ...initial };
  }

  private version(): string {
    return `fixture-snapshot-${this.revision}`;
  }

  private record(name: string): void {
    this.calls.push(name);
    this.events.push(`store:${name}`);
  }

  read(connectionId: string): MaxaiStoredCredential | null {
    this.record("read");
    return connectionId === CONNECTION ? { ...this.row, credentialVersion: this.version() } : null;
  }

  acquire(input: MaxaiRefreshAcquireInput): Awaited<ReturnType<MaxaiRefreshStore["acquire"]>> {
    this.record("acquire");
    this.acquisitions.push({ ...input });
    if (input.connectionId !== CONNECTION) return "missing";
    if (
      input.expectedCredentialVersion !== this.version() ||
      input.generation !== maxaiRefreshGeneration(this.row.refreshToken ?? "")
    )
      return "stale";
    if (this.lease) {
      if (this.lease.leaseExpiresAt > Date.now()) return "busy";
      if (this.lease.sent) return "quarantined";
    }
    this.lease = { ...input, sent: false };
    return "acquired";
  }

  private liveLease(input: MaxaiRefreshLease): FixtureLease | null {
    const lease = this.lease;
    if (
      !lease ||
      lease.connectionId !== input.connectionId ||
      lease.owner !== input.owner ||
      lease.generation !== input.generation ||
      lease.expectedCredentialVersion !== this.version() ||
      lease.leaseExpiresAt <= Date.now()
    )
      return null;
    return lease;
  }

  markSent(input: MaxaiRefreshLease): boolean {
    this.record("markSent");
    const lease = this.liveLease(input);
    if (!lease || lease.sent) return false;
    lease.sent = true;
    this.sends++;
    return true;
  }

  commit(input: MaxaiRefreshCommitInput): boolean {
    this.record("commit");
    if (!this.liveLease(input)?.sent) return false;
    this.row = { ...input.credential };
    this.revision++;
    this.lease = null;
    this.commits++;
    return true;
  }

  release(input: MaxaiRefreshLease): void {
    this.record("release");
    const lease = this.lease;
    if (lease?.owner === input.owner && lease.generation === input.generation && !lease.sent) {
      this.lease = null;
    }
  }

  snapshot() {
    return {
      row: { ...this.row },
      revision: this.revision,
      lease: this.lease ? { ...this.lease } : null,
      sends: this.sends,
      commits: this.commits,
    };
  }
}

type WireCall = { url: string; method: string; authorization: string | null; probe: boolean };

function makeFixture(value: MaxaiCredential = credential()) {
  const events: string[] = [];
  const store = new MemoryStore(value, events);
  const owner = { acquired: 0, active: 0, released: 0 };
  const callbacks: MaxaiCredential[] = [];
  const fetchCalls: WireCall[] = [];
  const executorContexts: boolean[] = [];
  const coordinatorContexts: boolean[] = [];
  const transportConnections: string[] = [];
  const genericPersistence: unknown[] = [];
  const next = credential(86400, "rotated");
  const behavior: { refresh: (init: RequestInit) => Response | Promise<Response> } = {
    refresh: () =>
      Response.json({
        data: { access_token: next.accessToken, refresh_token: next.refreshToken },
      }),
  };
  __setMaxaiRefreshOwnerForTest(async <T>(operation: () => Promise<T>): Promise<T> => {
    owner.acquired++;
    owner.active++;
    events.push("owner:acquire");
    try {
      // Let waitForCaller register before the shared coordinator checks waiters.
      await Promise.resolve();
      return await operation();
    } finally {
      owner.active--;
      owner.released++;
      events.push("owner:release");
    }
  });
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const authorization = new Headers(init.headers).get("authorization");
    fetchCalls.push({ url, method, authorization, probe: isProbeContext() });
    if (url === MAXAI_WEBAPP_ORIGIN + MAXAI_WEBAPP_APP_PATH && method === "GET") {
      events.push("wire:constants");
      // Force the real extraction failure/memo fallback. Never write settings.
      return new Response("", { status: 404 });
    }
    if (url === MAXAI_BASE_URL + MAXAI_REFRESH_PATH && method === "POST") {
      events.push("wire:refresh");
      assert.equal(store.sends, 1, "durable SENT must precede the rotating grant");
      assert.equal(authorization, `Bearer ${value.refreshToken}`);
      assert.equal(init.redirect, "error");
      assert.equal(init.body, JSON.stringify({ app: "maxai_webapp" }));
      return behavior.refresh(init);
    }
    if (url === MAXAI_BASE_URL + MAXAI_CHAT_PATH && method === "POST") {
      events.push("wire:chat");
      assert.equal(init.redirect, "error");
      return new Response(
        'data: {"data_key":"text","need_merge":true,"text":"synthetic hello"}\n\ndata: [DONE]\n\n'
      );
    }
    throw new Error("Unexpected request in offline MaxAI probe fixture");
  };
  const onCredentialsRefreshed = async (fresh: MaxaiCredential): Promise<void> => {
    events.push("persist:acknowledge");
    callbacks.push({ ...fresh });
  };
  const input: EnsureFreshMaxaiCredentialInput = {
    connectionId: CONNECTION,
    credential: value,
    store,
    fetchImpl,
    onCredentialsRefreshed,
  };
  const executor = new MaxAiExecutor({
    runTransport: async (connectionId, run) => {
      executorContexts.push(isProbeContext());
      transportConnections.push(connectionId);
      return run();
    },
    ensureCredential: (args) => {
      coordinatorContexts.push(isProbeContext());
      // Observe, then call the real boundary. Never re-enter runAsProbe here.
      return ensureFreshMaxaiCredential({ ...args, store, onCredentialsRefreshed });
    },
    fetchImpl,
  });
  const executionInput: ExecuteInput = {
    model: MODEL,
    stream: false,
    credentials: {
      connectionId: CONNECTION,
      accessToken: value.accessToken,
      refreshToken: value.refreshToken,
      providerSpecificData: { maxaiDeviceId: value.deviceId, maxaiUserId: value.userId },
    },
    body: { messages: [{ role: "user", content: "synthetic hello" }] },
    onCredentialsRefreshed: (patch) => {
      genericPersistence.push(patch);
    },
  };
  return {
    value,
    next,
    store,
    owner,
    callbacks,
    fetchCalls,
    events,
    behavior,
    input,
    executor,
    executionInput,
    executorContexts,
    coordinatorContexts,
    transportConnections,
    genericPersistence,
  };
}

type Fixture = ReturnType<typeof makeFixture>;

function assertNoRefreshEffects(f: Fixture): void {
  assert.deepEqual(f.owner, { acquired: 0, active: 0, released: 0 });
  assert.deepEqual(f.store.calls, [], "probe must not even read the credential store");
  assert.deepEqual(f.store.acquisitions, []);
  assert.equal(f.store.sends, 0);
  assert.equal(f.store.commits, 0);
  assert.equal(f.store.lease, null);
  assert.deepEqual(f.callbacks, []);
  assert.deepEqual(f.genericPersistence, []);
  assert.equal(
    f.fetchCalls.filter(({ url }) => url !== MAXAI_BASE_URL + MAXAI_CHAT_PATH).length,
    0,
    "probe must not fetch constants or post a rotating refresh token"
  );
  assert.equal(__maxaiRefreshStateSizeForTest(), 0);
}

function rejectsWith(code: keyof typeof MAXAI_REFRESH_ERRORS, status: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MaxaiRefreshError);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.message, MAXAI_REFRESH_ERRORS[code]);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes(PRIVATE_DETAIL));
    return true;
  };
}

function capturedResult(result: ExecutorExecuteResult) {
  assert.ok(!(result instanceof Response), "MaxAiExecutor must return its request capture");
  return result;
}

async function assertChatResult(result: ExecutorExecuteResult, accessToken: string): Promise<void> {
  const capture = capturedResult(result);
  assert.equal(capture.response.status, 200);
  assert.equal(capture.url, MAXAI_BASE_URL + MAXAI_CHAT_PATH);
  assert.equal(capture.headers?.Authorization, `Bearer ${accessToken}`);
  assert.ok(capture.transformedBody && typeof capture.transformedBody === "object");
  const body: unknown = await capture.response.json();
  assert.ok(body && typeof body === "object" && "choices" in body);
  assert.ok(Array.isArray(body.choices));
  const first: unknown = body.choices[0];
  assert.ok(first && typeof first === "object" && "message" in first);
  assert.ok(first.message && typeof first.message === "object" && "content" in first.message);
  assert.equal(first.message.content, "synthetic hello");
}

function queueDeferred<T>() {
  return Promise.withResolvers<T>();
}

async function queueWait<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  const cancelled = queueDeferred<never>();
  const abort = () => cancelled.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([pending, cancelled.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function runDeferredInnerQueue<T>(input: {
  provider: "maxai" | "mx";
  connectionId: string;
  marked: boolean;
  // Test topology controls only. None are passed to withRateLimit or credentials.
  blockerMarked?: boolean;
  submitBlocker?: <R>(submit: () => Promise<R>) => Promise<R>;
  submitTarget?: <R>(submit: () => Promise<R>) => Promise<R>;
  beforeRelease?: (limiter: Bottleneck, queuedId: string) => void | Promise<void>;
  afterRelease?: () => Promise<void>;
  signal?: AbortSignal;
  testSignal: AbortSignal;
  invoke: () => Promise<T>;
}) {
  assert.equal(isProbeContext(), false, "fixture setup must be outside the probe");
  await rateLimits.__resetRateLimitManagerForTests();
  const blockerEntered = queueDeferred<void>();
  const releaseBlocker = queueDeferred<void>();
  const failedDrain = queueDeferred<void>();
  const queued = queueDeferred<string>();
  const limiterFailure = queueDeferred<never>();
  // Install a rejection handler before a possible limiter event can reject this.
  void limiterFailure.promise.catch(() => {});
  const jobs: Promise<unknown>[] = [];
  const limiterHolder: { value?: Bottleneck } = {};
  const callbackValue: { value?: { result: T } } = {};
  let blockerProbe: boolean | undefined;
  let queuedJobProbe: boolean | undefined;
  let entered = false;
  let targetId: string | undefined;
  let creations = 0;

  const observeJob = <R>(job: Promise<R>): Promise<R> => {
    jobs.push(job);
    void job.catch(() => {});
    return job;
  };
  const endedBeforeBarrier = (job: Promise<unknown>) =>
    job.then(() => {
      throw new Error("Queue job ended before the deferred-queue barrier");
    });

  rateLimits.__setLimiterFactoryForTests((options) => {
    creations++;
    // Real Bottleneck; only capacity/settings are deterministic. Its native
    // local datastore, locks, events, queue and timers are not replaced.
    const realLimiter = new Bottleneck({
      ...options,
      datastore: "local",
      maxConcurrent: 1,
      minTime: 0,
      reservoir: null,
      reservoirRefreshAmount: null,
      reservoirRefreshInterval: null,
      reservoirIncreaseAmount: null,
      reservoirIncreaseInterval: null,
    });
    realLimiter.on("error", (error: unknown) => limiterFailure.reject(error));
    limiterHolder.value = realLimiter;
    return realLimiter;
  });
  rateLimits.enableRateLimitProtection(input.connectionId);

  try {
    // Existing cases keep an ordinary blocker. Reverse cases mark only its
    // submission, never the target callback. Collateral cases also add unrelated ALS.
    const enqueueBlocker = () =>
      rateLimits.withRateLimit(input.provider, input.connectionId, "gpt-5.6", async () => {
        blockerProbe = isProbeContext();
        blockerEntered.resolve();
        await releaseBlocker.promise;
      });
    const submitBlocker = () =>
      input.blockerMarked ? runAsProbe(enqueueBlocker) : enqueueBlocker();
    const blocker = observeJob(
      input.submitBlocker ? input.submitBlocker(submitBlocker) : submitBlocker()
    );
    await queueWait(
      Promise.race([blockerEntered.promise, endedBeforeBarrier(blocker), limiterFailure.promise]),
      input.testSignal
    );
    assert.equal(blockerProbe, input.blockerMarked ?? false);
    assert.ok(limiterHolder.value instanceof Bottleneck);
    const limiter = limiterHolder.value;
    assert.equal(limiter.counts().EXECUTING, 1);

    // These are observational listeners, not replacements for schedule/execute.
    // No assertions inside Bottleneck event callbacks: its Events implementation
    // catches callback exceptions, so assertions belong in the test continuation.
    limiter.once("queued", (info: Bottleneck.EventInfoQueued) => {
      targetId = info.options.id;
      queued.resolve(targetId);
    });
    limiter.on("debug", (message: string, info: unknown) => {
      if (
        targetId &&
        message === `Drained ${targetId}` &&
        info !== null &&
        typeof info === "object" &&
        "success" in info &&
        info.success === false
      ) {
        failedDrain.resolve();
      }
    });

    const enqueue = () =>
      rateLimits.withRateLimit(
        input.provider,
        input.connectionId,
        "gpt-5.6",
        async () => {
          entered = true;
          queuedJobProbe = isProbeContext();
          // CRITICAL: no runAsProbe/bind/snapshot around this callback.
          // invoke calls the ACTUAL MaxAiExecutor override + real coordinator,
          // with only its transport, fetch and store boundaries replaced.
          const result = await input.invoke();
          callbackValue.value = { result };
          return result;
        },
        input.signal ?? null
      );
    const submitTarget = () => (input.marked ? runAsProbe(enqueue) : enqueue());
    const target = observeJob(
      input.submitTarget ? input.submitTarget(submitTarget) : submitTarget()
    );
    assert.equal(isProbeContext(), false, "scheduling must not leak context into the test");

    // `queued` fires before Bottleneck's asynchronous first capacity check.
    // Also wait for that real first drain to fail while the blocker is held;
    // otherwise release could race the first drain into an immediate execution.
    const [queuedId] = await queueWait(
      Promise.race([
        Promise.all([queued.promise, failedDrain.promise]),
        endedBeforeBarrier(target),
        limiterFailure.promise,
      ]),
      input.testSignal
    );
    const barrierCounts = { ...limiter.counts() };
    assert.equal(creations, 1, "both jobs must use one real limiter");
    assert.equal(barrierCounts.QUEUED, 1, "target must remain deferred");
    assert.equal(barrierCounts.EXECUTING, 1, "outside-context blocker must hold the slot");
    assert.equal(entered, false, "target must not execute before release");
    const releaseProbe = isProbeContext();
    assert.equal(releaseProbe, false, "blocker release must occur outside probe context");
    if (input.beforeRelease) await input.beforeRelease(limiter, queuedId);
    releaseBlocker.resolve();
    if (input.afterRelease) await input.afterRelease();

    const [, scheduledResult] = await queueWait(
      Promise.race([Promise.all([blocker, target]), limiterFailure.promise]),
      input.testSignal
    );
    assert.equal(entered, true);
    assert.equal(isProbeContext(), false);
    assert.ok(callbackValue.value);
    assert.strictEqual(scheduledResult, callbackValue.value.result);
    const result = callbackValue.value.result;
    return { result, blockerProbe, queuedJobProbe, releaseProbe, queuedId, barrierCounts };
  } finally {
    // Safe even if a pre-release assertion fails or node:test cancels the test.
    releaseBlocker.resolve();
    try {
      if (limiterHolder.value) await limiterHolder.value.stop({ dropWaitingJobs: true });
    } finally {
      await Promise.allSettled(jobs);
      await rateLimits.__resetRateLimitManagerForTests();
    }
  }
}

for (const ttl of [1, 30, 3599, 3600, 86400]) {
  test(`probe TTL ${ttl}s returns the same current credential with zero refresh effects`, async () => {
    const f = makeFixture(Object.freeze(credential(ttl)));
    const before = f.store.snapshot();
    const result = await runAsProbe(() => ensureFreshMaxaiCredential(f.input));
    assert.strictEqual(result, f.value);
    assert.deepEqual(f.store.snapshot(), before);
    assert.deepEqual(f.fetchCalls, []);
    assertNoRefreshEffects(f);
  });
}

const invalidAccessTokens: Array<{ name: string; token: string }> = [
  { name: "expired", token: jwt({ sub: "fixture-user", exp: NOW / 1000 - 1 }) },
  { name: "at exact expiry", token: jwt({ sub: "fixture-user", exp: NOW / 1000 }) },
  { name: "malformed", token: "not-a-jwt" },
  { name: "missing exp", token: jwt({ sub: "fixture-user" }) },
  { name: "string exp", token: jwt({ sub: "fixture-user", exp: String(NOW / 1000 + 86400) }) },
  {
    name: "nonfinite exp",
    token: "synthetic." + Buffer.from('{"exp":1e999}').toString("base64url") + ".signature",
  },
];
for (const { name, token } of invalidAccessTokens) {
  for (const withRefreshToken of [false, true]) {
    test(`probe ${name}, refresh token ${withRefreshToken}: fixed expired error, zero effects`, async () => {
      const f = makeFixture({
        ...credential(),
        accessToken: token,
        refreshToken: withRefreshToken ? credential().refreshToken : undefined,
      });
      const before = f.store.snapshot();
      await assert.rejects(
        runAsProbe(() => ensureFreshMaxaiCredential(f.input)),
        rejectsWith("expired", 401)
      );
      assert.deepEqual(f.store.snapshot(), before);
      assert.deepEqual(f.fetchCalls, []);
      assertNoRefreshEffects(f);
    });
  }
}

test("probe still validates connection, cancellation and credential shape in that order", async () => {
  const f = makeFixture(credential(86400));
  const controller = new AbortController();
  controller.abort(new Error(PRIVATE_DETAIL));
  for (const connectionId of ["", " ", "\t\n"]) {
    await assert.rejects(
      runAsProbe(() =>
        ensureFreshMaxaiCredential({
          ...f.input,
          connectionId,
          signal: controller.signal,
          credential: { ...f.value, deviceId: "" },
        })
      ),
      rejectsWith("connection", 400)
    );
  }
  await assert.rejects(
    runAsProbe(() =>
      ensureFreshMaxaiCredential({
        ...f.input,
        signal: controller.signal,
        credential: { ...f.value, deviceId: "" },
      })
    ),
    rejectsWith("aborted", 499)
  );
  const invalidCredentials: MaxaiCredential[] = [
    { ...f.value, accessToken: "" },
    { ...f.value, accessToken: "bad\r\ntoken" },
    { ...f.value, refreshToken: "bad\u0000token" },
    { ...f.value, deviceId: "" },
    { ...f.value, deviceId: " padded " },
    { ...f.value, userId: "" },
  ];
  for (const value of invalidCredentials) {
    await assert.rejects(
      runAsProbe(() => ensureFreshMaxaiCredential({ ...f.input, credential: value })),
      rejectsWith("invalid", 401)
    );
  }
  assert.deepEqual(f.fetchCalls, []);
  assertNoRefreshEffects(f);
});

test("non-probe with the identical near-expiry credential performs one coordinated rotation", async () => {
  const f = makeFixture();
  const original = structuredClone(f.value);
  assert.equal(maxaiAccessTokenNeedsRefresh(f.value.accessToken), true);
  assert.equal(maxaiAccessTokenNeedsRefresh(f.value.accessToken, 0), false);
  assert.strictEqual(await runAsProbe(() => ensureFreshMaxaiCredential(f.input)), f.value);
  assertNoRefreshEffects(f);

  const result = await ensureFreshMaxaiCredential(f.input);
  assert.deepEqual(result, f.next);
  assert.deepEqual(f.value, original, "rotation must not mutate the caller snapshot");
  assert.deepEqual(f.store.row, f.next);
  assert.deepEqual(f.owner, { acquired: 1, active: 0, released: 1 });
  assert.deepEqual(f.store.calls, ["read", "acquire", "markSent", "commit", "read", "release"]);
  assert.equal(f.store.sends, 1);
  assert.equal(f.store.commits, 1);
  assert.equal(f.store.revision, 1);
  assert.equal(f.store.lease, null);
  assert.equal(f.store.acquisitions.length, 1);
  const lease = f.store.acquisitions[0];
  assert.ok(lease);
  assert.equal(lease.expectedCredentialVersion, "fixture-snapshot-0");
  assert.equal(lease.generation, maxaiRefreshGeneration(f.value.refreshToken ?? ""));
  assert.deepEqual(f.callbacks, [f.next]);
  assert.deepEqual(
    f.fetchCalls.map(({ url, method, probe }) => ({ url, method, probe })),
    [
      { url: MAXAI_WEBAPP_ORIGIN + MAXAI_WEBAPP_APP_PATH, method: "GET", probe: false },
      { url: MAXAI_BASE_URL + MAXAI_REFRESH_PATH, method: "POST", probe: false },
    ]
  );
  assert.equal(__maxaiRefreshStateSizeForTest(), 0);
});

test("normal rotation returns authoritative post-commit readback, not just the minted response", async () => {
  const f = makeFixture();
  const committedWinner = credential(86400, "later-committed-winner");
  const result = await ensureFreshMaxaiCredential({
    ...f.input,
    onCredentialsRefreshed: async (minted) => {
      await f.input.onCredentialsRefreshed?.(minted);
      assert.deepEqual(f.store.row, f.next);
      assert.equal(f.store.commits, 1);
      // Model a later durable writer between this commit and the final readback.
      f.store.row = { ...committedWinner };
      f.store.revision++;
    },
  });
  assert.deepEqual(result, committedWinner);
  assert.notEqual(result.accessToken, f.next.accessToken);
  assert.equal("credentialVersion" in result, false);
  assert.equal(f.store.calls.filter((call) => call === "read").length, 2);
  assert.equal(f.store.sends, 1);
  assert.equal(f.store.commits, 1);
  assert.deepEqual(f.callbacks, [f.next]);
});

test("caller-controlled probe-shaped fields cannot suppress normal rotation", async () => {
  const f = makeFixture();
  const callerInput = {
    ...f.input,
    probe: true,
    isProbe: true,
    isProbeContext: true,
    credential: { ...f.value, probe: true },
  };
  assert.equal(isProbeContext(), false);
  assert.deepEqual(await ensureFreshMaxaiCredential(callerInput), f.next);
  assert.equal(f.store.sends, 1);
  assert.equal(f.store.commits, 1);
  assert.equal(f.owner.acquired, 1);
});

test("normal no-refresh near credential and healthy credential remain unchanged", async () => {
  for (const value of [{ ...credential(), refreshToken: undefined }, credential(86400)]) {
    const f = makeFixture(value);
    assert.strictEqual(await ensureFreshMaxaiCredential(f.input), value);
    assert.deepEqual(f.fetchCalls, []);
    assertNoRefreshEffects(f);
  }
});

test(
  "probe never joins, clears or cancels an in-flight non-probe rotation",
  { timeout: 5000 },
  async (t) => {
    const f = makeFixture();
    const started = deferred<void>();
    const pendingResponse = deferred<Response>();
    const provider: { signal?: AbortSignal } = {};
    let normalSettled = false;
    f.behavior.refresh = (init) => {
      assert.ok(init.signal);
      provider.signal = init.signal;
      started.resolve();
      return pendingResponse.promise;
    };
    const normal = ensureFreshMaxaiCredential({ ...f.input, signal: t.signal });
    void normal.then(
      () => {
        normalSettled = true;
      },
      () => {
        normalSettled = true;
      }
    );
    const callers: Promise<MaxaiCredential>[] = [normal];
    try {
      await started.promise;
      const before = f.store.snapshot();
      const callsBefore = [...f.store.calls];
      const fetchesBefore = [...f.fetchCalls];
      assert.equal(__maxaiRefreshStateSizeForTest(), 1);
      assert.deepEqual(f.owner, { acquired: 1, active: 1, released: 0 });

      await assert.rejects(
        runAsProbe(() =>
          ensureFreshMaxaiCredential({
            ...f.input,
            signal: t.signal,
            credential: { ...f.value, accessToken: jwt({ exp: NOW / 1000 - 1 }) },
          })
        ),
        rejectsWith("expired", 401)
      );
      const probeController = new AbortController();
      const result = await runAsProbe(() =>
        ensureFreshMaxaiCredential({
          ...f.input,
          signal: AbortSignal.any([probeController.signal, t.signal]),
        })
      );
      assert.strictEqual(result, f.value);
      probeController.abort(new Error(PRIVATE_DETAIL));
      assert.equal(provider.signal?.aborted, false);
      assert.equal(normalSettled, false, "probe must finish while rotation is still held");
      assert.equal(__maxaiRefreshStateSizeForTest(), 1);
      assert.deepEqual(f.store.snapshot(), before);
      assert.deepEqual(f.store.calls, callsBefore);
      assert.deepEqual(f.fetchCalls, fetchesBefore);
      assert.deepEqual(f.callbacks, []);

      const follower = ensureFreshMaxaiCredential({ ...f.input, signal: t.signal });
      callers.push(follower);
      assert.equal(f.owner.acquired, 1, "a real follower must still join the original entry");
      pendingResponse.resolve(
        Response.json({
          access_token: f.next.accessToken,
          refresh_token: f.next.refreshToken,
        })
      );
      for (const value of await Promise.all(callers)) assert.deepEqual(value, f.next);
      assert.equal(f.store.sends, 1);
      assert.equal(f.store.commits, 1);
      assert.deepEqual(f.owner, { acquired: 1, active: 0, released: 1 });
      assert.equal(__maxaiRefreshStateSizeForTest(), 0);
    } finally {
      pendingResponse.resolve(
        Response.json({
          access_token: f.next.accessToken,
          refresh_token: f.next.refreshToken,
        })
      );
      await Promise.allSettled(callers);
    }
  }
);

test("probe neither consumes an existing cooldown nor prunes its expired coordinator entry", async () => {
  const f = makeFixture();
  f.behavior.refresh = () => new Response(PRIVATE_DETAIL, { status: 401 });
  await assert.rejects(ensureFreshMaxaiCredential(f.input), rejectsWith("failed", 401));
  assert.equal(__maxaiRefreshStateSizeForTest(), 1);
  const before = f.store.snapshot();
  const callsBefore = [...f.store.calls];
  const fetchesBefore = [...f.fetchCalls];
  const ownerBefore = { ...f.owner };
  assert.strictEqual(await runAsProbe(() => ensureFreshMaxaiCredential(f.input)), f.value);
  await assert.rejects(
    runAsProbe(() =>
      ensureFreshMaxaiCredential({
        ...f.input,
        credential: { ...f.value, accessToken: "not-a-jwt" },
      })
    ),
    rejectsWith("expired", 401)
  );
  const later = NOW + MAXAI_REFRESH_FAILURE_COOLDOWN_MS + 1;
  Date.now = () => later;
  const nearLater = { ...f.value, accessToken: jwt({ exp: later / 1000 + 30 }) };
  assert.strictEqual(
    await runAsProbe(() =>
      ensureFreshMaxaiCredential({
        ...f.input,
        credential: nearLater,
      })
    ),
    nearLater
  );
  assert.equal(__maxaiRefreshStateSizeForTest(), 1, "probe must not run coordinator pruning");
  assert.deepEqual(f.store.snapshot(), before);
  assert.deepEqual(f.store.calls, callsBefore);
  assert.deepEqual(f.fetchCalls, fetchesBefore);
  assert.deepEqual(f.owner, ownerBefore);
  assert.deepEqual(f.callbacks, []);
});

for (const ttl of [30, 86400]) {
  test(`actual MaxAiExecutor override: TTL ${ttl}s probe uses current bearer without refresh`, async () => {
    const f = makeFixture(credential(ttl));
    assert.strictEqual(f.executor.execute, MaxAiExecutor.prototype.execute);
    assert.notStrictEqual(f.executor.execute, BaseExecutor.prototype.execute);
    const before = structuredClone(f.executionInput.credentials);
    await assertChatResult(
      await runAsProbe(() => f.executor.execute(f.executionInput)),
      f.value.accessToken
    );
    assert.deepEqual(f.executorContexts, [true]);
    assert.deepEqual(f.coordinatorContexts, [true]);
    assert.deepEqual(f.transportConnections, [CONNECTION]);
    assert.deepEqual(f.executionInput.credentials, before);
    assert.equal(f.fetchCalls.length, 1);
    assert.equal(f.fetchCalls[0]?.url, MAXAI_BASE_URL + MAXAI_CHAT_PATH);
    assert.equal(f.fetchCalls[0]?.authorization, `Bearer ${f.value.accessToken}`);
    assert.equal(f.fetchCalls[0]?.probe, true);
    assertNoRefreshEffects(f);
  });
}

for (const accessToken of [jwt({ exp: NOW / 1000 - 1 }), "not-a-jwt"]) {
  test(`actual MaxAiExecutor probe denies ${accessToken === "not-a-jwt" ? "malformed" : "expired"} without a send`, async () => {
    const f = makeFixture({ ...credential(), accessToken });
    const capture = capturedResult(await runAsProbe(() => f.executor.execute(f.executionInput)));
    assert.equal(capture.response.status, 401);
    assert.deepEqual(capture.headers, {});
    assert.equal(capture.transformedBody, null);
    const body: unknown = await capture.response.json();
    assert.deepEqual(body, {
      error: {
        code: "maxai_account_unavailable",
        message: "MaxAI account or verified transport unavailable.",
        type: "invalid_request_error",
      },
    });
    assert.deepEqual(f.executorContexts, [true]);
    assert.deepEqual(f.coordinatorContexts, [true]);
    assert.deepEqual(f.fetchCalls, []);
    assertNoRefreshEffects(f);
  });
}

test("actual non-probe MaxAiExecutor sends only after committed credentials are read back", async () => {
  const f = makeFixture();
  await assertChatResult(await f.executor.execute(f.executionInput), f.next.accessToken);
  assert.deepEqual(f.executorContexts, [false]);
  assert.deepEqual(f.coordinatorContexts, [false]);
  assert.equal(f.store.sends, 1);
  assert.equal(f.store.commits, 1);
  assert.deepEqual(f.store.row, f.next);
  assert.deepEqual(f.callbacks, [f.next]);
  assert.deepEqual(f.genericPersistence, [], "executor must not re-persist its stale snapshot");
  const chat = f.fetchCalls.filter(({ url }) => url === MAXAI_BASE_URL + MAXAI_CHAT_PATH);
  assert.equal(chat.length, 1);
  assert.equal(chat[0]?.authorization, `Bearer ${f.next.accessToken}`);
  const committedAt = f.events.indexOf("store:commit");
  const readbackAt = f.events.lastIndexOf("store:read");
  const chatAt = f.events.indexOf("wire:chat");
  assert.ok(committedAt >= 0 && readbackAt > committedAt && chatAt > readbackAt);
  assert.equal(__maxaiRefreshStateSizeForTest(), 0);
});

test("real factory resolves canonical maxai and registry alias mx to the actual override", async () => {
  assert.equal(getRegistryEntry("mx")?.id, "maxai");
  for (const provider of ["maxai", "mx"]) {
    assert.equal(hasSpecializedExecutor(provider), true);
    const executor = await getExecutor(provider);
    assert.ok(executor instanceof MaxAiExecutor);
    assert.equal(executor.getProvider(), "maxai");
    assert.strictEqual(executor.execute, MaxAiExecutor.prototype.execute);
    assert.notStrictEqual(executor.execute, BaseExecutor.prototype.execute);
  }
  assert.equal(__maxaiRefreshStateSizeForTest(), 0);
});

for (const provider of ["maxai", "mx"] as const) {
  for (const withSignal of [false, true]) {
    for (const marked of [false, true]) {
      test(
        `real INNER queue ${provider}, ${withSignal ? "signal" : "no signal"}, ${marked ? "probe" : "normal"}: preserves origin at the actual override`,
        { timeout: 5000 },
        async (t) => {
          // Fresh isolates scheduler provenance from the refresh-boundary defect.
          const f = makeFixture(credential(86400));
          const signal = withSignal ? new AbortController().signal : undefined;
          const trace = await runDeferredInnerQueue({
            provider,
            connectionId: CONNECTION,
            marked,
            signal,
            testSignal: t.signal,
            invoke: () => f.executor.execute({ ...f.executionInput, signal }),
          });
          await assertChatResult(trace.result, f.value.accessToken);
          assert.equal(f.fetchCalls.length, 1);
          assert.equal(f.fetchCalls[0]?.url, MAXAI_BASE_URL + MAXAI_CHAT_PATH);
          assertNoRefreshEffects(f);
          const origins = {
            queued: trace.queuedJobProbe,
            executor: f.executorContexts,
            coordinator: f.coordinatorContexts,
            wire: f.fetchCalls.map(({ probe }) => probe),
          };
          t.diagnostic(
            JSON.stringify({
              barrierCounts: trace.barrierCounts,
              blockerProbe: trace.blockerProbe,
              releaseProbe: trace.releaseProbe,
              ...origins,
            })
          );
          assert.deepEqual(
            origins,
            { queued: marked, executor: [marked], coordinator: [marked], wire: [marked] },
            "real deferred INNER job must retain its origin at every actual boundary"
          );
        }
      );
    }
  }
}

test(
  "real INNER queued near-expiry probe does not rotate after outside-context release",
  { timeout: 5000 },
  async (t) => {
    const f = makeFixture();
    const trace = await runDeferredInnerQueue({
      provider: "maxai",
      connectionId: CONNECTION,
      marked: true,
      testSignal: t.signal,
      invoke: () => f.executor.execute(f.executionInput),
    });
    const origins = {
      queued: trace.queuedJobProbe,
      executor: f.executorContexts,
      coordinator: f.coordinatorContexts,
      wire: f.fetchCalls.map(({ probe }) => probe),
    };
    t.diagnostic(
      JSON.stringify({
        barrierCounts: trace.barrierCounts,
        blockerProbe: trace.blockerProbe,
        releaseProbe: trace.releaseProbe,
        ...origins,
      })
    );
    await assertChatResult(trace.result, f.value.accessToken);
    assert.equal(f.fetchCalls.length, 1);
    assertNoRefreshEffects(f);
    assert.deepEqual(origins, {
      queued: true,
      executor: [true],
      coordinator: [true],
      wire: [true],
    });
  }
);

// Reverse isolation: preserving a probe must not label a later ordinary job as a probe.
for (const provider of ["maxai", "mx"] as const) {
  for (const withSignal of [false, true]) {
    test(
      `real INNER queue ${provider}, ${withSignal ? "signal" : "no signal"}: ordinary target cannot inherit a preceding probe blocker`,
      { timeout: 5000 },
      async (t) => {
        const f = makeFixture(credential(86400));
        const signal = withSignal ? new AbortController().signal : undefined;
        const trace = await runDeferredInnerQueue({
          provider,
          connectionId: CONNECTION,
          marked: false,
          blockerMarked: true,
          signal,
          testSignal: t.signal,
          invoke: () => f.executor.execute({ ...f.executionInput, signal }),
        });
        await assertChatResult(trace.result, f.value.accessToken);
        assert.equal(trace.blockerProbe, true);
        assert.equal(trace.releaseProbe, false);
        assert.equal(f.fetchCalls.length, 1);
        assert.equal(f.fetchCalls[0]?.url, MAXAI_BASE_URL + MAXAI_CHAT_PATH);
        assertNoRefreshEffects(f);
        const origins = {
          queued: trace.queuedJobProbe,
          executor: f.executorContexts,
          coordinator: f.coordinatorContexts,
          wire: f.fetchCalls.map(({ probe }) => probe),
        };
        t.diagnostic(
          JSON.stringify({
            barrierCounts: trace.barrierCounts,
            blockerProbe: trace.blockerProbe,
            releaseProbe: trace.releaseProbe,
            ...origins,
          })
        );
        assert.deepEqual(
          origins,
          { queued: false, executor: [false], coordinator: [false], wire: [false] },
          "ordinary queued job must restore the absence of the trusted probe marker"
        );
      }
    );
  }
}

for (const marked of [false, true]) {
  for (const probeCanDisable of [false, true]) {
    test(
      `real INNER queue uses actual probe-failure policy: marked=${marked}, probeCanDisable=${probeCanDisable}`,
      { timeout: 5000 },
      async (t) => {
        // Submit under the opposite setting; only the live dispatch value counts.
        probePolicy.probeCanDisable = !probeCanDisable;
        const f = makeFixture(credential(86400));
        const decisions: boolean[] = [];
        const trace = await runDeferredInnerQueue({
          provider: "maxai",
          connectionId: CONNECTION,
          marked,
          blockerMarked: !marked,
          testSignal: t.signal,
          beforeRelease() {
            probePolicy.probeCanDisable = probeCanDisable;
          },
          invoke: async () => {
            decisions.push(await shouldIsolateProbeFailures());
            return f.executor.execute(f.executionInput);
          },
        });
        await assertChatResult(trace.result, f.value.accessToken);
        assert.equal(f.fetchCalls.length, 1);
        assertNoRefreshEffects(f);
        const observed = {
          queued: trace.queuedJobProbe,
          executor: f.executorContexts,
          coordinator: f.coordinatorContexts,
          wire: f.fetchCalls.map(({ probe }) => probe),
          decisions,
          flagReads: probePolicy.flagReads,
          settingsReads: probePolicy.settingsReads,
        };
        t.diagnostic(JSON.stringify({ barrierCounts: trace.barrierCounts, ...observed }));
        assert.deepEqual(observed, {
          queued: marked,
          executor: [marked],
          coordinator: [marked],
          wire: [marked],
          decisions: [marked && !probeCanDisable],
          flagReads: marked ? 1 : 0,
          settingsReads: marked ? 1 : 0,
        });
      }
    );
  }
}

for (const marked of [false, true]) {
  test(
    `real INNER queue caller cancellation preserves origin and the actual executor abort: marked=${marked}`,
    { timeout: 5000 },
    async (t) => {
      const f = makeFixture(credential(86400));
      const caller = new AbortController();
      const reason = new Error("synthetic queued caller cancellation");
      const rawTask = queueDeferred<{ promise: Promise<ExecutorExecuteResult> }>();
      const taskDone = queueDeferred<void>();
      const limiterIdle = queueDeferred<void>();
      const origins: boolean[] = [];
      let rawSettled = false;
      let barrierCounts: Bottleneck.Counts | undefined;
      await assert.rejects(
        runDeferredInnerQueue({
          provider: "maxai",
          connectionId: CONNECTION,
          marked,
          blockerMarked: !marked,
          signal: caller.signal,
          testSignal: t.signal,
          beforeRelease(limiter, queuedId) {
            barrierCounts = { ...limiter.counts() };
            limiter.on("done", (info: Bottleneck.EventInfoRetryable) => {
              if (info.options.id === queuedId) taskDone.resolve();
            });
            limiter.once("idle", () => limiterIdle.resolve());
            caller.abort(reason);
          },
          async afterRelease() {
            // withRateLimit cancels the caller's wait, not the scheduled task.
            // Observe the real later callback and its exact executor Promise;
            // never let helper stop/reset hide an orphaned dispatch or rejection.
            const raw = await queueWait(rawTask.promise, t.signal);
            await assert.rejects(raw.promise, (error: unknown) => error === reason);
            rawSettled = true;
            await queueWait(Promise.all([taskDone.promise, limiterIdle.promise]), t.signal);
          },
          invoke: () => {
            origins.push(isProbeContext());
            const promise = f.executor.execute({ ...f.executionInput, signal: caller.signal });
            rawTask.resolve({ promise });
            return promise;
          },
        }),
        (error: unknown) => error === reason
      );
      assert.equal(rawSettled, true);
      assert.deepEqual(f.executorContexts, [], "abort must precede transport entry");
      assert.deepEqual(f.coordinatorContexts, []);
      assert.deepEqual(f.fetchCalls, []);
      assertNoRefreshEffects(f);
      assert.equal(isProbeContext(), false);
      t.diagnostic(JSON.stringify({ barrierCounts, callback: origins, rawSettled }));
      assert.deepEqual(origins, [marked]);
    }
  );
}

for (const marked of [false, true]) {
  for (const rejectedPromise of [false, true]) {
    test(
      `real INNER queued branded ${rejectedPromise ? "explicit rejection" : "async-function throw"} preserves identity after actual MaxAI execution: marked=${marked}`,
      { timeout: 5000 },
      async (t) => {
        const f = makeFixture(credential(86400));
        const error = new RuntimePolicyError("proxy-forbidden");
        const callbacks: boolean[] = [];
        let barrierCounts: Bottleneck.Counts | undefined;
        await assert.rejects(
          runDeferredInnerQueue({
            provider: "maxai",
            connectionId: CONNECTION,
            marked,
            blockerMarked: !marked,
            testSignal: t.signal,
            beforeRelease(limiter) {
              barrierCounts = { ...limiter.counts() };
            },
            invoke: async () => {
              callbacks.push(isProbeContext());
              await assertChatResult(
                await f.executor.execute(f.executionInput),
                f.value.accessToken
              );
              // Both forms reject an async manager callback after a real override
              // succeeds. Raw synchronous binder throws are tested separately below.
              if (rejectedPromise) return Promise.reject(error);
              throw error;
            },
          }),
          (actual: unknown) => actual === error && isRuntimePolicyError(actual)
        );
        assert.equal(f.fetchCalls.length, 1);
        assertNoRefreshEffects(f);
        assert.equal(isProbeContext(), false);
        const ordinary = makeFixture(credential(86400, "after-error"));
        await assertChatResult(
          await ordinary.executor.execute(ordinary.executionInput),
          ordinary.value.accessToken
        );
        assertNoRefreshEffects(ordinary);
        const observed = {
          callback: callbacks,
          executor: f.executorContexts,
          coordinator: f.coordinatorContexts,
          wire: f.fetchCalls.map(({ probe }) => probe),
          ordinaryExecutor: ordinary.executorContexts,
          ordinaryCoordinator: ordinary.coordinatorContexts,
        };
        t.diagnostic(JSON.stringify({ barrierCounts, ...observed }));
        assert.deepEqual(observed, {
          callback: [marked],
          executor: [marked],
          coordinator: [marked],
          wire: [marked],
          ordinaryExecutor: [false],
          ordinaryCoordinator: [false],
        });
      }
    );
  }
}

// Generic collateral-ALS contract only. This is not a C permit/borrowed-slot test.
// A whole-process AsyncLocalStorage.bind/snapshot would restore the expired
// submission store; a probe-only binder must leave invocation-time ALS alone.
for (const marked of [false, true]) {
  for (const invocationHasStore of [false, true]) {
    test(
      `real INNER queue changes only probe origin: marked=${marked}, unrelated invocation store=${invocationHasStore}`,
      { timeout: 5000 },
      async (t) => {
        const unrelated = new AsyncLocalStorage<{ live: boolean }>();
        const submittedOuter = { live: true };
        const submitted = { live: true };
        const invocation = { live: true };
        const expected = invocationHasStore ? invocation : undefined;
        const seen: Array<{ live: boolean } | undefined> = [];
        const f = makeFixture(credential(86400));
        try {
          const trace = await runDeferredInnerQueue({
            provider: "maxai",
            connectionId: CONNECTION,
            marked,
            blockerMarked: !marked,
            testSignal: t.signal,
            submitBlocker: (submit) =>
              invocationHasStore ? unrelated.run(invocation, submit) : submit(),
            submitTarget: (submit) =>
              unrelated.run(submittedOuter, () => unrelated.run(submitted, submit)),
            beforeRelease() {
              assert.equal(unrelated.getStore(), undefined);
              submittedOuter.live = false;
              submitted.live = false;
            },
            invoke: () => {
              seen.push(unrelated.getStore());
              return f.executor.execute(f.executionInput);
            },
          });
          await assertChatResult(trace.result, f.value.accessToken);
          assert.equal(f.fetchCalls.length, 1);
          assertNoRefreshEffects(f);
          assert.equal(seen.length, 1);
          assert.equal(unrelated.getStore(), undefined);
          const observed = {
            queued: trace.queuedJobProbe,
            executor: f.executorContexts,
            coordinator: f.coordinatorContexts,
            wire: f.fetchCalls.map(({ probe }) => probe),
            expiredSubmissionRestored: seen[0] === submitted || seen[0] === submittedOuter,
            invocationScopePreserved: seen[0] === expected,
            submissionClosedBeforeDispatch: !submitted.live && !submittedOuter.live,
          };
          t.diagnostic(JSON.stringify({ barrierCounts: trace.barrierCounts, ...observed }));
          assert.deepEqual(observed, {
            queued: marked,
            executor: [marked],
            coordinator: [marked],
            wire: [marked],
            expiredSubmissionRestored: false,
            invocationScopePreserved: true,
            submissionClosedBeforeDispatch: true,
          });
        } finally {
          unrelated.disable();
        }
      }
    );
  }
}

test(
  "ordinary near-expiry MaxAI request still rotates after a probe blocker",
  { timeout: 5000 },
  async (t) => {
    const f = makeFixture();
    const trace = await runDeferredInnerQueue({
      provider: "maxai",
      connectionId: CONNECTION,
      marked: false,
      blockerMarked: true,
      testSignal: t.signal,
      invoke: () => f.executor.execute(f.executionInput),
    });
    const observed = {
      queued: trace.queuedJobProbe,
      executor: f.executorContexts,
      coordinator: f.coordinatorContexts,
      wire: f.fetchCalls.map(({ probe }) => probe),
      owners: f.owner.acquired,
      sent: f.store.sends,
      commits: f.store.commits,
    };
    t.diagnostic(JSON.stringify({ barrierCounts: trace.barrierCounts, ...observed }));
    await assertChatResult(trace.result, f.next.accessToken);
    assert.deepEqual(f.store.row, f.next);
    assert.deepEqual(f.callbacks, [f.next]);
    assert.deepEqual(f.genericPersistence, []);
    assert.deepEqual(observed, {
      queued: false,
      executor: [false],
      coordinator: [false],
      wire: [false, false, false],
      owners: 1,
      sent: 1,
      commits: 1,
    });
    assert.equal(__maxaiRefreshStateSizeForTest(), 0);
  }
);

for (const marked of [false, true]) {
  test(
    `nested probes restore the real deferred callback's origin: marked=${marked}`,
    { timeout: 5000 },
    async (t) => {
      const f = makeFixture(credential(86400));
      const nested: boolean[] = [];
      const trace = await runDeferredInnerQueue({
        provider: "maxai",
        connectionId: CONNECTION,
        marked,
        blockerMarked: !marked,
        testSignal: t.signal,
        invoke: async () => {
          nested.push(isProbeContext());
          await runAsProbe(async () => {
            nested.push(isProbeContext());
            await runAsProbe(async () => {
              await Promise.resolve();
              nested.push(isProbeContext());
            });
            nested.push(isProbeContext());
          });
          nested.push(isProbeContext());
          return f.executor.execute(f.executionInput);
        },
      });
      await assertChatResult(trace.result, f.value.accessToken);
      assert.equal(f.fetchCalls.length, 1);
      assertNoRefreshEffects(f);
      const observed = {
        queued: trace.queuedJobProbe,
        nested,
        executor: f.executorContexts,
        coordinator: f.coordinatorContexts,
        wire: f.fetchCalls.map(({ probe }) => probe),
      };
      t.diagnostic(JSON.stringify({ barrierCounts: trace.barrierCounts, ...observed }));
      assert.deepEqual(observed, {
        queued: marked,
        nested: [marked, true, true, true, marked],
        executor: [marked],
        coordinator: [marked],
        wire: [marked],
      });
      assert.equal(isProbeContext(), false);
    }
  );
}

test(
  "concurrent real INNER jobs keep independent probe and ordinary origins",
  { timeout: 5000 },
  async (t) => {
    await rateLimits.__resetRateLimitManagerForTests();
    const releaseBlockers = queueDeferred<void>();
    const releaseTargets = queueDeferred<void>();
    const blockersEntered = [queueDeferred<void>(), queueDeferred<void>()];
    const limiterFailure = queueDeferred<never>();
    void limiterFailure.promise.catch(() => {});
    const holder: { limiter?: Bottleneck } = {};
    const jobs: Promise<unknown>[] = [];
    const blockerOrigins: boolean[] = [];
    let creations = 0;
    const track = <R>(pending: Promise<R>): Promise<R> => {
      jobs.push(pending);
      void pending.catch(() => {});
      return pending;
    };
    const endedTooSoon = (pending: Promise<unknown>) =>
      pending.then(() => {
        throw new Error("Concurrent fixture job finished before its release barrier");
      });
    const targets = [true, false].map((marked) => {
      const callbackOrigins: boolean[] = [];
      return {
        marked,
        fixture: makeFixture(credential(86400)),
        entered: queueDeferred<void>(),
        callbackOrigins,
      };
    });
    const results = new Map<number, ExecutorExecuteResult>();
    const targetPromises: Promise<unknown>[] = [];
    const queueBarriers: Bottleneck.Counts[] = [];
    rateLimits.__setLimiterFactoryForTests((options) => {
      creations++;
      const limiter = new Bottleneck({
        ...options,
        datastore: "local",
        maxConcurrent: 2,
        minTime: 0,
        reservoir: null,
        reservoirRefreshAmount: null,
        reservoirRefreshInterval: null,
        reservoirIncreaseAmount: null,
        reservoirIncreaseInterval: null,
      });
      limiter.on("error", (error: unknown) => limiterFailure.reject(error));
      holder.limiter = limiter;
      return limiter;
    });
    rateLimits.enableRateLimitProtection(CONNECTION);
    try {
      assert.equal(isProbeContext(), false);
      const blockers = blockersEntered.map((entered) =>
        track(
          rateLimits.withRateLimit("maxai", CONNECTION, MODEL, async () => {
            blockerOrigins.push(isProbeContext());
            entered.resolve();
            await releaseBlockers.promise;
          })
        )
      );
      await queueWait(
        Promise.race([
          Promise.all(blockersEntered.map(({ promise }) => promise)),
          endedTooSoon(Promise.all(blockers)),
          limiterFailure.promise,
        ]),
        t.signal
      );
      assert.deepEqual(blockerOrigins, [false, false]);
      assert.ok(holder.limiter instanceof Bottleneck);
      const limiter = holder.limiter;
      assert.equal(limiter.counts().EXECUTING, 2);
      let firstQueuedId: string | undefined;
      for (const [index, target] of targets.entries()) {
        const queued = queueDeferred<string>();
        const failedDrain = queueDeferred<void>();
        let id: string | undefined;
        limiter.once("queued", (info: Bottleneck.EventInfoQueued) => {
          id = info.options.id;
          firstQueuedId ??= id;
          queued.resolve(id);
        });
        limiter.on("debug", (message: string, info: unknown) => {
          // Later submissions attempt to drain the older queue head first.
          if (
            id &&
            firstQueuedId &&
            message === `Drained ${firstQueuedId}` &&
            info !== null &&
            typeof info === "object" &&
            "success" in info &&
            info.success === false
          ) {
            failedDrain.resolve();
          }
        });
        const submit = () =>
          rateLimits.withRateLimit("maxai", CONNECTION, MODEL, async () => {
            target.callbackOrigins.push(isProbeContext());
            target.entered.resolve();
            await releaseTargets.promise;
            const result = await target.fixture.executor.execute(target.fixture.executionInput);
            results.set(index, result);
            return result;
          });
        const pending = track(target.marked ? runAsProbe(submit) : submit());
        targetPromises.push(pending);
        await queueWait(
          Promise.race([
            Promise.all([queued.promise, failedDrain.promise]),
            endedTooSoon(pending),
            limiterFailure.promise,
          ]),
          t.signal
        );
        const counts = { ...limiter.counts() };
        queueBarriers.push(counts);
        assert.equal(counts.QUEUED, index + 1);
        assert.equal(counts.EXECUTING, 2);
        assert.deepEqual(target.callbackOrigins, []);
      }
      assert.equal(creations, 1);
      assert.equal(isProbeContext(), false);
      releaseBlockers.resolve();
      await queueWait(
        Promise.race([
          Promise.all(targets.map(({ entered }) => entered.promise)),
          endedTooSoon(Promise.all(targetPromises)),
          limiterFailure.promise,
        ]),
        t.signal
      );
      const concurrentCounts = { ...limiter.counts() };
      assert.equal(concurrentCounts.EXECUTING, 2, "both distinct-origin callbacks must be active");
      releaseTargets.resolve();
      const scheduled = await queueWait(
        Promise.race([Promise.all(targetPromises), limiterFailure.promise]),
        t.signal
      );
      await Promise.all(blockers);
      const observed: Array<{
        callback: boolean[];
        executor: boolean[];
        coordinator: boolean[];
        wire: boolean[];
      }> = [];
      for (const [index, target] of targets.entries()) {
        const result = results.get(index);
        assert.ok(result);
        assert.strictEqual(scheduled[index], result);
        await assertChatResult(result, target.fixture.value.accessToken);
        assert.equal(target.fixture.fetchCalls.length, 1);
        assertNoRefreshEffects(target.fixture);
        observed.push({
          callback: target.callbackOrigins,
          executor: target.fixture.executorContexts,
          coordinator: target.fixture.coordinatorContexts,
          wire: target.fixture.fetchCalls.map(({ probe }) => probe),
        });
      }
      t.diagnostic(JSON.stringify({ queueBarriers, concurrentCounts, observed }));
      assert.deepEqual(
        observed,
        targets.map(({ marked }) => ({
          callback: [marked],
          executor: [marked],
          coordinator: [marked],
          wire: [marked],
        }))
      );
      assert.equal(isProbeContext(), false);
    } finally {
      releaseBlockers.resolve();
      releaseTargets.resolve();
      try {
        if (holder.limiter) await holder.limiter.stop({ dropWaitingJobs: true });
      } finally {
        await Promise.allSettled(jobs);
        await rateLimits.__resetRateLimitManagerForTests();
      }
    }
  }
);

test(
  "ordinary queued callback may intentionally enter a nested trusted probe",
  { timeout: 5000 },
  async (t) => {
    const f = makeFixture();
    const decisions: boolean[] = [];
    const trace = await runDeferredInnerQueue({
      provider: "maxai",
      connectionId: CONNECTION,
      marked: false,
      blockerMarked: true,
      testSignal: t.signal,
      // Unlike fixture rebinding, this is an explicit application action inside
      // an ordinary callback. It must remain able to enter a trusted child probe.
      invoke: () =>
        runAsProbe(async () => {
          decisions.push(await shouldIsolateProbeFailures());
          return f.executor.execute(f.executionInput);
        }),
    });
    await assertChatResult(trace.result, f.value.accessToken);
    assert.equal(f.fetchCalls.length, 1);
    assertNoRefreshEffects(f);
    const observed = {
      queued: trace.queuedJobProbe,
      executor: f.executorContexts,
      coordinator: f.coordinatorContexts,
      wire: f.fetchCalls.map(({ probe }) => probe),
      decisions,
    };
    t.diagnostic(JSON.stringify({ barrierCounts: trace.barrierCounts, ...observed }));
    assert.deepEqual(observed, {
      queued: false,
      executor: [true],
      coordinator: [true],
      wire: [true],
      decisions: [true],
    });
    assert.equal(isProbeContext(), false);
  }
);

for (const captured of [false, true]) {
  test(`probe-only binder contract preserves this, arguments and exact outcomes: captured=${captured}`, async () => {
    // Keep the pre-source baseline loadable. An absent new export fails ONLY
    // these two contract cases, not the original queue/boundary regression suite.
    const probeModule = await import("../../src/shared/utils/probeOrigin.ts");
    const binder: unknown = Reflect.get(probeModule, "bindProbeContext");
    assert.ok(
      typeof binder === "function",
      "bindProbeContext export is required for this contract"
    );
    assert.equal(isProbeContext(), false);

    const receiver = { id: "synthetic-method-receiver" };
    const value = { result: "synthetic-result" };
    const pending = queueDeferred<typeof value>();
    const branded = new RuntimePolicyError("proxy-forbidden");
    const rejected = Promise.reject(branded);
    void rejected.catch(() => {});
    type Mode = "value" | "promise" | "throw" | "reject";
    const calls: Array<{
      receiverMatches: boolean;
      mode: Mode;
      tag: string;
      count: number;
      probe: boolean;
    }> = [];
    function method(this: typeof receiver, mode: Mode, tag: string, count: number) {
      calls.push({ receiverMatches: this === receiver, mode, tag, count, probe: isProbeContext() });
      if (mode === "throw") throw branded;
      if (mode === "reject") return rejected;
      if (mode === "promise") return pending.promise;
      return value;
    }
    const capture = async () => {
      assert.equal(isProbeContext(), captured);
      const bound: unknown = Reflect.apply(binder, undefined, [method]);
      assert.ok(typeof bound === "function", "binder must return a callable wrapper");
      return bound;
    };
    const bound = await (captured ? runAsProbe(capture) : capture());
    assert.equal(isProbeContext(), false);
    const invokeUnderOppositeOrigin = async () => {
      assert.equal(isProbeContext(), !captured);
      const syncResult: unknown = Reflect.apply(bound, receiver, ["value", "fixture-tag", 7]);
      assert.strictEqual(syncResult, value);
      assert.equal(isProbeContext(), !captured, "sync return must restore invocation origin");

      const promiseResult: unknown = Reflect.apply(bound, receiver, ["promise", "fixture-tag", 7]);
      assert.strictEqual(
        promiseResult,
        pending.promise,
        "binder must not wrap the returned Promise"
      );
      assert.equal(isProbeContext(), !captured);
      pending.resolve(value);
      assert.strictEqual(await pending.promise, value);
      assert.equal(isProbeContext(), !captured);

      // This invocation throws synchronously. Turning it into a rejection fails
      // assert.throws, unlike the async callback error cases above.
      assert.throws(
        () => {
          const unexpectedResult: unknown = Reflect.apply(bound, receiver, [
            "throw",
            "fixture-tag",
            7,
          ]);
          // A wrong async wrapper must fail assert.throws without leaving an
          // unhandled rejection behind the useful contract failure.
          if (unexpectedResult instanceof Promise) void unexpectedResult.catch(() => {});
        },
        (error: unknown) => error === branded && isRuntimePolicyError(error)
      );
      assert.equal(isProbeContext(), !captured, "raw throw must restore invocation origin");

      const rejectedResult: unknown = Reflect.apply(bound, receiver, ["reject", "fixture-tag", 7]);
      assert.strictEqual(rejectedResult, rejected, "rejected Promise identity must also survive");
      assert.ok(rejectedResult instanceof Promise);
      await assert.rejects(
        rejectedResult,
        (error: unknown) => error === branded && isRuntimePolicyError(error)
      );
      assert.equal(isProbeContext(), !captured, "rejection must not leak captured origin");
    };
    if (captured) await invokeUnderOppositeOrigin();
    else await runAsProbe(invokeUnderOppositeOrigin);
    assert.equal(isProbeContext(), false);
    const modes: Mode[] = ["value", "promise", "throw", "reject"];
    assert.deepEqual(
      calls,
      modes.map((mode) => ({
        receiverMatches: true,
        mode,
        tag: "fixture-tag",
        count: 7,
        probe: captured,
      }))
    );
  });
}
