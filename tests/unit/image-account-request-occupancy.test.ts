import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _clearAccountRequestOccupancyForTest,
  getAccountRequestInFlightCount,
  reserveAccountRequest,
} from "../../open-sse/services/accountRequestOccupancy.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "omni-image-occupancy-"));

const state = {
  refresh: async (credentials: any) => credentials,
  select: async (_provider: string, _options: any): Promise<any> => null,
  image: async (_options: any): Promise<any> => ({ success: true, data: { data: [] } }),
};
const key = "omni.test.image-request-occupancy";
(globalThis as any)[Symbol.for(key)] = state;
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const auth = moduleUrl(`
const s=globalThis[Symbol.for(${JSON.stringify(key)})];
export async function getProviderCredentialsWithQuotaPreflight(provider,a,b,model,options) { return s.select(provider,options); }
export async function clearRecoveredProviderState() {}
`);
const refresh = moduleUrl(
  `const s=globalThis[Symbol.for(${JSON.stringify(key)})]; export async function checkAndRefreshToken(provider,credentials) {return s.refresh(credentials);}`
);
const combo = moduleUrl(
  `export async function getComboByName() {return {name:'fixture'};} export async function getCombos(){return [];}`
);
const targets = moduleUrl(
  `export function resolveComboTargets(){return [{modelStr:'openai/dall-e-3'},{modelStr:'openai/gpt-image-1.5'}];}`
);
const image = moduleUrl(
  `const s=globalThis[Symbol.for(${JSON.stringify(key)})]; export async function handleImageGeneration(options){return s.image(options);}
export async function handleAdobeFireflyImageGeneration(options){return s.image(options);}
export async function handleCodexImageEdit(options){return s.image(options);}
export async function handleOpenAIImageEdit(options){return s.image(options);}
export async function handleOpenRouterImageEdit(options){return s.image(options);}`
);
const policy = moduleUrl("export async function enforceApiKeyPolicy(){return {apiKeyInfo:{}};}");
const readCache = moduleUrl(
  `export * from ${JSON.stringify(new URL("../../src/lib/db/readCache.ts", import.meta.url).href)}; export async function getCachedSettings(){return {};}`
);
const imageModel = moduleUrl(
  `export * from ${JSON.stringify(new URL("../../src/lib/images/imageRouteModel.ts", import.meta.url).href)}; export async function resolveImageRouteModel(model){return model;}`
);
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const replacement =
      specifier === "@/shared/utils/apiKeyPolicy"
        ? policy
        : specifier === "@/lib/db/readCache"
          ? readCache
          : specifier === "@/lib/images/imageRouteModel"
            ? imageModel
            : specifier === "./auth" || specifier === "@/sse/services/auth"
              ? auth
              : specifier === "./tokenRefresh"
                ? refresh
                : specifier === "@/lib/db/combos"
                  ? combo
                  : specifier === "@omniroute/open-sse/services/combo.ts"
                    ? targets
                    : specifier === "@omniroute/open-sse/handlers/imageGeneration.ts"
                      ? image
                      : specifier === "@/lib/usage/costCalculator"
                        ? moduleUrl("export async function calculateModalCost(){return 0;}")
                        : undefined;
    return replacement ? { url: replacement, shortCircuit: true } : next(specifier, context);
  },
});
const { executeImageWithCredentialFallback } =
  await import("../../src/sse/services/imageCredentialRetry.ts");
const imageEditRoute = await import("../../src/app/api/v1/images/edits/route.ts");
const { executeImageCombo } = await import("../../open-sse/services/imageCombo.ts");
const logger = await import("../../src/sse/utils/logger.ts");
const { resetDbInstance } = await import("../../src/lib/db/core.ts");
test.after(() => {
  resetDbInstance();
  hooks.deregister();
  delete (globalThis as any)[Symbol.for(key)];
});
test.beforeEach(() => {
  _clearAccountRequestOccupancyForTest();
  state.refresh = async (credentials) => credentials;
  state.select = async () => null;
});
function selected(id: string) {
  const release = reserveAccountRequest(id);
  let releases = 0;
  return {
    connectionId: id,
    apiKey: "fixture-only",
    authType: "apikey",
    releaseAccountRequest: () => {
      releases++;
      release();
    },
    releases: () => releases,
  };
}
const run = (credentials: any, execute: any, selectNextCredentials?: any) =>
  executeImageWithCredentialFallback({
    provider: "openai",
    requestedModel: "dall-e-3",
    credentials,
    execute,
    selectNextCredentials,
  });

