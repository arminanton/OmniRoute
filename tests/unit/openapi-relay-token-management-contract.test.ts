import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
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
const previousRequire = (globalThis as any).require;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-relay-token-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
// The application bundle runs this DB helper in its server runtime; direct tsx/ESM tests need a
// CommonJS require shim for the helper's lazy `require("node:crypto")` call.
(globalThis as any).require = createRequire(import.meta.url);
const core = await import("../../src/lib/db/core.ts");
const collectionRoute = await import("../../src/app/api/relay/tokens/route.ts");
const tokenRoute = await import("../../src/app/api/relay/tokens/[id]/route.ts");
const operations = [
  { file: "src/app/api/relay/tokens/route.ts", method: "get", path: "/api/relay/tokens" },
  { file: "src/app/api/relay/tokens/route.ts", method: "post", path: "/api/relay/tokens" },
  { file: "src/app/api/relay/tokens/[id]/route.ts", method: "get", path: "/api/relay/tokens/{id}" },
  {
    file: "src/app/api/relay/tokens/[id]/route.ts",
    method: "patch",
    path: "/api/relay/tokens/{id}",
  },
  {
    file: "src/app/api/relay/tokens/[id]/route.ts",
    method: "delete",
    path: "/api/relay/tokens/{id}",
  },
] as const;

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousAutoBackup === undefined) delete process.env.DISABLE_SQLITE_AUTO_BACKUP;
  else process.env.DISABLE_SQLITE_AUTO_BACKUP = previousAutoBackup;
  if (previousRequire === undefined) delete (globalThis as any).require;
  else (globalThis as any).require = previousRequire;
});

function operation(route: (typeof operations)[number]) {
  const result = spec.paths?.[route.path]?.[route.method];
  assert.ok(result, `missing ${route.method.toUpperCase()} ${route.path}`);
  return result;
}

