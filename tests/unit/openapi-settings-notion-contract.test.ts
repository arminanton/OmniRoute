import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const routePath = "/api/settings/notion";
const source = fs.readFileSync(path.join(ROOT, "src/app/api/settings/notion/route.ts"), "utf8");

function operation(method: "get" | "post" | "delete") {
  const result = spec.paths?.[routePath]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${routePath}`);
  return result;
}

function assertNotionAuthContract(op: any, method: string) {
  assert.equal(classifyRoute(routePath, method).routeClass, "MANAGEMENT");
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
    `${method} documents the source-backed requireLogin=false anonymous path`
  );
  assert.equal(
    security.some((requirement: Record<string, unknown>) => "LocalCliTokenAuth" in requirement),
    false,
    `${method} does not consume the local CLI token header`
  );
  assert.equal(
    security.some((requirement: Record<string, unknown>) => "BearerAuth" in requirement),
    false,
    `${method} does not use the general BearerAuth scheme for oma_live_ access tokens`
  );
  assert.ok(op.responses?.["401"]);
  assert.match(op.description ?? "", /requireLogin=false/);
}

test("Notion integration contracts match redaction, credential validation, and auth behavior", () => {
  const get = operation("get");
  assertNotionAuthContract(get, "GET");
  assert.equal(
    get.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/NotionIntegrationStatusResponse"
  );
  assert.ok(get.responses?.["500"]);
  const status = spec.components.schemas.NotionIntegrationStatusResponse;
  assert.deepEqual(status.required, ["connected", "hasToken"]);
  assert.deepEqual(Object.keys(status.properties).sort(), ["connected", "hasToken"]);
  assert.equal(status.properties.token, undefined);
  assert.match(source, /connected: config\.connected,\s*hasToken: config\.token !== null/);
  for (const statusCode of ["401", "500"]) assert.ok(get.responses?.[statusCode]);
  for (const statusCode of ["400", "403", "503"]) {
    assert.equal(get.responses?.[statusCode], undefined);
  }

  const post = operation("post");
  assertNotionAuthContract(post, "POST");
  assert.match(post.description ?? "", /outbound Notion search request/);
  const requestBody = post.requestBody;
  assert.equal(requestBody?.required, true);
  assert.equal(requestBody?.["x-sensitive"], true);
  assert.equal(
    requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/NotionIntegrationSetTokenRequest"
  );
  const setToken = spec.components.schemas.NotionIntegrationSetTokenRequest;
  assert.equal(setToken["x-sensitive"], true);
  assert.deepEqual(setToken.required, ["token"]);
  assert.equal(setToken.properties.token.minLength, 1);
  assert.equal(setToken.properties.token.maxLength, 500);
  assert.equal(setToken.properties.token.writeOnly, true);
  assert.equal(setToken.properties.token["x-sensitive"], true);
  assert.equal(
    post.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/NotionIntegrationConnectResponse"
  );
  assert.ok(post.responses?.["400"]);
  for (const statusCode of ["403", "500", "503"]) {
    assert.equal(post.responses?.[statusCode], undefined);
  }
  assert.match(
    source,
    /setTokenSchema = z\.object\(\{\s*token: z\.string\(\)\.min\(1\)\.max\(500\)/
  );
  assert.match(source, /createNotionClient\(parsed\.data\.token\)/);
  assert.match(source, /clearNotionToken\(\);\s*return NextResponse\.json\(/);

  const del = operation("delete");
  assertNotionAuthContract(del, "DELETE");
  assert.equal(
    del.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/NotionIntegrationDisconnectResponse"
  );
  assert.ok(del.responses?.["500"]);
  assert.deepEqual(spec.paths[routePath], publicSpec.paths[routePath]);
  for (const statusCode of ["401", "500"]) assert.ok(del.responses?.[statusCode]);
  for (const statusCode of ["400", "403", "503"]) {
    assert.equal(del.responses?.[statusCode], undefined);
  }
});
