/** Offline regression tests. The real route and email helpers run with inert DB/auth/wire stubs. */
import assert from "node:assert/strict";
import { RuntimePolicyError, isRuntimePolicyResponse } from "../../src/shared/runtimePolicy.ts";
import { registerHooks } from "node:module";
import { getEventListeners } from "node:events";
import test from "node:test";
import type { MaxaiSigningConstants } from "../../open-sse/executors/maxai/constants.ts";

const EMAIL = "login@example.com";
const DEVICE_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_USER_ID = "33333333-3333-4333-8333-333333333333";
const PRIVATE_DETAIL =
  "fake-access-token fake-refresh-token proxy-password at /private/test.ts:1:1";
const FAILURE = "MaxAI sign-in failed. Please try again.";
type RecordData = Record<string, unknown>;
type ConstantsOptions = { fetchImpl?: typeof fetch; signal?: AbortSignal | null };

const state = {
  connection: { id: "maxai-test", provider: "maxai", providerSpecificData: {} } as RecordData,
  events: [] as string[],
  writes: [] as RecordData[],
  requests: [] as { url: string; init?: RequestInit }[],
  signatures: [] as { path: string; deviceId: string }[],
  constantsCalls: [] as ConstantsOptions[],
  scope: 0,
  denied: false,
  failScope: false,
  freshConnection: async (): Promise<RecordData | null> => null,
  wire: (async () => Response.json({ data: { status: "OK" } })) as typeof fetch,
  persist: async (_id: string, data: RecordData): Promise<unknown> => data,
  constants: async (_opts: ConstantsOptions): Promise<MaxaiSigningConstants | null> => null,
};
const symbol = Symbol.for("omniroute.maxai-login-safety-test");
Object.defineProperty(globalThis, symbol, { value: state, configurable: true });
const stubPrelude = 'const s = globalThis[Symbol.for("omniroute.maxai-login-safety-test")];';
const stubs = new Map<string, string>([
  [
    "next/server",
    "export const NextResponse = { json: (body, init) => Response.json(body, init) };",
  ],
  [
    "@/lib/db/readCache",
    `export async function getCachedProviderConnectionById() {
    s.events.push("read"); return s.connection;
  }`,
  ],
  [
    "@/lib/db/providers",
    `export async function updateProviderConnection(id, data) {
    s.events.push("persist"); s.writes.push(data); return s.persist(id, data);
  }
  export async function getProviderConnectionById() {
    s.events.push("fresh-read"); return s.freshConnection();
  }`,
  ],
  [
    "@/lib/api/requireManagementAuth",
    `export async function requireManagementAuth() {
    s.events.push("auth"); return s.denied ? Response.json({error:"denied"}, {status:403}) : null;
  }`,
  ],
  ["@/lib/api/loginTimeout", "export const clampLoginTimeoutMs = () => 300000;"],
  [
    "@omniroute/open-sse/utils/error.ts",
    'export { runtimePolicyErrorResponse } from "file:///home/ubuntu/_/omni/ws/local-next/open-sse/utils/error.ts"; export const sanitizeErrorMessage = (value) => String(value);',
  ],
  [
    "maxai/constantsStore.ts",
    `export async function ensureMaxaiConstants(opts) {
    s.events.push("constants"); s.constantsCalls.push(opts); return s.constants(opts);
  }`,
  ],
  [
    "maxai/signing.ts",
    `export function buildMaxaiSignedHeaders(input) {
    s.signatures.push(input); return {"X-Authorization":"synthetic-signature"};
  }`,
  ],
  [
    "maxaiTransport.ts",
    `export async function runMaxaiConnectionTransport(id, fn) {
    s.events.push("scope:" + id);
    if (s.failScope) throw new Error("${PRIVATE_DETAIL}");
    s.scope++;
    try { return await fn(); } finally { s.scope--; s.events.push("scope:end"); }
  }
  export const maxaiFetch = (url, init) => {
    if (!s.scope) throw new Error("No approved connection scope");
    return s.wire(url, init);
  };`,
  ],
]);

