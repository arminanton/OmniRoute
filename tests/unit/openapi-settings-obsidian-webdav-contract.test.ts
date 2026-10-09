import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const routePath = "/api/settings/obsidian/webdav";
const source = fs.readFileSync(
  path.join(ROOT, "src/app/api/settings/obsidian/webdav/route.ts"),
  "utf8"
);

function operation(method: "get" | "post" | "delete") {
  const result = spec.paths?.[routePath]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${routePath}`);
  return result;
}

function assertAuth(op: any, method: string, allowNestedRevealAuth = false) {
  assert.equal(classifyRoute(routePath, method).routeClass, "MANAGEMENT");
  assert.equal(op["x-always-protected"], undefined);
  const security = op.security ?? [];
  for (const scheme of [
    "ManagementApiKeyBearerAuth",
    "ManagementAnthropicApiKeyAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementSessionAuth",
  ]) {
    assert.ok(
      security.some((requirement: Record<string, unknown>) => scheme in requirement),
      `${method} must document ${scheme}`
    );
  }
  assert.ok(
    security.some((requirement: Record<string, unknown>) => Object.keys(requirement).length === 0),
    `${method} preserves the source-backed open-mode/bootstrap path`
  );
  for (const [scheme, expected] of [
    ["BearerAuth", allowNestedRevealAuth],
    ["LocalCliTokenAuth", allowNestedRevealAuth],
    ["InternalServiceTokenAuth", allowNestedRevealAuth],
  ] as const) {
    assert.equal(
      security.some((requirement: Record<string, unknown>) => scheme in requirement),
      expected,
      `${method} ${expected ? "includes" : "does not include"} ${scheme}`
    );
  }
  assert.ok(op.responses?.["401"]);
  assert.match(op.description ?? "", /requireLogin=false/);
}

test("Obsidian WebDAV operations document credential exposure and conditional authentication", () => {
  const get = operation("get");
  assertAuth(get, "GET", true);
  assert.match(get.description ?? "", /plaintext reusable password/);
  assert.match(get.description ?? "", /read.*scope/);
  assert.equal(get.responses?.["200"]?.["x-sensitive"], true);
  assert.equal(
    get.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ObsidianWebdavStatusResponse"
  );
  for (const statusCode of ["401", "500"]) assert.ok(get.responses?.[statusCode]);
  for (const statusCode of ["400", "403", "503"]) {
    assert.equal(get.responses?.[statusCode], undefined);
  }
  const statusSchema = spec.components.schemas.ObsidianWebdavStatusResponse;
  assert.equal(statusSchema["x-sensitive"], true);
  assert.deepEqual(statusSchema.required, [
    "webdavEnabled",
    "webdavUsername",
    "webdavPassword",
    "webdavPasswordSet",
    "vaultPath",
  ]);
  assert.deepEqual(Object.keys(statusSchema.properties).sort(), [
    "vaultPath",
    "webdavEnabled",
    "webdavPassword",
    "webdavPasswordSet",
    "webdavUsername",
  ]);
  assert.deepEqual(statusSchema.properties.webdavPassword.type, ["string", "null"]);
  assert.equal(statusSchema.properties.webdavPassword["x-sensitive"], true);
  assert.equal(statusSchema.properties.vaultPath["x-sensitive"], true);
  assert.match(source, /requireManagementAuth\(request, \{ alwaysRequireAuth: true \}\)/);
  assert.match(
    source,
    /webdavPassword:\s*status\.webdavEnabled && hasManagement\s*\? status\.webdavPassword : null/
  );
  assert.match(
    source,
    /webdavPasswordSet:\s*status\.webdavEnabled && Boolean\(status\.webdavPassword\)/
  );

  const post = operation("post");
  assertAuth(post, "POST");
  assert.match(post.description ?? "", /anonymous credential creation/);
  assert.equal(post.requestBody?.required, true);
  assert.equal(post.requestBody?.["x-sensitive"], true);
  assert.equal(
    post.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ObsidianWebdavEnableRequest"
  );
  const requestSchema = spec.components.schemas.ObsidianWebdavEnableRequest;
  assert.equal(requestSchema["x-sensitive"], true);
  assert.deepEqual(requestSchema.required, ["vaultPath"]);
  assert.equal(requestSchema.properties.vaultPath.minLength, 1);
  assert.equal(requestSchema.properties.vaultPath.maxLength, 4096);
  assert.equal(requestSchema.additionalProperties, false);
  assert.equal(
    post.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ObsidianWebdavEnableResponse"
  );
  assert.equal(post.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(post.responses?.["400"]);
  for (const statusCode of ["403", "500", "503"]) {
    assert.equal(post.responses?.[statusCode], undefined);
  }
  const enableSchema = spec.components.schemas.ObsidianWebdavEnableResponse;
  assert.equal(enableSchema["x-sensitive"], true);
  assert.deepEqual(enableSchema.required, ["username", "password", "vaultPath"]);
  for (const field of ["username", "password", "vaultPath"]) {
    assert.equal(enableSchema.properties[field]["x-sensitive"], true);
  }
  assert.match(source, /vaultPath: z\.string\(\)\.min\(1\)\.max\(4096\)/);
  assert.match(
    source,
    /return NextResponse\.json\(\{\s*username: result\.username,\s*password: result\.password,\s*vaultPath: result\.vaultPath/s
  );

  const del = operation("delete");
  assertAuth(del, "DELETE");
  assert.match(del.description ?? "", /anonymous disable requests/);
  assert.equal(
    del.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ObsidianWebdavDisableResponse"
  );
  for (const statusCode of ["401", "500"]) assert.ok(del.responses?.[statusCode]);
  for (const statusCode of ["400", "403", "503"]) {
    assert.equal(del.responses?.[statusCode], undefined);
  }
  assert.match(source, /disableObsidianVaultSync\(\)/);
  assert.deepEqual(spec.paths[routePath], publicSpec.paths[routePath]);
});