function sourceOperations() {
  const root = apiRoot(ROOT);
  const files = new Set(operations.map(({ file }) => file));
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (!files.has(relativeFile as (typeof operations)[number]["file"])) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

test("relay-token OpenAPI methods match the centrally guarded source routes", () => {
  const documented = new Set(operations.map(({ method, path }) => `${method} ${path}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(documented.size, 5);

  for (const route of operations) {
    const method = route.method.toUpperCase();
    const op = operation(route);
    assert.equal(classifyRoute(route.path, method).routeClass, "MANAGEMENT");
    assert.equal(isLocalOnlyPath(route.path, method), false);
    assert.equal(isAlwaysProtectedPath(route.path), false);
    for (const scheme of [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
    ]) {
      assert.ok(
        op.security?.some((entry: Record<string, unknown>) => scheme in entry),
        `${method} ${route.path} must document ${scheme}`
      );
    }
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${method} ${route.path} must document the unlocked requireLogin=false profile`
    );
    assert.equal(
      op.security?.some(
        (entry: Record<string, unknown>) =>
          "RelayTokenBearerAuth" in entry || "RelayTokenHeaderAuth" in entry
      ),
      false,
      "dashboard token-management routes must not accept the relay credential they manage"
    );
    assert.ok(op.responses?.["401"] && op.responses?.["403"] && op.responses?.["503"]);
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.match(op.description ?? "", /central management policy/i);
  }

  assert.equal(inferRequiredScope("GET", "/api/relay/tokens"), "read");
  assert.equal(inferRequiredScope("GET", "/api/relay/tokens/rl_example"), "read");
  for (const method of ["POST", "PATCH", "DELETE"]) {
    assert.equal(inferRequiredScope(method, "/api/relay/tokens/rl_example"), "write");
  }
});

test("relay-token contracts distinguish one-time credentials from sensitive stored records", () => {
  const list = operation(operations[0]);
  assert.equal(
    list.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RelayTokenSummaryList"
  );
  assert.equal(list.responses?.["200"]?.["x-sensitive"], true);
  const summary = spec.components.schemas.RelayTokenSummary;
  assert.equal(summary.properties.tokenHash, undefined);
  assert.equal(summary.properties.rawToken, undefined);
  assert.equal(summary.properties.allowedModels.type, "string");

  const create = operation(operations[1]);
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RelayTokenCreateRequest"
  );
  assert.equal(
    create.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RelayTokenCreatedResponse"
  );
  assert.equal(create.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(create.responses?.["400"]);
  assert.ok(
    spec.components.schemas.RelayTokenCreatedResponse.properties.rawToken["x-sensitive"],
    "rawToken is returned only in the creation response"
  );

  const detail = operation(operations[2]);
  assert.equal(
    detail.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RelayTokenDetailResponse"
  );
  assert.equal(detail.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(detail.responses?.["404"]);
  const detailSchema = spec.components.schemas.RelayTokenDetailResponse;
  assert.equal(detailSchema.properties.logs.maxItems, 20);
  assert.equal(
    spec.components.schemas.RelayTokenLogEntry.properties.client_ip["x-sensitive"],
    true
  );
  assert.equal(detailSchema.properties.logs.items.$ref, "#/components/schemas/RelayTokenLogEntry");

  const patch = operation(operations[3]);
  assert.equal(
    patch.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RelayTokenPatchRequest"
  );
  assert.equal(
    patch.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RelayTokenManagementRecord"
  );
  assert.ok(patch.responses?.["400"] && patch.responses?.["404"]);
  assert.match(patch.description, /other fields.*ignored/i);

  const remove = operation(operations[4]);
  assert.equal(
    remove.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RelayTokenDeletedResponse"
  );
  assert.equal(spec.components.schemas.RelayTokenDeletedResponse.properties.success.const, true);
  assert.equal(remove.responses?.["404"], undefined, "delete is idempotent even for unknown ids");
});

test("relay-token handlers return the documented one-time, redacted, detail, and delete shapes", async () => {
  const createdResponse = await collectionRoute.POST(
    new Request("http://localhost/api/relay/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "contract test", metadata: { source: "test" } }),
    })
  );
  assert.equal(createdResponse.status, 200, JSON.stringify(await createdResponse.clone().json()));
  const created = await createdResponse.json();
  assert.deepEqual(Object.keys(created).sort(), ["id", "name", "rawToken", "tokenPrefix"].sort());
  assert.match(created.rawToken, /^relay_/);

  const listResponse = await collectionRoute.GET();
  assert.equal(listResponse.status, 200);
  const [summary] = await listResponse.json();
  assert.equal(summary.id, created.id);
  assert.equal(summary.tokenPrefix, created.tokenPrefix);
  assert.equal(typeof summary.allowedModels, "string");
  assert.equal("tokenHash" in summary, false);
  assert.equal("metadata" in summary, false);
  assert.equal("rawToken" in summary, false);

  const params = { params: Promise.resolve({ id: created.id }) };
  const detailResponse = await tokenRoute.GET(
    new Request(`http://localhost/api/relay/tokens/${created.id}`),
    params
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(typeof detail.tokenHash, "string");
  assert.equal(detail.metadata, JSON.stringify({ source: "test" }));
  assert.deepEqual(detail.usage, {
    lastHour: { requestCount: 0, totalCost: 0 },
    lastDay: { requestCount: 0, totalCost: 0 },
  });
  assert.deepEqual(detail.logs, []);
  assert.equal("rawToken" in detail, false);

  const patchResponse = await tokenRoute.PATCH(
    new Request(`http://localhost/api/relay/tokens/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, name: "ignored while toggling" }),
    }),
    params
  );
  assert.equal(patchResponse.status, 200);
  const patched = await patchResponse.json();
  assert.equal(patched.enabled, false);
  assert.equal(patched.name, "contract test", "enabled takes precedence over other patch fields");
  assert.equal(typeof patched.tokenHash, "string");
  assert.equal("rawToken" in patched, false);

  const invalidPatch = await tokenRoute.PATCH(
    new Request(`http://localhost/api/relay/tokens/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    params
  );
  assert.equal(invalidPatch.status, 400);

  const deleteResponse = await tokenRoute.DELETE(
    new Request(`http://localhost/api/relay/tokens/${created.id}`, { method: "DELETE" }),
    params
  );
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { success: true });

  const deleteMissingResponse = await tokenRoute.DELETE(
    new Request("http://localhost/api/relay/tokens/unknown", { method: "DELETE" }),
    { params: Promise.resolve({ id: "unknown" }) }
  );
  assert.equal(deleteMissingResponse.status, 200);
  assert.deepEqual(await deleteMissingResponse.json(), { success: true });
});

test("relay-token OpenAPI changes mirror in the public artifact", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