// Resolve only narrow dependencies. No production database, auth, browser or transport is loaded.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "file:///home/ubuntu/_/omni/ws/local-next/open-sse/utils/error.ts")
      return nextResolve(specifier, context);
    if (specifier === "@/lib/db/featureFlags")
      return {
        url: "data:text/javascript,export const getFeatureFlagOverride=()=>undefined;",
        shortCircuit: true,
      };
    let key = specifier;
    if (specifier.endsWith("/utils/error.ts")) key = "@omniroute/open-sse/utils/error.ts";
    if (specifier.endsWith("/maxaiTransport.ts")) key = "maxaiTransport.ts";
    if (specifier === "./constantsStore.ts") key = "maxai/constantsStore.ts";
    if (specifier === "./signing.ts") key = "maxai/signing.ts";
    const source = stubs.get(key);
    if (source !== undefined) {
      return {
        url: `data:text/javascript,${encodeURIComponent(stubPrelude + source)}`,
        shortCircuit: true,
      };
    }
    if (specifier.includes("/lib/db/") || specifier.includes("BrowserLogin")) {
      throw new Error("Unexpected real side-effect module in offline login test");
    }
    return nextResolve(specifier, context);
  },
});

const login = await import("../../open-sse/executors/maxai/emailLogin.ts");
const route = await import("../../src/app/api/providers/[id]/login/route.ts");
const { MOCK_CONSTANTS } = await import("./helpers/maxaiMockConstants.ts");
const nativeFetch = globalThis.fetch;

function pending(): RecordData {
  return {
    maxaiDeviceId: DEVICE_ID,
    maxaiClientUserId: CLIENT_USER_ID,
    maxaiLoginEmail: EMAIL,
  };
}

function successCredential(overrides: RecordData = {}) {
  return Response.json({
    data: {
      status: "OK",
      auth_user: {
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        userId: "11111111-1111-4111-8111-111111111111",
        email: EMAIL,
        clientUserId: CLIENT_USER_ID,
        ...overrides,
      },
    },
  });
}

async function post(body: unknown, signal?: AbortSignal) {
  const req = new Request("http://localhost/api/providers/maxai-test/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const response = await route.POST(req as Parameters<typeof route.POST>[0], {
    params: Promise.resolve({ id: "maxai-test" }),
  });
  return { response, body: (await response.json()) as RecordData };
}

function captureWire(reply: () => Response = () => Response.json({ data: { status: "OK" } })) {
  state.wire = async (url, init) => {
    state.events.push("wire");
    state.requests.push({ url: String(url), init });
    return reply();
  };
}

test.beforeEach(() => {
  state.connection = { id: "maxai-test", provider: "maxai", providerSpecificData: {} };
  state.events = [];
  state.writes = [];
  state.requests = [];
  state.signatures = [];
  state.constantsCalls = [];
  state.scope = 0;
  state.denied = false;
  state.failScope = false;
  state.freshConnection = async () => state.connection;
  state.persist = async (_id, data) => {
    state.connection = { ...state.connection, ...data };
    return state.connection;
  };
  state.constants = async () => MOCK_CONSTANTS;
  captureWire();
  // Guard the old default too: a regression can never make a real network call.
  globalThis.fetch = (url, init) => state.wire(url, init);
});
test.afterEach(() => {
  globalThis.fetch = nativeFetch;
});
test.after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, symbol);
});

for (const result of [null, false, undefined]) {
  test(`request: failed persistence (${String(result)}) prevents even constants fetch`, async () => {
    state.persist = async () => result;
    const res = await post({ step: "request", email: EMAIL });
    assert.equal(state.constantsCalls.length, 0);
    assert.equal(state.requests.length, 0);
    assert.equal(res.response.status, 500);
    assert.deepEqual(res.body, { success: false, error: FAILURE });
  });
}

test("request: thrown persistence error is redacted and stops before network", async () => {
  state.persist = async () => {
    throw new Error(PRIVATE_DETAIL);
  };
  const res = await post({ step: "request", email: EMAIL });
  assert.equal(state.requests.length, 0);
  assert.equal(state.constantsCalls.length, 0);
  assert.deepEqual(res.body, { success: false, error: FAILURE });
});

