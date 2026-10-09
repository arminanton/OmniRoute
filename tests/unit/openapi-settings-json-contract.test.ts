import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;

function operation(route: string, method: string) {
  const result = spec.paths?.[route]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${route}`);
  return result;
}

function assertAlwaysProtectedCredentialContract(op: any, method: string, route: string) {
  assert.equal(op["x-always-protected"], true, `${method.toUpperCase()} ${route}`);
  const security = op.security ?? [];
  for (const scheme of ["ManagementApiKeyBearerAuth", "ManagementSessionAuth"]) {
    assert.ok(
      security.some((requirement: Record<string, unknown>) => scheme in requirement),
      `${method.toUpperCase()} ${route} must document ${scheme}`
    );
  }
  assert.ok(
    security.some((requirement: Record<string, unknown>) => "BearerAuth" in requirement),
    `${method.toUpperCase()} ${route} must document the unlocked-profile access-token path`
  );
  assert.ok(
    security.some((requirement: Record<string, unknown>) => "LocalCliTokenAuth" in requirement),
    `${method.toUpperCase()} ${route} must document the unlocked loopback-CLI path`
  );
  assert.equal(
    security.some((requirement: Record<string, unknown>) => Object.keys(requirement).length === 0),
    false,
    `${method.toUpperCase()} ${route} must not advertise anonymous access`
  );
  assert.match(op.description ?? "", /always-protected/i);
  assert.match(op.description ?? "", /requireLogin=false/);
  assert.match(op.description ?? "", /loopback CLI token/i);
  assert.match(op.description ?? "", /dashboard session/i);
  for (const status of ["401", "403", "503"]) {
    assert.ok(op.responses?.[status], `${method.toUpperCase()} ${route} must document ${status}`);
  }
}

test("settings JSON export documents the sensitive backup shape and history opt-in", () => {
  const route = "/api/settings/export-json";
  const get = operation(route, "get");
  assertAlwaysProtectedCredentialContract(get, "get", route);

  const history = get.parameters?.find((parameter: any) => parameter.name === "includeHistory");
  assert.equal(history?.in, "query");
  assert.equal(history?.required, false);
  assert.equal(history?.schema?.type, "boolean");
  assert.equal(history?.schema?.default, false);

  const response = get.responses?.["200"];
  assert.equal(response?.["x-sensitive"], true);
  assert.equal(
    response?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/SettingsJsonExportResponse"
  );
  assert.equal(response?.headers?.["Content-Disposition"]?.schema?.type, "string");

  const schema = spec.components.schemas.SettingsJsonExportResponse;
  assert.equal(schema["x-sensitive"], true);
  assert.deepEqual(schema.required, [
    "settings",
    "providerConnections",
    "providerNodes",
    "combos",
    "apiKeys",
    "_meta",
  ]);
  assert.equal(schema.properties.providerConnections["x-sensitive"], true);
  assert.equal(schema.properties.apiKeys["x-sensitive"], true);
  assert.deepEqual(schema.properties._meta.required, ["exportedAt", "version", "includesHistory"]);
  assert.equal(schema.properties.usageHistory.description.includes("includeHistory=true"), true);
  assert.match(schema.description, /raw OmniRoute API keys/i);
  assert.match(schema.description, /password.*requireLogin/i);
  assert.equal(
    response.content["application/json"].schema.$ref,
    "#/components/schemas/SettingsJsonExportResponse"
  );
  assert.equal(
    get.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
});

test("settings JSON import documents both upload forms, sensitive data, and policy errors", () => {
  const route = "/api/settings/import-json";
  const post = operation(route, "post");
  assertAlwaysProtectedCredentialContract(post, "post", route);

  const body = post.requestBody;
  assert.equal(body?.required, true);
  assert.equal(body?.["x-sensitive"], true);
  assert.ok(body?.content?.["application/json"]?.schema?.$ref);
  const multipart = body?.content?.["multipart/form-data"]?.schema;
  assert.deepEqual(multipart?.required, ["file"]);
  assert.equal(multipart?.properties?.file?.type, "string");
  assert.equal(multipart?.properties?.file?.format, "binary");
  assert.match(body?.description ?? "", /not size-limited/i);

  const importSchema = spec.components.schemas.SettingsJsonImportRequest;
  assert.equal(importSchema["x-sensitive"], true);
  assert.equal(importSchema.properties.providerConnections["x-sensitive"], true);
  assert.equal(importSchema.properties.apiKeys["x-sensitive"], true);
  assert.ok(importSchema.properties.usageHistory);
  assert.ok(importSchema.properties.domainCostHistory);
  assert.ok(importSchema.properties.domainBudgets);
  assert.match(importSchema.description, /password.*requireLogin/i);

  assert.equal(
    post.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/SettingsJsonImportResponse"
  );
  assert.equal(
    post.responses?.["403"]?.content?.["application/json"]?.schema?.oneOf?.some(
      (variant: any) => variant.$ref === "#/components/schemas/ApiErrorResponse"
    ),
    true,
    "403 covers the locked runtime-policy denial"
  );
  for (const count of [
    "connections",
    "nodes",
    "combos",
    "apiKeys",
    "usageHistory",
    "domainCostHistory",
    "domainBudgets",
  ]) {
    assert.equal(
      spec.components.schemas.SettingsJsonImportResponse.properties[count]?.type,
      "integer"
    );
  }
  assert.match(post.description, /before reading the request body/i);
});

test("settings JSON contracts match the source route methods and synced public specification", () => {
  assert.deepEqual(
    Object.keys(spec.paths["/api/settings/export-json"]).filter((method) => method === "get"),
    ["get"]
  );
  assert.deepEqual(
    Object.keys(spec.paths["/api/settings/import-json"]).filter((method) => method === "post"),
    ["post"]
  );
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
