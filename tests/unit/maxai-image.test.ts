import { test } from "node:test";
import assert from "node:assert";
import { RuntimePolicyError, isRuntimePolicyError } from "../../src/shared/runtimePolicy.ts";
import { registerHooks } from "node:module";
import type { MaxaiCredential } from "../../open-sse/executors/maxai/credentials.ts";

const state = {
  scope: null as string | null,
  scopes: [] as string[],
  constantsScopes: [] as (string | null)[],
  refreshScopes: [] as (string | null)[],
  refreshedInput: null as {
    connectionId: string;
    credential: MaxaiCredential;
    fetchImpl: typeof fetch;
  } | null,
  wire: (async () => {
    throw new Error("Unexpected wire call");
  }) as typeof fetch,
  refresh: async (credential: MaxaiCredential) => credential,
  constants: async (_input: { fetchImpl: typeof fetch; signal?: AbortSignal }) => MOCK_CONSTANTS,
  failScope: false,
};
const symbol = Symbol.for("omniroute.maxai-image-safety-test");
Object.defineProperty(globalThis, symbol, { value: state, configurable: true });
const prelude = 'const s = globalThis[Symbol.for("omniroute.maxai-image-safety-test")];';
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    let source: string | undefined;
    if (specifier.endsWith("/maxaiTransport.ts"))
      source = `
      export async function runMaxaiConnectionTransport(id, fn) {
        if (!id || s.failScope) throw new Error("secret-token proxy-password at /private/test.ts:1:1");
        s.scopes.push(id); const old = s.scope; s.scope = id;
        try { return await fn(); } finally { s.scope = old; }
      }
      export const maxaiFetch = (url, init) => {
        if (!s.scope) throw new Error("Unscoped wire call");
        return s.wire(url, init);
      };`;
    if (specifier.endsWith("/maxai/refresh.ts"))
      source = `
      export async function ensureFreshMaxaiCredential(input) {
        s.refreshScopes.push(s.scope); s.refreshedInput = input;
        return s.refresh(input.credential);
      }`;
    if (specifier.endsWith("/maxai/constantsStore.ts"))
      source = `
      export async function ensureMaxaiConstants(input) {
        s.constantsScopes.push(s.scope); return s.constants(input);
      }`;
    if (specifier === "../../imageGeneration.ts")
      source = `
      export const saveImageErrorResult = (input) => ({ success: false, ...input });
      export const saveImageSuccessResult = (input) => ({ success: true, data: { data: input.images } });`;
    if (source !== undefined)
      return {
        url: "data:text/javascript," + encodeURIComponent(prelude + source),
        shortCircuit: true,
      };
    if (specifier.includes("/lib/db/")) throw new Error("Real DB prohibited in image unit tests");
    return nextResolve(specifier, context);
  },
});
const {
  resolveMaxaiImageModel,
  snapMaxaiImageSize,
  extractMaxaiImageUrls,
  handleMaxaiImageGeneration,
  MAXAI_IMAGE_PATH,
} = await import("../../open-sse/handlers/imageGeneration/providers/maxaiImage.ts");
import { IMAGE_PROVIDERS } from "../../open-sse/config/imageRegistry.ts";
import { MAXAI_BASE_URL } from "../../open-sse/executors/maxai/protocol.ts";
import { MOCK_CONSTANTS } from "./helpers/maxaiMockConstants.ts";

// A minimal valid MaxAI credential (userId derives nothing here; the signer is
// exercised elsewhere). providerSpecificData carries the token + device id.
const CRED = {
  connectionId: "image-account",
  refreshToken: "top-level-refresh",
  providerSpecificData: {
    maxaiAccessToken: "tok-abc",
    maxaiDeviceId: "dev-123",
    maxaiUserId: "11111111-1111-4111-8111-111111111111",
  },
};