test("request: identity is saved before constants and signed send, all in connection scope", async () => {
  const res = await post({ step: "request", email: EMAIL });
  assert.equal(res.response.status, 200);
  assert.deepEqual(state.events, [
    "auth",
    "read",
    "scope:maxai-test",
    "fresh-read",
    "persist",
    "constants",
    "wire",
    "scope:end",
  ]);
  const saved = state.writes[0].providerSpecificData as RecordData;
  assert.equal(saved.maxaiLoginEmail, EMAIL);
  assert.match(String(saved.maxaiDeviceId), /^[0-9a-f-]{36}$/);
  assert.match(String(saved.maxaiClientUserId), /^[0-9a-f-]{36}$/);
  assert.equal(state.signatures[0].deviceId, saved.maxaiDeviceId);
});

test("verify: a different email cannot override the pending identity", async () => {
  state.connection.providerSpecificData = pending();
  captureWire(successCredential);
  const res = await post({ step: "verify", email: "other@example.com", code: "123456" });
  assert.equal(res.response.status, 400);
  assert.equal(state.requests.length, 0);
  assert.equal(state.writes.length, 0);
});

test("verify: pending email, device and client-user are required", async () => {
  for (const field of ["maxaiLoginEmail", "maxaiDeviceId", "maxaiClientUserId"]) {
    const psd = pending();
    delete psd[field];
    state.connection.providerSpecificData = psd;
    captureWire(successCredential);
    const res = await post({ step: "verify", email: EMAIL, code: "123456" });
    assert.equal(res.response.status, 400, field);
    assert.equal(state.requests.length, 0, field);
  }
});

test("verify: writes canonical tokens, strips plaintext legacy aliases, returns no tokens", async () => {
  state.connection.providerSpecificData = {
    ...pending(),
    maxaiAccessToken: "old-access",
    maxaiRefreshToken: "old-refresh",
    accessToken: "old-access-alias",
    refreshToken: "old-refresh-alias",
    keep: "unrelated",
  };
  captureWire(successCredential);
  const res = await post({ step: "verify", code: "123456" });
  assert.equal(res.response.status, 200);
  const saved = state.writes[0];
  const psd = saved.providerSpecificData as RecordData;
  assert.equal(saved.accessToken, "synthetic-access");
  assert.equal(saved.refreshToken, "synthetic-refresh");
  assert.equal(saved.apiKey, "synthetic-access");
  for (const key of ["maxaiAccessToken", "maxaiRefreshToken", "accessToken", "refreshToken"]) {
    assert.equal(Object.hasOwn(psd, key), false, key);
  }
  assert.equal(psd.keep, "unrelated");
  assert.equal(psd.maxaiDeviceId, DEVICE_ID);
  assert.equal(psd.maxaiClientUserId, CLIENT_USER_ID);
  assert.equal(state.signatures[0].deviceId, DEVICE_ID);
  const sent = JSON.parse(String(state.requests[0].init?.body));
  assert.equal(sent.email, EMAIL);
  assert.equal(sent.client_user_id, CLIENT_USER_ID);
  assert.equal(res.body.persisted, true);
  assert.doesNotMatch(
    JSON.stringify(res.body),
    /synthetic-access|synthetic-refresh|accessToken|refreshToken/
  );
});

test("verify: a null credential write is not reported as persisted", async () => {
  state.connection.providerSpecificData = pending();
  state.persist = async () => null;
  captureWire(successCredential);
  const res = await post({ step: "verify", code: "123456" });
  assert.equal(res.response.status, 500);
  assert.deepEqual(res.body, { success: false, error: FAILURE });
});

