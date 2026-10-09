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
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-profile-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const { updateSettings } = await import("../../src/lib/db/settings.ts");
const profilesRoute = await import("../../src/app/api/cli-tools/codex-profiles/route.ts");
const ROUTE_FILE = "src/app/api/cli-tools/codex-profiles/route.ts";
const ROUTE = "/api/cli-tools/codex-profiles";
const METHODS = ["get", "post", "put", "delete"] as const;

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
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousAutoBackup === undefined) delete process.env.DISABLE_SQLITE_AUTO_BACKUP;
  else process.env.DISABLE_SQLITE_AUTO_BACKUP = previousAutoBackup;
});

test("Codex profile OpenAPI operations match the hard-protected source route and auth scopes", () => {
  const documented = new Set(METHODS.map((method) => `${method} ${ROUTE}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(documented.size, 4);

  for (const method of METHODS) {
    const upper = method.toUpperCase();
    const op = operation(method);
    assert.equal(classifyRoute(ROUTE, upper).routeClass, "MANAGEMENT");
    assert.equal(isAlwaysProtectedPath(ROUTE), true);
    assert.equal(isLocalOnlyPath(ROUTE, upper), false);
    assert.equal(op["x-always-protected"], true);
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
    assert.equal(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      false,
      `${upper} must not expose an anonymous alternative`
    );
    assert.match(op.description ?? "", /always-protected/i);
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.ok(op.responses?.["401"] && op.responses?.["403"] && op.responses?.["503"]);
  }
});

test("Codex profile contracts describe masked labels and local credential/config file effects", () => {
  const list = operation("get");
  assert.equal(
    list.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexProfileListResponse"
  );
  assert.equal(list.responses?.["200"]?.["x-sensitive"], true);
  const profile = spec.components.schemas.CodexProfileSummary;
  assert.equal(profile.properties.authLabel["x-sensitive"], true);
  assert.equal(profile.properties.authJson, undefined);
  assert.equal(profile.properties.configToml, undefined);

  const create = operation("post");
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexProfileNameRequest"
  );
  assert.equal(
    create.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexProfileSaveResponse"
  );
  assert.ok(create.responses?.["400"] && create.responses?.["403"] && create.responses?.["500"]);
  assert.match(
    create.description,
    /saves their contents in a JSON profile under the server's data directory/i
  );

  const activate = operation("put");
  assert.equal(
    activate.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexProfileIdRequest"
  );
  assert.equal(
    activate.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexProfileActivateResponse"
  );
  assert.ok(activate.responses?.["404"] && activate.responses?.["500"]);
  assert.match(
    activate.description,
    /restores the profile's stored `config.toml` and `auth.json`/i
  );

  const remove = operation("delete");
  assert.equal(
    remove.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexProfileIdRequest"
  );
  assert.equal(
    remove.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexProfileDeleteResponse"
  );
  assert.ok(remove.responses?.["404"]);
  assert.match(remove.description, /removes the saved profile file/i);

  assert.match(
    spec.components.schemas.CodexProfileIdRequest.properties.profileId.pattern,
    /A-Za-z0-9/
  );
  assert.deepEqual(spec.components.schemas.CodexProfileActivateResponse.required, [
    "success",
    "message",
    "profileId",
    "restoredConfig",
    "restoredAuth",
  ]);
});

test("Codex profile GET exposes only summary metadata from an isolated dummy profile", async () => {
  await updateSettings({ requireLogin: false });
  const profilesDir = path.join(TEST_DATA_DIR, "codex-profiles");
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "dummy-profile.json"),
    JSON.stringify({
      name: "dummy profile",
      authLabel: "API Key: sk-test1...",
      createdAt: "2026-10-09T00:00:00.000Z",
      configToml: "model = 'test'",
      authJson: JSON.stringify({ OPENAI_API_KEY: "sk-test-secret-not-for-response" }),
    })
  );

  const response = await profilesRoute.GET(
    new Request("http://localhost/api/cli-tools/codex-profiles")
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.profiles, [
    {
      id: "dummy-profile",
      name: "dummy profile",
      authLabel: "API Key: sk-test1...",
      createdAt: "2026-10-09T00:00:00.000Z",
      hasConfig: true,
      hasAuth: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(body), /sk-test-secret-not-for-response|model = 'test'/);
});

test("Codex profile OpenAPI contracts mirror to the public artifact", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