const nativeFetch = globalThis.fetch;
test.beforeEach(() => {
  state.scope = null;
  state.scopes = [];
  state.constantsScopes = [];
  state.refreshScopes = [];
  state.failScope = false;
  state.refreshedInput = null;
  state.refresh = async (credential) => credential;
  state.constants = async () => MOCK_CONSTANTS;
  state.wire = async () => {
    throw new Error("Unexpected wire call");
  };
  globalThis.fetch = async () => {
    throw new Error("Ambient fetch is prohibited");
  };
});
test.afterEach(() => {
  globalThis.fetch = nativeFetch;
});
test.after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, symbol);
});

// --- Registry ------------------------------------------------------------

test("maxai is registered in IMAGE_PROVIDERS with the maxai-image format + 6 models", () => {
  const entry = (
    IMAGE_PROVIDERS as Record<string, { format?: string; baseUrl?: string; models?: unknown[] }>
  )["maxai"];
  assert.ok(entry, "maxai must exist in IMAGE_PROVIDERS");
  assert.equal(entry.format, "maxai-image");
  assert.match(String(entry.baseUrl), /api\.maxai\.me\/gpt\/get_image_generate_response/);
  assert.equal((entry.models ?? []).length, 6);
});

// --- Pure helpers --------------------------------------------------------

test("resolveMaxaiImageModel strips maxai/ prefix and resolves aliases", () => {
  assert.equal(resolveMaxaiImageModel("maxai/gpt-image-1"), "gpt-image-1");
  assert.equal(resolveMaxaiImageModel("mx/gpt-image-1"), "gpt-image-1");
  assert.equal(resolveMaxaiImageModel("stable-diffusion-v3"), "sd3-medium");
  assert.equal(resolveMaxaiImageModel("stable-diffusion-3-medium"), "sd3-medium");
  assert.equal(resolveMaxaiImageModel("flux-1-schnell"), "flux-1-schnell");
});

test("snapMaxaiImageSize snaps unsupported sizes for strict models, passes flux through", () => {
  // gpt-image-1 / dall-e-3 reject 512x512 -> snap to 1024x1024
  assert.equal(snapMaxaiImageSize("gpt-image-1", "512x512"), "1024x1024");
  assert.equal(snapMaxaiImageSize("dall-e-3", "256x256"), "1024x1024");
  // supported sizes pass through
  assert.equal(snapMaxaiImageSize("gpt-image-1", "1536x1024"), "1536x1024");
  assert.equal(snapMaxaiImageSize("dall-e-3", "1792x1024"), "1792x1024");
  // flux / sd3: no constraint, any size passes through
  assert.equal(snapMaxaiImageSize("flux-1-schnell", "512x512"), "512x512");
  assert.equal(snapMaxaiImageSize("sd3-medium", "768x768"), "768x768");
  // missing size -> default
  assert.equal(snapMaxaiImageSize("gpt-image-1", undefined), "1024x1024");
});

test("extractMaxaiImageUrls prefers png_url, falls back to webp_url", () => {
  assert.deepEqual(
    extractMaxaiImageUrls([{ png_url: "p.png", webp_url: "w.webp" }, { webp_url: "only.webp" }]),
    ["p.png", "only.webp"]
  );
  assert.deepEqual(extractMaxaiImageUrls([]), []);
  assert.deepEqual(extractMaxaiImageUrls(null), []);
});

// --- Handler (mocked fetch) ---------------------------------------------

function mockFetch(status: number, jsonBody: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      async json() {
        return jsonBody;
      },
      async text() {
        return JSON.stringify(jsonBody);
      },
    }) as unknown as Response) as unknown as typeof fetch;
}

