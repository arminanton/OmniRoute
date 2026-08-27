import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-maxai-image-route-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const priorTlsEnabled = process.env.ENABLE_TLS_FINGERPRINT;
const priorTlsProviders = process.env.TLS_FINGERPRINT_PROVIDERS;
delete process.env.ENABLE_TLS_FINGERPRINT;
delete process.env.TLS_FINGERPRINT_PROVIDERS;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { __setMaxaiConstantsForTest } =
  await import("../../open-sse/executors/maxai/constantsStore.ts");
const { MOCK_CONSTANTS } = await import("./helpers/maxaiMockConstants.ts");
const { setTlsClientForTest } = await import("../../open-sse/utils/proxyFetch.ts");
const imageRoute = await import("../../src/app/api/v1/images/generations/route.ts");
const providerImageRoute =
  await import("../../src/app/api/v1/providers/[provider]/images/generations/route.ts");
const modelsRoute = await import("../../src/app/api/providers/[id]/models/route.ts");

__setMaxaiConstantsForTest(MOCK_CONSTANTS);

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

function fakeJwt(
  exp: number,
  marker = "token",
  userId = "11111111-1111-4111-8111-111111111111"
): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ exp, marker, subject: { user_id: userId } })
  ).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function createMaxaiConnection(
  tokens: { accessToken?: string; refreshToken?: string } = {}
): Promise<string> {
  const accessToken = tokens.accessToken ?? "access-token";
  const connection = await providersDb.createProviderConnection({
    provider: "maxai",
    authType: "apikey",
    name: "MaxAI image transport",
    apiKey: accessToken,
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      maxaiAccessToken: accessToken,
      ...(tokens.refreshToken ? { maxaiRefreshToken: tokens.refreshToken } : {}),
      maxaiDeviceId: "22222222-2222-4222-8222-222222222222",
      maxaiUserId: "11111111-1111-4111-8111-111111111111",
    },
  });
  assert.ok(connection?.id);
  return String(connection.id);
}

function imageRequest(provider = "maxai"): Request {
  return new Request("http://localhost/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: `${provider}/flux-1-schnell`,
      prompt: "A watercolor field notebook on a wooden desk",
      size: "1024x1024",
    }),
  });
}

test.beforeEach(resetStorage);

test.after(() => {
  setTlsClientForTest(null);
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  if (priorTlsEnabled === undefined) delete process.env.ENABLE_TLS_FINGERPRINT;
  else process.env.ENABLE_TLS_FINGERPRINT = priorTlsEnabled;
  if (priorTlsProviders === undefined) delete process.env.TLS_FINGERPRINT_PROVIDERS;
  else process.env.TLS_FINGERPRINT_PROVIDERS = priorTlsProviders;
});

for (const routeCase of ["general", "provider", "alias"] as const) {
  test(`MaxAI ${routeCase} image route uses connection-scoped Firefox transport`, async () => {
    const connectionId = await createMaxaiConnection();
    let observedOptions: Record<string, unknown> | undefined;
    setTlsClientForTest({
      available: true,
      fetch: async (_url, options) => {
        observedOptions = options as unknown as Record<string, unknown>;
        return Response.json({
          status: "OK",
          data: [{ png_url: "https://images.example.test/notebook.png" }],
        });
      },
    });

    const response =
      routeCase === "general"
        ? await imageRoute.POST(imageRequest())
        : await providerImageRoute.POST(imageRequest(routeCase === "alias" ? "mx" : "maxai"), {
            params: Promise.resolve({ provider: routeCase === "alias" ? "mx" : "maxai" }),
          });

    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(observedOptions?.browserProfile, "firefox_150");
    assert.equal(observedOptions?.os, "windows");
    assert.equal(observedOptions?.sessionScope, connectionId);
  });
}

