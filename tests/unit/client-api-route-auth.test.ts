import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-client-route-auth-"));
const originalDataDir = process.env.DATA_DIR;
const originalApiKey = process.env.OMNIROUTE_API_KEY;
const originalRequireApiKey = process.env.REQUIRE_API_KEY;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.OMNIROUTE_API_KEY = "sk-client-route-auth-test";
process.env.REQUIRE_API_KEY = "true";

const core = await import("../../src/lib/db/core.ts");
const { enforceClientApiRouteAuth } = await import("../../src/shared/utils/clientApiRouteAuth.ts");

test("route-level client auth accepts the valid bare x-api-key form accepted by CLIENT_API", async () => {
  const request = new Request("http://localhost/api/v1/web/fetch", {
    method: "POST",
    headers: { "x-api-key": process.env.OMNIROUTE_API_KEY! },
  });

  assert.equal(await enforceClientApiRouteAuth(request), null);
});

test("route-level client auth rejects an invalid x-api-key when key enforcement is enabled", async () => {
  const request = new Request("http://localhost/api/v1/web/fetch", {
    method: "POST",
    headers: { "x-api-key": "sk-invalid" },
  });

  const response = await enforceClientApiRouteAuth(request);
  assert.equal(response?.status, 401);
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalApiKey === undefined) delete process.env.OMNIROUTE_API_KEY;
  else process.env.OMNIROUTE_API_KEY = originalApiKey;
  if (originalRequireApiKey === undefined) delete process.env.REQUIRE_API_KEY;
  else process.env.REQUIRE_API_KEY = originalRequireApiKey;
});