test("handleMaxaiImageGeneration returns OpenAI image data on success", async () => {
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};
  const fetchImpl = (async (url: string, init: RequestInit) => {
    capturedUrl = url;
    capturedBody = JSON.parse(String(init.body));
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          status: "OK",
          data: [{ png_url: "https://cdn/x.png", webp_url: "https://cdn/x.webp" }],
        };
      },
      async text() {
        return "";
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;

  const result = (await handleMaxaiImageGeneration({
    model: "flux-1-schnell",
    provider: "maxai",
    body: { prompt: "a red bicycle", size: "512x512", n: 2 },
    credentials: CRED,
    fetchImpl,
  })) as { success: boolean; data?: { data: Array<{ url: string }> } };

  assert.equal(result.success, true);
  assert.deepEqual(result.data?.data, [{ url: "https://cdn/x.png" }]);
  // Hit the image endpoint with the signed body. Exact URL equality instead of a
  // hand-escaped RegExp over the path — the old `.replace(/\//g, "\\/")` escaped
  // only slashes (which need no escaping in a RegExp anyway) and would have let
  // any other metacharacter through (CodeQL js/incomplete-sanitization), while
  // also accepting the path appearing anywhere in a wrong URL.
  assert.equal(capturedUrl, MAXAI_BASE_URL + MAXAI_IMAGE_PATH);
  assert.equal(capturedBody.model_name, "flux-1-schnell");
  assert.equal(capturedBody.size, "512x512"); // flux passes size through
  assert.equal(capturedBody.n, 2);
});

test("handleMaxaiImageGeneration 401 is retryable (credential fallback)", async () => {
  const result = (await handleMaxaiImageGeneration({
    model: "gpt-image-1",
    provider: "maxai",
    body: { prompt: "x" },
    credentials: CRED,
    fetchImpl: mockFetch(401, { error: "expired" }),
  })) as { success: boolean; status?: number; retryable?: boolean };
  assert.equal(result.success, false);
  assert.equal(result.status, 401);
  assert.equal(result.retryable, true);
});

test("handleMaxaiImageGeneration rejects an empty prompt with 400", async () => {
  const result = (await handleMaxaiImageGeneration({
    model: "gpt-image-1",
    provider: "maxai",
    body: { prompt: "  " },
    credentials: CRED,
    fetchImpl: mockFetch(200, {}),
  })) as { success: boolean; status?: number };
  assert.equal(result.success, false);
  assert.equal(result.status, 400);
});

test("handleMaxaiImageGeneration 401s with no credential (retryable)", async () => {
  const result = (await handleMaxaiImageGeneration({
    model: "gpt-image-1",
    provider: "maxai",
    body: { prompt: "x" },
    credentials: {},
    fetchImpl: mockFetch(200, {}),
  })) as { success: boolean; status?: number; retryable?: boolean };
  assert.equal(result.success, false);
  assert.equal(result.status, 401);
  assert.equal(result.retryable, true);
});

test("handleMaxaiImageGeneration surfaces a no-images response as 502", async () => {
  const result = (await handleMaxaiImageGeneration({
    model: "sd3-medium",
    provider: "maxai",
    body: { prompt: "x" },
    credentials: CRED,
    fetchImpl: mockFetch(200, { status: "OK", data: [] }),
  })) as { success: boolean; status?: number };
  assert.equal(result.success, false);
  assert.equal(result.status, 502);
});

test("image helper refuses a missing connection before refresh or network", async () => {
  let calls = 0;
  const { connectionId: _connectionId, ...credentials } = CRED;
  const result = await handleMaxaiImageGeneration({
    model: "gpt-image-1",
    provider: "maxai",
    body: { prompt: "x" },
    credentials,
    fetchImpl: async () => {
      calls++;
      return Response.json({ status: "OK", data: [{ url: "x" }] });
    },
  });
  assert.equal(result.success, false);
  assert.equal(calls, 0);
  assert.deepEqual(state.refreshScopes, []);
});

test("image helper defaults to account-bound fetch and uses refreshed credentials immediately", async () => {
  state.refresh = async (credential) => ({ ...credential, accessToken: "fresh-access" });
  state.wire = async (_url, init) => {
    assert.equal(state.scope, CRED.connectionId);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fresh-access");
    assert.equal(init?.redirect, "error");
    return Response.json({ status: "OK", data: [{ png_url: "https://example.com/image.png" }] });
  };
  const result = await handleMaxaiImageGeneration({
    model: "mx/gpt-image-1",
    provider: "mx",
    body: { prompt: "x" },
    credentials: CRED,
  });
  assert.equal(result.success, true);
  assert.deepEqual(state.scopes, [CRED.connectionId]);
  assert.deepEqual(state.refreshScopes, [CRED.connectionId]);
  assert.deepEqual(state.constantsScopes, [CRED.connectionId]);
  assert.equal(state.refreshedInput?.credential.refreshToken, CRED.refreshToken);
});

