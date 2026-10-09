import { describe, test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// --- Create harness function (similar to _chatPipelineHarness pattern) ---
async function createSettingsApiHarness() {
  const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-settings-api-"));
  process.env.DATA_DIR = testDataDir;
  process.env.REQUIRE_API_KEY = "false";
  if (!process.env.API_KEY_SECRET) {
    process.env.API_KEY_SECRET = "test-settings-api-secret-" + Date.now();
  }

  // --- Dynamic imports AFTER env setup ---
  const core = await import("../../src/lib/db/core.ts");
  const { getSettings, updateSettings } = await import("../../src/lib/db/settings.ts");
  const settingsRoute = await import("../../src/app/api/settings/route.ts");

  async function resetStorage() {
    core.resetDbInstance();
    fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(testDataDir, { recursive: true });
  }

  function cleanup() {
    core.resetDbInstance();
    fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  return {
    testDataDir,
    core,
    getSettings,
    updateSettings,
    settingsRoute,
    resetStorage,
    cleanup,
  };
}

// --- Initialize harness ---
const harness = await createSettingsApiHarness();

// --- Static import for helper (doesn't depend on DB) ---
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const RESPONSE_SECRET_FIXTURES = {
  oidcClientSecret: "oidc-settings-response-fixture",
  skillsmpApiKey: "skillsmp-settings-response-fixture",
  cliproxyapi_api_key: "cliproxy-settings-response-fixture",
};

async function seedResponseSecrets() {
  await harness.updateSettings({
    requireLogin: false,
    password: null,
    ...RESPONSE_SECRET_FIXTURES,
  });
}

function assertSettingsResponseOmitsSecrets(body: Record<string, unknown>) {
  assert.equal(body.password, undefined);
  for (const [key, secret] of Object.entries(RESPONSE_SECRET_FIXTURES)) {
    assert.equal(body[key], undefined, `${key} must not be returned`);
    assert.equal(JSON.stringify(body).includes(secret), false, `${key} value must not be echoed`);
  }
}

beforeEach(async () => {
  await harness.resetStorage();
});

afterEach(async () => {
  await harness.resetStorage();
});

after(() => {
  harness.cleanup();
});

describe("Settings API - persisted preferences", () => {
  test("getSettings defaults Responses previous_response_id handling to auto", async () => {
    const settings = await harness.getSettings();
    assert.strictEqual(settings.responsesPreviousResponseIdMode, "auto");
  });

  describe("credential-free settings responses", () => {
    test("GET omits persisted credentials and reports only configured flags", async () => {
      await seedResponseSecrets();
      const response = await harness.settingsRoute.GET(
        await makeManagementSessionRequest("http://localhost/api/settings", {
          method: "GET",
        })
      );
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assertSettingsResponseOmitsSecrets(body);
      assert.equal(body.hasOidcClientSecret, true);
      assert.equal(body.hasSkillsmpApiKey, true);
      assert.equal(body.hasCliproxyapiApiKey, true);
    });

    test("PATCH and PUT omit persisted credentials after successful updates", async () => {
      for (const method of ["PATCH", "PUT"] as const) {
        await harness.resetStorage();
        await seedResponseSecrets();
        const request = await makeManagementSessionRequest("http://localhost/api/settings", {
          method,
          body: { debugMode: method === "PATCH" },
        });
        const handler =
          method === "PATCH" ? harness.settingsRoute.PATCH : harness.settingsRoute.PUT;
        const response = await handler(request);
        const body = (await response.json()) as Record<string, unknown>;

        assert.equal(response.status, 200, `${method} should succeed`);
        assertSettingsResponseOmitsSecrets(body);
        assert.equal(body.hasOidcClientSecret, true);
        assert.equal(body.hasSkillsmpApiKey, true);
        assert.equal(body.hasCliproxyapiApiKey, true);
      }
    });

    test("partial updates retain omitted credentials and explicit empty strings clear them", async () => {
      const originalCliproxyEnv = process.env.CLIPROXYAPI_API_KEY;
      delete process.env.CLIPROXYAPI_API_KEY;
      try {
        await seedResponseSecrets();
        const partialResponse = await harness.settingsRoute.PATCH(
          await makeManagementSessionRequest("http://localhost/api/settings", {
            method: "PATCH",
            body: { debugMode: true },
          })
        );
        assert.equal(partialResponse.status, 200);
        assertSettingsResponseOmitsSecrets(
          (await partialResponse.json()) as Record<string, unknown>
        );

        let stored = await harness.getSettings();
        assert.equal(stored.oidcClientSecret, RESPONSE_SECRET_FIXTURES.oidcClientSecret);
        assert.equal(stored.skillsmpApiKey, RESPONSE_SECRET_FIXTURES.skillsmpApiKey);
        assert.equal(stored.cliproxyapi_api_key, RESPONSE_SECRET_FIXTURES.cliproxyapi_api_key);

        const clearResponse = await harness.settingsRoute.PATCH(
          await makeManagementSessionRequest("http://localhost/api/settings", {
            method: "PATCH",
            body: {
              oidcClientSecret: "",
              skillsmpApiKey: "",
              cliproxyapi_api_key: "",
            },
          })
        );
        const clearedBody = (await clearResponse.json()) as Record<string, unknown>;
        assert.equal(clearResponse.status, 200);
        assertSettingsResponseOmitsSecrets(clearedBody);
        assert.equal(clearedBody.hasOidcClientSecret, false);
        assert.equal(clearedBody.hasSkillsmpApiKey, false);
        assert.equal(clearedBody.hasCliproxyapiApiKey, false);

        stored = await harness.getSettings();
        assert.equal(stored.oidcClientSecret, "");
        assert.equal(stored.skillsmpApiKey, "");
        assert.equal(stored.cliproxyapi_api_key, "");
      } finally {
        if (originalCliproxyEnv === undefined) delete process.env.CLIPROXYAPI_API_KEY;
        else process.env.CLIPROXYAPI_API_KEY = originalCliproxyEnv;
      }
    });
  });

  describe("debugMode", () => {
    test("updateSettings with debugMode=true succeeds", async () => {
      const result = await harness.updateSettings({ debugMode: true });
      assert.ok(result, "updateSettings should return truthy result");

      const settings = await harness.getSettings();
      assert.strictEqual(settings.debugMode, true, "debugMode should be true");
    });

    test("updateSettings with debugMode=false succeeds", async () => {
      const result = await harness.updateSettings({ debugMode: false });
      assert.ok(result, "updateSettings should return truthy result");

      const settings = await harness.getSettings();
      assert.strictEqual(settings.debugMode, false, "debugMode should be false");
    });
  });

  describe("hiddenSidebarItems", () => {
    test("updateSettings with hiddenSidebarItems=['translator'] succeeds", async () => {
      const result = await harness.updateSettings({ hiddenSidebarItems: ["translator"] });
      assert.ok(result, "updateSettings should return truthy result");

      const settings = await harness.getSettings();
      assert.deepStrictEqual(
        settings.hiddenSidebarItems,
        ["translator"],
        "hiddenSidebarItems should contain translator"
      );
    });

    test("updateSettings with empty hiddenSidebarItems succeeds", async () => {
      const result = await harness.updateSettings({ hiddenSidebarItems: [] });
      assert.ok(result, "updateSettings should return truthy result");

      const settings = await harness.getSettings();
      assert.deepStrictEqual(
        settings.hiddenSidebarItems,
        [],
        "hiddenSidebarItems should be empty array"
      );
    });
  });

  describe("hiddenSidebarGroupLabels", () => {
    test("updateSettings with hiddenSidebarGroupLabels=['logs','audit'] succeeds", async () => {
      const result = await harness.updateSettings({ hiddenSidebarGroupLabels: ["logs", "audit"] });
      assert.ok(result, "updateSettings should return truthy result");

      const settings = await harness.getSettings();
      assert.deepStrictEqual(
        settings.hiddenSidebarGroupLabels,
        ["logs", "audit"],
        "hiddenSidebarGroupLabels should contain logs and audit"
      );
    });

    test("PATCH /api/settings persists hiddenSidebarGroupLabels", async () => {
      const response = await harness.settingsRoute.PATCH(
        await makeManagementSessionRequest("http://localhost/api/settings", {
          method: "PATCH",
          body: { hiddenSidebarGroupLabels: ["system"] },
        })
      );
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.deepEqual(body.hiddenSidebarGroupLabels, ["system"]);

      const settings = await harness.getSettings();
      assert.deepEqual(settings.hiddenSidebarGroupLabels, ["system"]);
    });
  });

  describe("combined updates", () => {
    test("updateSettings with both debugMode and hiddenSidebarItems succeeds", async () => {
      const result = await harness.updateSettings({
        debugMode: true,
        hiddenSidebarItems: ["translator"],
      });
      assert.ok(result, "updateSettings should return truthy result");

      const settings = await harness.getSettings();
      assert.strictEqual(settings.debugMode, true, "debugMode should be true");
      assert.deepStrictEqual(
        settings.hiddenSidebarItems,
        ["translator"],
        "hiddenSidebarItems should be updated"
      );
    });

    test("updateSettings persists antigravitySignatureCacheMode", async () => {
      const result = await harness.updateSettings({
        antigravitySignatureCacheMode: "bypass-strict",
      });
      assert.ok(result, "updateSettings should return truthy result");

      const settings = await harness.getSettings();
      assert.strictEqual(
        settings.antigravitySignatureCacheMode,
        "bypass-strict",
        "antigravitySignatureCacheMode should be updated"
      );
    });

    test("PATCH /api/settings persists endpoint tunnel visibility", async () => {
      const response = await harness.settingsRoute.PATCH(
        await makeManagementSessionRequest("http://localhost/api/settings", {
          method: "PATCH",
          body: {
            hideEndpointCloudflaredTunnel: true,
            hideEndpointTailscaleFunnel: true,
            hideEndpointNgrokTunnel: true,
          },
        })
      );
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body.hideEndpointCloudflaredTunnel, true);
      assert.equal(body.hideEndpointTailscaleFunnel, true);
      assert.equal(body.hideEndpointNgrokTunnel, true);

      const settings = await harness.getSettings();
      assert.equal(settings.hideEndpointCloudflaredTunnel, true);
      assert.equal(settings.hideEndpointTailscaleFunnel, true);
      assert.equal(settings.hideEndpointNgrokTunnel, true);
    });

    test("PATCH /api/settings persists Responses previous_response_id handling", async () => {
      const response = await harness.settingsRoute.PATCH(
        await makeManagementSessionRequest("http://localhost/api/settings", {
          method: "PATCH",
          body: { responsesPreviousResponseIdMode: "strip" },
        })
      );
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body.responsesPreviousResponseIdMode, "strip");

      const settings = await harness.getSettings();
      assert.equal(settings.responsesPreviousResponseIdMode, "strip");
    });

    test("GET /api/settings returns Cache-Control: no-store (ported from upstream #951)", async () => {
      const response = await harness.settingsRoute.GET(
        await makeManagementSessionRequest("http://localhost/api/settings", {
          method: "GET",
        })
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("Cache-Control"),
        "no-store",
        "GET /api/settings must return Cache-Control: no-store so persisted settings stay fresh after refresh/restart"
      );
    });

    test("PATCH /api/settings returns Cache-Control: no-store (ported from upstream #951)", async () => {
      const response = await harness.settingsRoute.PATCH(
        await makeManagementSessionRequest("http://localhost/api/settings", {
          method: "PATCH",
          body: { debugMode: true },
        })
      );
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("Cache-Control"),
        "no-store",
        "PATCH /api/settings must return Cache-Control: no-store"
      );
    });

    test("PUT /api/settings reuses the PATCH update flow", async () => {
      const response = await harness.settingsRoute.PUT(
        await makeManagementSessionRequest("http://localhost/api/settings", {
          method: "PUT",
          body: { antigravitySignatureCacheMode: "bypass" },
        })
      );
      const body = (await response.json()) as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body.antigravitySignatureCacheMode, "bypass");
    });
  });
});
