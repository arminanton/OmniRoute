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
const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-cli-access-token-contract-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const collectionRoute = await import("../../src/app/api/cli/tokens/route.ts");
const tokenRoute = await import("../../src/app/api/cli/tokens/[id]/route.ts");

const operations = [
  { file: "src/app/api/cli/tokens/route.ts", method: "get", path: "/api/cli/tokens" },
  { file: "src/app/api/cli/tokens/route.ts", method: "post", path: "/api/cli/tokens" },
  { file: "src/app/api/cli/tokens/[id]/route.ts", method: "delete", path: "/api/cli/tokens/{id}" },
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

test("CLI access-token OpenAPI operations match central management auth and admin scope policy", () => {
  const documented = new Set(operations.map(({ method, path }) => `${method} ${path}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(documented.size, 3);

  for (const route of operations) {
    const method = route.method.toUpperCase();
    const op = operation(route);
    assert.equal(classifyRoute(route.path, method).routeClass, "MANAGEMENT");
    assert.equal(isLocalOnlyPath(route.path, method), false);
    assert.equal(isAlwaysProtectedPath(route.path), false);
    assert.equal(inferRequiredScope(method, route.path), "admin");
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
      `${method} ${route.path} may be anonymous in the unlocked requireLogin=false profile`
    );
    assert.equal(op["x-always-protected"], undefined);
    assert.match(op.description ?? "", /admin.*scoped Access Token/i);
    assert.match(op.description ?? "", /management API key with `manage` or `admin`/i);
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.ok(op.responses?.["401"] && op.responses?.["403"] && op.responses?.["503"]);
  }
});

test("CLI access-token schemas keep list data masked and mark plaintext creation output sensitive", () => {
  const list = operation(operations[0]);
  assert.equal(
    list.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CliAccessTokenListResponse"
  );
  assert.equal(list.responses?.["200"]?.["x-sensitive"], true);
  const record = spec.components.schemas.CliAccessTokenRecord;
  assert.equal(record.properties.token, undefined);
  assert.equal(record.properties.tokenHash, undefined);
  assert.deepEqual(record.properties.scope.enum, ["read", "write", "admin"]);

  const create = operation(operations[1]);
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CliAccessTokenCreateRequest"
  );
  assert.equal(create.requestBody?.["x-sensitive"], true);
  assert.equal(
    create.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CliAccessTokenCreatedResponse"
  );
  assert.equal(create.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(create.responses?.["400"]);
  assert.ok(create.responses?.["500"]);
  assert.equal(
    spec.components.schemas.CliAccessTokenCreatedResponse.properties.token["x-sensitive"],
    true
  );
  assert.equal(
    spec.components.schemas.CliAccessTokenCreateRequest.properties.scope.default,
    "read"
  );
  assert.equal(
    spec.components.schemas.CliAccessTokenCreateRequest.properties.expiresInDays.maximum,
    3650
  );

  const revoke = operation(operations[2]);
  assert.equal(
    revoke.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CliAccessTokenRevokedResponse"
  );
  assert.ok(revoke.responses?.["404"]);
  assert.ok(revoke.responses?.["500"]);
  assert.match(revoke.description, /echoes the identifier supplied in the path/i);
});

test("CLI access-token handlers match masked listing, one-time secret, and revoke contracts", async () => {
  const createResponse = await collectionRoute.POST(
    new Request("http://localhost/api/cli/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "contract token", scope: "admin", expiresInDays: 7 }),
    })
  );
  assert.equal(createResponse.status, 200);
  const created = await createResponse.json();
  assert.equal(created.success, true);
  assert.match(created.token, /^oma_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(created.scope, "admin");
  assert.equal(typeof created.tokenPrefix, "string");
  assert.equal(typeof created.createdAt, "string");
  assert.equal(typeof created.expiresAt, "string");

  const listResponse = await collectionRoute.GET(new Request("http://localhost/api/cli/tokens"));
  assert.equal(listResponse.status, 200);
  const list = await listResponse.json();
  assert.equal(list.tokens.length, 1);
  assert.equal(list.tokens[0].id, created.id);
  assert.equal(list.tokens[0].scope, "admin");
  assert.equal(list.tokens[0].tokenPrefix, created.tokenPrefix);
  assert.equal("token" in list.tokens[0], false);
  assert.equal("tokenHash" in list.tokens[0], false);

  const revokeByPrefix = await tokenRoute.DELETE(
    new Request(`http://localhost/api/cli/tokens/${created.tokenPrefix}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: created.tokenPrefix }) }
  );
  assert.equal(revokeByPrefix.status, 200);
  assert.deepEqual(await revokeByPrefix.json(), { success: true, id: created.tokenPrefix });

  const listAfterRevoke = await (
    await collectionRoute.GET(new Request("http://localhost/api/cli/tokens"))
  ).json();
  assert.equal(typeof listAfterRevoke.tokens[0].revokedAt, "string");

  const revokeAgain = await tokenRoute.DELETE(
    new Request(`http://localhost/api/cli/tokens/${created.id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: created.id }) }
  );
  assert.equal(revokeAgain.status, 404);
  assert.deepEqual(await revokeAgain.json(), { error: "Token not found or already revoked" });
});

test("CLI access-token contract is mirrored in public OpenAPI", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