test("image failures never expose or log upstream body/status/transport secrets", async () => {
  const secret = "synthetic-access synthetic-refresh proxy-password at /private/test.ts:1:1";
  for (const fetchImpl of [
    async () => new Response(secret, { status: 418 }),
    async () => {
      throw new Error(secret);
    },
    async () => Response.json({ status: secret, data: [] }),
  ]) {
    const logs: unknown[] = [];
    const result = await handleMaxaiImageGeneration({
      model: "gpt-image-1",
      provider: "maxai",
      body: { prompt: "x" },
      credentials: CRED,
      fetchImpl,
      log: { error: (...args) => logs.push(args) },
    });
    assert.equal(result.success, false);
    assert.doesNotMatch(
      JSON.stringify({ result, logs }),
      /synthetic-access|synthetic-refresh|proxy-password|at \/private/
    );
  }
});

test("image abort during refresh prevents the signed image request", async () => {
  const controller = new AbortController();
  let calls = 0;
  state.refresh = async (credential) => {
    controller.abort();
    return credential;
  };
  const result = await handleMaxaiImageGeneration({
    model: "gpt-image-1",
    provider: "maxai",
    body: { prompt: "x" },
    credentials: CRED,
    signal: controller.signal,
    fetchImpl: async () => {
      calls++;
      return Response.json({});
    },
  });
  assert.equal(result.success, false);
  assert.equal(calls, 0);
});

test("cold image signing fetch and API use the identical account-bound fetch", async () => {
  const calls: string[] = [];
  state.constants = async (input) => {
    assert.equal(input.fetchImpl, state.refreshedInput?.fetchImpl);
    await input.fetchImpl("https://www.maxai.co/app/", { signal: input.signal, redirect: "error" });
    return MOCK_CONSTANTS;
  };
  state.wire = async (url) => {
    assert.equal(state.scope, CRED.connectionId);
    calls.push(String(url));
    return String(url).endsWith("/app/")
      ? new Response("")
      : Response.json({ status: "OK", data: [{ url: "https://example.com/image.png" }] });
  };
  const result = await handleMaxaiImageGeneration({
    model: "gpt-image-1",
    provider: "maxai",
    body: { prompt: "x" },
    credentials: CRED,
  });
  assert.equal(result.success, true);
  assert.deepEqual(calls, ["https://www.maxai.co/app/", MAXAI_BASE_URL + MAXAI_IMAGE_PATH]);
});

test("image transport rejection prevents refresh and signing bundle work", async () => {
  state.failScope = true;
  const logs: unknown[] = [];
  const result = await handleMaxaiImageGeneration({
    model: "gpt-image-1",
    provider: "maxai",
    body: { prompt: "x" },
    credentials: CRED,
    log: { error: (...args) => logs.push(args) },
  });
  assert.equal(result.success, false);
  assert.deepEqual(state.refreshScopes, []);
  assert.deepEqual(state.constantsScopes, []);
  assert.doesNotMatch(JSON.stringify({ result, logs }), /secret-token|proxy-password|at \/private/);
});

test("MaxAI image handler preserves trusted policy without converting to provider failure", async () => {
  const policyError = new RuntimePolicyError("proxy-forbidden");
  let logs = 0;
  state.wire = async () => {
    throw policyError;
  };
  await assert.rejects(
    handleMaxaiImageGeneration({
      model: "gpt-image-1",
      provider: "maxai",
      body: { prompt: "a boat" },
      credentials: CRED,
      log: {
        error() {
          logs++;
        },
      },
    }),
    (error) => error === policyError && isRuntimePolicyError(error)
  );
  assert.equal(logs, 0);
  assert.deepEqual(state.scopes, ["image-account"]);
});