test("email helper redacts HTTP bodies and thrown transport details", async () => {
  for (const fetchImpl of [
    async () => new Response(PRIVATE_DETAIL, { status: 502 }),
    async () => {
      throw new Error(PRIVATE_DETAIL);
    },
  ]) {
    const res = await login.requestMaxaiEmailCode({ email: EMAIL, deviceId: DEVICE_ID, fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.error, FAILURE);
  }
});

test("email helper refuses malformed or unbounded input before constants/network", async () => {
  for (const email of ["not-an-email", "a".repeat(255) + "@example.com", "a@example.com\r\nX: y"]) {
    const result = await login.requestMaxaiEmailCode({
      email,
      deviceId: DEVICE_ID,
      fetchImpl: state.wire,
    });
    assert.equal(result.ok, false);
  }
  for (const deviceId of ["", "invalid", "a".repeat(1024)]) {
    const result = await login.requestMaxaiEmailCode({
      email: EMAIL,
      deviceId,
      fetchImpl: state.wire,
    });
    assert.equal(result.ok, false);
  }
  assert.equal(state.requests.length, 0);
  assert.equal(state.constantsCalls.length, 0);
});

test("request abort reaches MaxAI before any fetch", async () => {
  const controller = new AbortController();
  controller.abort(new Error(PRIVATE_DETAIL));
  const res = await post({ step: "request", email: EMAIL }, controller.signal);
  assert.equal(res.body.success, false);
  assert.equal(state.requests.length, 0);
});

test("management denial still stops before connection, persistence and transport", async () => {
  state.denied = true;
  assert.equal((await post({ step: "request", email: EMAIL })).response.status, 403);
  assert.deepEqual(state.events, ["auth"]);
});

test("request: no new token values are written while saving a pending identity", async () => {
  state.connection.providerSpecificData = { keep: "unrelated" };
  assert.equal((await post({ email: EMAIL })).response.status, 200);
  const saved = state.writes[0];
  assert.deepEqual(Object.keys(saved), ["providerSpecificData"]);
  const psd = saved.providerSpecificData as RecordData;
  assert.equal(psd.keep, "unrelated");
  assert.doesNotMatch(JSON.stringify(psd), /accessToken|refreshToken/);
});

test("request: legacy credentials are not migrated from a stale snapshot", async () => {
  state.connection.providerSpecificData = {
    ...pending(),
    maxaiAccessToken: "legacy-access",
    maxaiRefreshToken: "legacy-refresh",
  };
  assert.equal((await post({ email: EMAIL })).response.status, 200);
  const saved = state.writes[0];
  assert.deepEqual(Object.keys(saved), ["providerSpecificData"]);
  const psd = saved.providerSpecificData as RecordData;
  assert.equal(psd.maxaiAccessToken, "legacy-access");
  assert.equal(psd.maxaiRefreshToken, "legacy-refresh");
});

test("request then verify uses exactly the stored email/device/client-user", async () => {
  assert.equal((await post({ email: EMAIL })).response.status, 200);
  const requested = state.writes[0].providerSpecificData as RecordData;
  captureWire(() => successCredential({ clientUserId: requested.maxaiClientUserId }));
  assert.equal((await post({ step: "verify", code: "123456" })).response.status, 200);
  const sent = JSON.parse(String(state.requests[1].init?.body));
  assert.equal(sent.email, requested.maxaiLoginEmail);
  assert.equal(sent.client_user_id, requested.maxaiClientUserId);
  assert.equal(state.signatures[1].deviceId, requested.maxaiDeviceId);
});

test("invalid request objects never write or fetch", async () => {
  for (const body of [
    null,
    [],
    "request",
    { step: PRIVATE_DETAIL },
    { step: "request" },
    { email: 123 },
    { email: {} },
    { email: "not-an-email" },
    { email: "a".repeat(255) + "@example.com" },
    { email: EMAIL, deviceId: DEVICE_ID },
    { step: "verify", code: 123456 },
    { step: "verify", code: "12345" },
    { step: "verify", code: "1234567" },
    { step: "verify", code: "１２３４５６" },
    { step: "verify", code: "1".repeat(10_000) },
  ]) {
    const res = await post(body);
    assert.equal(res.response.status, 400);
    assert.deepEqual(res.body, { success: false, error: FAILURE });
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.requests.length, 0);
});

test("verify: malformed pending device or client-user is rejected before constants", async () => {
  for (const key of ["maxaiDeviceId", "maxaiClientUserId"]) {
    for (const value of ["bad-device", "x".repeat(1024), 42]) {
      state.connection.providerSpecificData = { ...pending(), [key]: value };
      const res = await post({ step: "verify", code: "123456" });
      assert.equal(res.response.status, 400);
    }
  }
  assert.equal(state.constantsCalls.length, 0);
  assert.equal(state.requests.length, 0);
});

for (const result of [false, undefined]) {
  test(`verify: ${String(result)} credential write cannot report persisted`, async () => {
    state.connection.providerSpecificData = pending();
    state.persist = async () => result;
    captureWire(successCredential);
    const res = await post({ step: "verify", code: "123456" });
    assert.equal(res.response.status, 500);
    assert.deepEqual(res.body, { success: false, error: FAILURE });
  });
}

test("verify: thrown persistence errors never disclose token or database details", async () => {
  state.connection.providerSpecificData = pending();
  state.persist = async () => {
    throw new Error(PRIVATE_DETAIL);
  };
  captureWire(successCredential);
  const res = await post({ step: "verify", code: "123456" });
  assert.equal(res.response.status, 500);
  assert.deepEqual(res.body, { success: false, error: FAILURE });
});

test("transport refusal fails closed in the MaxAI route with no fallback", async () => {
  state.failScope = true;
  const res = await post({ email: EMAIL });
  assert.equal(res.response.status, 500);
  assert.deepEqual(res.body, { success: false, error: FAILURE });
  assert.equal(state.writes.length, 0);
  assert.equal(state.requests.length, 0);
});

test("default email transport never falls back to global fetch without a scope", async () => {
  const result = await login.requestMaxaiEmailCode({ email: EMAIL, deviceId: DEVICE_ID });
  assert.equal(result.ok, false);
  assert.equal(result.error, FAILURE);
  assert.equal(state.requests.length, 0);
  const transport = await import("../../open-sse/services/maxaiTransport.ts");
  assert.equal(state.constantsCalls[0].fetchImpl, transport.maxaiFetch);
});

test("request and verify use redirect:error and the same injected fetch/signal for constants", async () => {
  const controller = new AbortController();
  const injected = state.wire;
  assert.equal(
    (
      await login.requestMaxaiEmailCode({
        email: EMAIL,
        deviceId: DEVICE_ID,
        fetchImpl: injected,
        signal: controller.signal,
      })
    ).ok,
    true
  );
  assert.equal(state.constantsCalls[0].fetchImpl, injected);
  assert.equal(state.constantsCalls[0].signal, state.requests[0].init?.signal);
  assert.notEqual(state.requests[0].init?.signal, controller.signal);
  assert.equal(state.requests[0].init?.redirect, "error");
  captureWire(successCredential);
  const verifyFetch = state.wire;
  assert.equal(
    (
      await login.verifyMaxaiEmailCode({
        email: EMAIL,
        deviceId: DEVICE_ID,
        clientUserId: CLIENT_USER_ID,
        code: "123456",
        fetchImpl: verifyFetch,
        signal: controller.signal,
      })
    ).ok,
    true
  );
  assert.equal(state.constantsCalls[1].fetchImpl, verifyFetch);
  assert.equal(state.constantsCalls[1].signal, state.requests[1].init?.signal);
  assert.equal(state.requests[1].init?.redirect, "error");
});

test("linked timeout bounds constants even if an adapter ignores cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = Promise.withResolvers<void>();
  let signal: AbortSignal | null | undefined;
  state.constants = async (opts) => {
    signal = opts.signal;
    entered.resolve();
    return new Promise(() => {});
  };
  const controller = new AbortController();
  const promise = login.requestMaxaiEmailCode({
    email: EMAIL,
    deviceId: DEVICE_ID,
    fetchImpl: state.wire,
    signal: controller.signal,
  });
  await entered.promise;
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  assert.ok(login.MAXAI_LOGIN_TIMEOUT_MS > 0 && login.MAXAI_LOGIN_TIMEOUT_MS <= 60_000);
  t.mock.timers.tick(login.MAXAI_LOGIN_TIMEOUT_MS);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.error, FAILURE);
  assert.equal(signal?.aborted, true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(state.requests.length, 0);
});

