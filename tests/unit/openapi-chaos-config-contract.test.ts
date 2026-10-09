import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";
import { isAlwaysProtectedPath, isLocalOnlyPath } from "../../src/server/authz/routeGuard.ts";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const previousDataDir = process.env.DATA_DIR;
const previousAutoBackup = process.env.DISABLE_SQLITE_AUTO_BACKUP;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-chaos-config-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const settings = await import("../../src/lib/db/settings.ts");
const chaosConfig = await import("../../src/lib/chaos/chaosConfig.ts");
const route = await import("../../src/app/api/chaos/config/route.ts");
const ROUTE = "/api/chaos/config";
const ROUTE_FILE = "src/app/api/chaos/config/route.ts";
const METHODS = ["get", "put", "delete"] as const;

test.beforeEach(async () => {
  core.resetDbInstance();
  chaosConfig.invalidateChaosConfigCache();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  await settings.updateSettings({ requireLogin: false });
});

test.after(() => {
  core.resetDbInstance();
  chaosConfig.invalidateChaosConfigCache();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousAutoBackup === undefined) delete process.env.DISABLE_SQLITE_AUTO_BACKUP;
  else process.env.DISABLE_SQLITE_AUTO_BACKUP = previousAutoBackup;
});

function operation(method: (typeof METHODS)[number]) {
  const result = spec.paths?.[ROUTE]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${ROUTE}`);
  return result;
}

function sourceOperations() {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (relativeFile !== ROUTE_FILE) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const apiPath of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${apiPath}`);
      }
    }
  }
  return result;
}

function jsonRequest(method: string, body?: unknown): Request {
  return new Request(`http://localhost${ROUTE}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("Chaos config operations match the management route and conditional auth contract", () => {
  const documented = new Set(METHODS.map((method) => `${method} ${ROUTE}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(documented.size, 3);

  for (const method of METHODS) {
    const upper = method.toUpperCase();
    const op = operation(method);
    assert.equal(classifyRoute(ROUTE, upper).routeClass, "MANAGEMENT");
    assert.equal(isAlwaysProtectedPath(ROUTE), false);
    assert.equal(isLocalOnlyPath(ROUTE, upper), false);
    assert.equal(inferRequiredScope(upper, ROUTE), method === "get" ? "read" : "write");
    for (const scheme of [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
    ]) {
      assert.ok(
        op.security?.some((entry: Record<string, unknown>) => scheme in entry),
        `${upper} must document ${scheme}`
      );
    }
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${upper} may be anonymous in the unlocked requireLogin=false profile`
    );
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.ok(op.responses?.["401"] && op.responses?.["403"] && op.responses?.["503"]);
  }
});

test("Chaos config contracts encode defaults, replacement semantics, limits, and sensitive prompt", () => {
  const read = operation("get");
  assert.equal(
    read.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ChaosConfigReadResponse"
  );
  assert.equal(read.responses?.["200"]?.["x-sensitive"], true);

  const put = operation("put");
  assert.equal(
    put.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ChaosConfigUpdateRequest"
  );
  assert.equal(put.requestBody?.["x-sensitive"], true);
  assert.equal(
    put.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ChaosConfigUpdateResponse"
  );
  assert.ok(put.responses?.["400"] && put.responses?.["500"]);
  assert.match(put.description, /replacement-style PUT/);

  const remove = operation("delete");
  assert.equal(
    remove.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ChaosConfigResetResponse"
  );

  const config = spec.components.schemas.ChaosConfig;
  assert.deepEqual(config.properties.defaultMode.enum, ["parallel", "collaborative"]);
  assert.equal(config.properties.providerOverrides.maxItems, 200);
  assert.equal(config.properties.timeoutMs.minimum, 5000);
  assert.equal(config.properties.timeoutMs.maximum, 600000);
  assert.equal(config.properties.maxTokens.minimum, 256);
  assert.equal(config.properties.maxTokens.maximum, 128000);
  assert.equal(config.properties.systemPrompt["x-sensitive"], true);
  const request = spec.components.schemas.ChaosConfigUpdateRequest;
  assert.equal(request.properties.enabled.default, false);
  assert.equal(request.properties.defaultMode.default, "parallel");
  assert.equal(request.properties.timeoutMs.default, 120000);
  assert.equal(request.properties.maxTokens.default, 4096);
  assert.deepEqual(request.properties.providerOverrides.default, []);
  assert.equal(spec.components.schemas.ChaosProviderOverrideInput.properties.enabled.default, true);
});

test("Chaos config handlers implement replacement defaults and reset behavior", async () => {
  const defaultConfig = () => JSON.parse(JSON.stringify(chaosConfig.DEFAULT_CHAOS_CONFIG));
  const getResponse = await route.GET(jsonRequest("GET"));
  assert.equal(getResponse.status, 200);
  assert.deepEqual((await getResponse.json()).config, defaultConfig());

  const updateResponse = await route.PUT(
    jsonRequest("PUT", { enabled: true, defaultMode: "collaborative", unknown: "stripped" })
  );
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.message, "Chaos config updated");
  assert.equal(updated.config.enabled, true);
  assert.equal(updated.config.defaultMode, "collaborative");
  assert.deepEqual(updated.config.providerOverrides, []);
  assert.equal(updated.config.timeoutMs, 120000);
  assert.equal(updated.config.maxTokens, 4096);

  const emptyPutResponse = await route.PUT(jsonRequest("PUT", {}));
  assert.equal(emptyPutResponse.status, 200);
  assert.deepEqual((await emptyPutResponse.json()).config, defaultConfig());

  const invalidResponse = await route.PUT(jsonRequest("PUT", { defaultMode: "invalid" }));
  assert.equal(invalidResponse.status, 400);

  const resetResponse = await route.DELETE(jsonRequest("DELETE"));
  assert.equal(resetResponse.status, 200);
  const reset = await resetResponse.json();
  assert.equal(reset.message, "Chaos config reset to defaults");
  assert.deepEqual(reset.config, defaultConfig());
});

test("Chaos config OpenAPI contracts mirror to the public artifact", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