test("MaxAI image route refreshes near expiry, uses the minted token, and persists rotation", async () => {
  const now = Math.floor(Date.now() / 1000);
  const staleAccess = fakeJwt(now + 30, "stale-image");
  const oldRefresh = fakeJwt(now + 86_400, "old-image-refresh");
  const mintedAccess = fakeJwt(now + 86_400, "minted-image");
  const rotatedRefresh = fakeJwt(now + 172_800, "rotated-image-refresh");
  const connectionId = await createMaxaiConnection({
    accessToken: staleAccess,
    refreshToken: oldRefresh,
  });
  const calls: Array<{ url: string; authorization: string; profile: unknown; os: unknown }> = [];
  setTlsClientForTest({
    available: true,
    fetch: async (url, options) => {
      const headers = new Headers(options?.headers as HeadersInit);
      calls.push({
        url: String(url),
        authorization: headers.get("authorization") ?? "",
        profile: options?.browserProfile,
        os: options?.os,
      });
      if (String(url).endsWith("/oauth/refresh_access_token")) {
        return Response.json({
          data: { access_token: mintedAccess, refresh_token: rotatedRefresh },
        });
      }
      return Response.json({
        status: "OK",
        data: [{ png_url: "https://images.example.test/refreshed.png" }],
      });
    },
  });

  const response = await imageRoute.POST(imageRequest());
  assert.equal(response.status, 200, await response.clone().text());
  const refreshCall = calls.find((call) => call.url.endsWith("/oauth/refresh_access_token"));
  const imageCall = calls.find((call) => call.url.endsWith("/gpt/get_image_generate_response"));
  assert.equal(refreshCall?.authorization, `Bearer ${oldRefresh}`);
  assert.equal(imageCall?.authorization, `Bearer ${mintedAccess}`);
  assert.ok(calls.every((call) => call.profile === "firefox_150" && call.os === "windows"));

  const stored = await providersDb.getProviderConnectionById(connectionId);
  assert.equal(stored?.accessToken, mintedAccess);
  const storedData = stored?.providerSpecificData as Record<string, unknown>;
  assert.equal(storedData.maxaiAccessToken, mintedAccess);
  assert.equal(storedData.maxaiRefreshToken, rotatedRefresh);
});

test("MaxAI model discovery refreshes near expiry and uses the minted token", async () => {
  const now = Math.floor(Date.now() / 1000);
  const staleAccess = fakeJwt(now + 30, "stale-models");
  const oldRefresh = fakeJwt(now + 86_401, "old-models-refresh");
  const mintedAccess = fakeJwt(now + 86_401, "minted-models");
  const rotatedRefresh = fakeJwt(now + 172_801, "rotated-models-refresh");
  const connectionId = await createMaxaiConnection({
    accessToken: staleAccess,
    refreshToken: oldRefresh,
  });
  const authorizations: string[] = [];
  setTlsClientForTest({
    available: true,
    fetch: async (url, options) => {
      authorizations.push(new Headers(options?.headers as HeadersInit).get("authorization") ?? "");
      if (String(url).endsWith("/oauth/refresh_access_token")) {
        return Response.json({
          data: { access_token: mintedAccess, refresh_token: rotatedRefresh },
        });
      }
      return Response.json({
        data: {
          chat_models: [
            {
              model_name: "gpt-5.6-luna",
              ui_display_name: "GPT 5.6 Luna",
              type: "chat",
              max_tokens: 1_050_000,
            },
          ],
        },
      });
    },
  });

  const response = await modelsRoute.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
    { params: { id: connectionId } }
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(authorizations.filter(Boolean), [
    `Bearer ${oldRefresh}`,
    `Bearer ${mintedAccess}`,
  ]);
  const stored = await providersDb.getProviderConnectionById(connectionId);
  const storedData = stored?.providerSpecificData as Record<string, unknown>;
  assert.equal(storedData.maxaiAccessToken, mintedAccess);
  assert.equal(storedData.maxaiRefreshToken, rotatedRefresh);
});

test("MaxAI model discovery uses connection-scoped Firefox transport", async () => {
  const connectionId = await createMaxaiConnection();
  let observedOptions: Record<string, unknown> | undefined;
  setTlsClientForTest({
    available: true,
    fetch: async (_url, options) => {
      observedOptions = options as unknown as Record<string, unknown>;
      return Response.json({
        data: {
          chat_models: [
            {
              model_name: "gpt-5.6-luna",
              ui_display_name: "GPT 5.6 Luna",
              type: "chat",
              max_tokens: 1_050_000,
            },
          ],
        },
      });
    },
  });

  const response = await modelsRoute.GET(
    new Request(`http://localhost/api/providers/${connectionId}/models?refresh=true`),
    { params: { id: connectionId } }
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(observedOptions?.browserProfile, "firefox_150");
  assert.equal(observedOptions?.os, "windows");
  assert.equal(observedOptions?.sessionScope, connectionId);
});