test("caller abort during constants returns safely and prevents a late signed request", async () => {
  const entered = Promise.withResolvers<void>();
  const constants = Promise.withResolvers<MaxaiSigningConstants | null>();
  let signal: AbortSignal | null | undefined;
  state.constants = async (opts) => {
    signal = opts.signal;
    entered.resolve();
    return constants.promise;
  };
  const controller = new AbortController();
  const promise = login.requestMaxaiEmailCode({
    email: EMAIL,
    deviceId: DEVICE_ID,
    fetchImpl: state.wire,
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort(new Error(PRIVATE_DETAIL));
  assert.equal((await promise).error, FAILURE);
  assert.equal(signal?.aborted, true);
  constants.resolve(MOCK_CONSTANTS);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(state.requests.length, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("the request AbortSignal cancels an in-flight route request", async () => {
  const entered = Promise.withResolvers<void>();
  let signal: AbortSignal | null | undefined;
  state.wire = async (_url, init) => {
    signal = init?.signal;
    entered.resolve();
    return new Promise<Response>(() => {});
  };
  const controller = new AbortController();
  const promise = post({ email: EMAIL }, controller.signal);
  await entered.promise;
  controller.abort(new Error(PRIVATE_DETAIL));
  const result = await promise;
  assert.equal(result.body.success, false);
  assert.equal(result.body.error, FAILURE);
  assert.equal(signal?.aborted, true);
  assert.equal(state.scope, 0);
});

test("success clears deadline and abort listeners", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const result = await login.requestMaxaiEmailCode({
    email: EMAIL,
    deviceId: DEVICE_ID,
    fetchImpl: state.wire,
    signal: controller.signal,
  });
  assert.equal(result.ok, true);
  const signal = state.requests[0].init?.signal;
  assert.ok(signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(getEventListeners(signal, "abort").length, 0);
  t.mock.timers.tick(login.MAXAI_LOGIN_TIMEOUT_MS);
  assert.equal(signal.aborted, false);
});

test("timeout also bounds and cancels a stalled response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  state.wire = async () =>
    new Response(
      new ReadableStream({
        pull() {
          reading.resolve();
        },
        cancel() {
          cancelled = true;
        },
      })
    );
  const promise = login.requestMaxaiEmailCode({
    email: EMAIL,
    deviceId: DEVICE_ID,
    fetchImpl: state.wire,
  });
  await reading.promise;
  t.mock.timers.tick(login.MAXAI_LOGIN_TIMEOUT_MS);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.error, FAILURE);
  assert.equal(cancelled, true);
});

test("oversized and malformed responses return only a fixed error", async () => {
  for (const body of ["x".repeat(65 * 1024), PRIVATE_DETAIL, "null", "[]", "42"]) {
    const result = await login.requestMaxaiEmailCode({
      email: EMAIL,
      deviceId: DEVICE_ID,
      fetchImpl: async () => new Response(body),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, FAILURE);
  }
});

test("constants errors and missing constants fail closed without sending a signed request", async () => {
  for (const fail of [
    async () => null,
    async () => {
      throw new Error(PRIVATE_DETAIL);
    },
  ]) {
    state.constants = fail;
    const result = await login.requestMaxaiEmailCode({
      email: EMAIL,
      deviceId: DEVICE_ID,
      fetchImpl: state.wire,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, FAILURE);
  }
  assert.equal(state.requests.length, 0);
});

test("verify rejects malformed token fields and a changed server identity", async () => {
  for (const overrides of [
    { accessToken: {} },
    { accessToken: "" },
    { accessToken: "bad\r\nheader" },
    { refreshToken: "" },
    { refreshToken: "x".repeat(16_385) },
    { userId: [] },
    { email: "other@example.com" },
    { email: PRIVATE_DETAIL },
    { clientUserId: "44444444-4444-4444-8444-444444444444" },
  ]) {
    const result = await login.verifyMaxaiEmailCode({
      email: EMAIL,
      deviceId: DEVICE_ID,
      clientUserId: CLIENT_USER_ID,
      code: "123456",
      fetchImpl: async () => successCredential(overrides),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, FAILURE);
    assert.equal(result.credential, undefined);
  }
});

test("verify code and client-user validation precedes all constants and wire calls", async () => {
  for (const overrides of [
    { code: "12345" },
    { code: "1234567" },
    { code: "12345a" },
    { code: "1".repeat(10_000) },
    { clientUserId: "" },
    { clientUserId: "bad-client" },
    { clientUserId: "x".repeat(10_000) },
  ]) {
    const result = await login.verifyMaxaiEmailCode({
      email: EMAIL,
      deviceId: DEVICE_ID,
      clientUserId: CLIENT_USER_ID,
      code: "123456",
      ...overrides,
      fetchImpl: state.wire,
    });
    assert.equal(result.ok, false);
  }
  assert.equal(state.constantsCalls.length, 0);
  assert.equal(state.requests.length, 0);
});

test("verify reads the latest pending identity inside the connection scope", async () => {
  state.connection.providerSpecificData = { ...pending(), maxaiLoginEmail: "stale@example.com" };
  state.freshConnection = async () => ({ ...state.connection, providerSpecificData: pending() });
  captureWire(successCredential);
  assert.equal((await post({ step: "verify", code: "123456" })).response.status, 200);
  const sent = JSON.parse(String(state.requests[0].init?.body));
  assert.equal(sent.email, EMAIL);
});

test("a deleted or changed provider row cannot start a MaxAI login from a cached row", async () => {
  for (const value of [null, { ...state.connection, provider: "other-provider" }]) {
    state.freshConnection = async () => value;
    assert.equal((await post({ email: EMAIL })).response.status, 400);
  }
  assert.equal(state.writes.length, 0);
  assert.equal(state.constantsCalls.length, 0);
  assert.equal(state.requests.length, 0);
});

test("route redacts successful-HTTP upstream failures and ignores provider error wording", async () => {
  for (const step of ["request", "verify"]) {
    state.connection.providerSpecificData = pending();
    captureWire(() =>
      Response.json({ data: { status: "FAIL", code: 10119, detail: PRIVATE_DETAIL } })
    );
    const result = await post({ step, email: EMAIL, code: "123456" });
    assert.deepEqual(result.body, { success: false, error: FAILURE });
    assert.equal(result.response.status, 400);
    assert.doesNotMatch(
      JSON.stringify(result.body),
      /fake-access|fake-refresh|proxy-password|at \/private/
    );
  }
});

test("runtime policy at pending-identity persistence is terminal before any login wire work", async () => {
  state.persist = async () => {
    throw new RuntimePolicyError("entrypoint-unapproved");
  };
  const { response, body } = await post({ step: "request", email: EMAIL });
  assert.equal(response.status, 403);
  assert.equal(isRuntimePolicyResponse(response), true);
  assert.equal((body.error as RecordData).code, "OMNI_RUNTIME_POLICY_DENIED");
  assert.equal(state.requests.length, 0);
  assert.equal(state.constantsCalls.length, 0);
});

test("runtime policy from signed email helper returns safe terminal response", async () => {
  state.wire = async () => {
    throw new RuntimePolicyError("proxy-forbidden");
  };
  const { response, body } = await post({ step: "request", email: EMAIL });
  assert.equal(response.status, 403);
  assert.equal(isRuntimePolicyResponse(response), true);
  assert.equal((body.error as RecordData).code, "OMNI_RUNTIME_POLICY_DENIED");
  assert.ok(!JSON.stringify(body).includes(PRIVATE_DETAIL));
});

test("runtime policy at verified credential save remains terminal without returning tokens", async () => {
  state.connection.providerSpecificData = pending();
  captureWire(successCredential);
  state.persist = async () => {
    throw new RuntimePolicyError("entrypoint-unapproved");
  };
  const { response, body } = await post({ step: "verify", code: "123456" });
  assert.equal(response.status, 403);
  assert.equal(isRuntimePolicyResponse(response), true);
  assert.equal((body.error as RecordData).code, "OMNI_RUNTIME_POLICY_DENIED");
  assert.ok(!JSON.stringify(body).includes("access-token"));
});