test("image reservation survives refresh replacement until the upstream body is consumed", async () => {
  const account = selected("held");
  state.refresh = async (c) => ({ connectionId: c.connectionId, apiKey: "refreshed" });
  let finish!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        controller.enqueue(new TextEncoder().encode('{"data":[]}'));
        controller.close();
      };
    },
  });
  const pending = run(account, async () => ({
    success: true,
    data: await new Response(body).json(),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(getAccountRequestInFlightCount("held"), 1);
  finish();
  await pending;
  assert.equal(getAccountRequestInFlightCount("held"), 0);
  assert.equal(account.releases(), 1);
});

test("image401 releases the old account before selecting and holds the new attempt", async () => {
  const first = selected("first");
  let second: ReturnType<typeof selected> | undefined;
  let sends = 0;
  const result = await run(
    first,
    async (c) => {
      sends++;
      assert.equal(getAccountRequestInFlightCount(c.connectionId), 1);
      return c.connectionId === "first"
        ? { success: false, status: 401 }
        : { success: true, data: { data: [] } };
    },
    async () => {
      assert.equal(getAccountRequestInFlightCount("first"), 0);
      second = selected("second");
      return second;
    }
  );
  assert.equal(result.result.success, true);
  assert.equal(sends, 2);
  assert.equal(first.releases(), 1);
  assert.equal(second?.releases(), 1);
  assert.equal(getAccountRequestInFlightCount("second"), 0);
});

test("image refresh failure releases before fallback, including a throwing selector", async () => {
  const account = selected("refresh-failure");
  state.refresh = async () => {
    throw new Error("fixture refresh failure");
  };
  await assert.rejects(
    run(
      account,
      async () => {
        assert.fail("must not generate");
      },
      async () => {
        assert.equal(getAccountRequestInFlightCount("refresh-failure"), 0);
        throw new Error("fixture selection failure");
      }
    ),
    /selection failure/
  );
  assert.equal(account.releases(), 1);
});

test("image aborted body read and execution errors release exactly once without fallback", async () => {
  for (const reason of [
    new DOMException("fixture cancel", "AbortError"),
    new Error("fixture failed"),
  ]) {
    const account = selected("failed");
    let fallbacks = 0;
    await assert.rejects(
      run(
        account,
        async () => {
          throw reason;
        },
        async () => {
          fallbacks++;
        }
      ),
      (e) => e === reason
    );
    assert.equal(fallbacks, 0);
    assert.equal(account.releases(), 1);
    assert.equal(getAccountRequestInFlightCount("failed"), 0);
  }
});

test("image default fallback selection requests atomic reservation", async () => {
  const first = selected("initial");
  let next: ReturnType<typeof selected> | undefined;
  state.select = async (_provider, options) => {
    assert.equal(options.reserveAccountRequest, true);
    assert.equal(getAccountRequestInFlightCount("initial"), 0);
    next = selected("next");
    return next;
  };
  await run(first, async (c) =>
    c.connectionId === "initial" ? { success: false, status: 401 } : { success: true, data: {} }
  );
  assert.equal(first.releases(), 1);
  assert.equal(next?.releases(), 1);
});

test("image combo releases each completed target before selecting the next", async () => {
  const accounts: ReturnType<typeof selected>[] = [];
  let sends = 0;
  state.select = async (_provider, options) => {
    assert.equal(options.reserveAccountRequest, true);
    for (const prior of accounts)
      assert.equal(getAccountRequestInFlightCount(prior.connectionId), 0);
    const account = selected(`combo-${accounts.length}`);
    accounts.push(account);
    return account;
  };
  state.image = async ({ credentials }) => {
    assert.equal(getAccountRequestInFlightCount(credentials.connectionId), 1);
    return sends++ === 0
      ? { success: false, status: 503, error: "fixture rejection" }
      : { success: true, data: { data: [] } };
  };
  const response = await executeImageCombo(
    "fixture",
    { prompt: "fixture" },
    { request: new Request("http://fixture.invalid/images"), policy: {} },
    Date.now(),
    logger
  );
  assert.equal(response.status, 200);
  assert.equal(sends, 2);
  for (const account of accounts) {
    assert.equal(account.releases(), 1);
    assert.equal(getAccountRequestInFlightCount(account.connectionId), 0);
  }
});

test("image combo cancellation throw releases its current target", async () => {
  const account = selected("combo-abort");
  state.select = async () => account;
  const reason = new DOMException("fixture cancel", "AbortError");
  state.image = async () => {
    throw reason;
  };
  await assert.rejects(
    executeImageCombo(
      "fixture",
      {},
      { request: new Request("http://fixture.invalid/images"), policy: {} },
      Date.now(),
      logger
    ),
    (e) => e === reason
  );
  assert.equal(account.releases(), 1);
  assert.equal(getAccountRequestInFlightCount("combo-abort"), 0);
});

test("actual image edit route releases buffered success before client reads synthetic JSON", async () => {
  const account = selected("edit-route");
  state.select = async (_provider, options) => {
    assert.equal(options.reserveAccountRequest, true);
    return account;
  };
  state.image = async ({ credentials }) => {
    assert.equal(getAccountRequestInFlightCount(credentials.connectionId), 1);
    return { success: true, data: { data: [{ b64_json: "fixture" }] } };
  };
  const response = await imageEditRoute.POST(
    new Request("http://fixture.invalid/api/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/openai/gpt-5-image-mini",
        prompt: "fixture",
        images: ["data:image/png;base64,iVBORw0KGgo="],
      }),
    })
  );
  assert.equal(response.status, 200);
  assert.equal(account.releases(), 1);
  assert.equal(getAccountRequestInFlightCount("edit-route"), 0);
  assert.equal((await response.json()).data[0].b64_json, "fixture");
});

test("actual image edit route releases its selection when handler throws", async () => {
  const account = selected("edit-throw");
  state.select = async () => account;
  const reason = new Error("fixture image read failure");
  state.image = async () => {
    throw reason;
  };
  await assert.rejects(
    imageEditRoute.POST(
      new Request("http://fixture.invalid/api/v1/images/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openrouter/openai/gpt-5-image-mini",
          prompt: "fixture",
          images: ["data:image/png;base64,iVBORw0KGgo="],
        }),
      })
    ),
    (e) => e === reason
  );
  assert.equal(account.releases(), 1);
  assert.equal(getAccountRequestInFlightCount("edit-throw"), 0);
});
