import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const routePath = "/api/settings/obsidian";
const source = fs.readFileSync(path.join(ROOT, "src/app/api/settings/obsidian/route.ts"), "utf8");

function operation(method: "get" | "post" | "delete") {
  const result = spec.paths?.[routePath]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${routePath}`);
  return result;
}

function assertObsidianAuthContract(op: any, method: string) {
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
    `${method} documents the source-backed anonymous bootstrap/open-mode path`
  );
  for (const unsupported of ["BearerAuth", "LocalCliTokenAuth"]) {
    assert.equal(
      security.some((requirement: Record<string, unknown>) => unsupported in requirement),
      false,
      `${method} does not accept ${unsupported}`
    );
  }
  assert.ok(op.responses?.["401"]);
  assert.match(op.description ?? "", /requireLogin=false/);
  assert.match(op.description ?? "", /first-run loopback bootstrap/);
}

test("Obsidian integration contracts match redaction, URL guard, and helper auth behavior", () => {
  const get = operation("get");
  assertObsidianAuthContract(get, "GET");
  const getResponse = get.responses?.["200"];
  assert.equal(getResponse?.["x-sensitive"], true);
  assert.equal(
    getResponse?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ObsidianIntegrationStatusResponse"
  );
  for (const statusCode of ["401", "500"]) assert.ok(get.responses?.[statusCode]);
  for (const statusCode of ["400", "403", "503"]) {
    assert.equal(get.responses?.[statusCode], undefined);
  }
  const statusSchema = spec.components.schemas.ObsidianIntegrationStatusResponse;
  assert.equal(statusSchema["x-sensitive"], true);
  assert.deepEqual(statusSchema.required, ["connected", "hasToken", "baseUrl", "vaultPath"]);
  assert.deepEqual(Object.keys(statusSchema.properties).sort(), [
    "baseUrl",
    "connected",
    "hasToken",
    "vaultPath",
  ]);
  assert.equal(statusSchema.properties.token, undefined);
  assert.equal(statusSchema.properties.baseUrl["x-sensitive"], true);
  assert.equal(statusSchema.properties.vaultPath["x-sensitive"], true);
  assert.match(
    source,
    /connected: config\.connected,\s*hasToken: config\.token !== null,\s*baseUrl: config\.baseUrl,\s*vaultPath: config\.vaultPath/
  );

  const post = operation("post");
  assertObsidianAuthContract(post, "POST");
  assert.match(post.description ?? "", /cloud-metadata and link-local destinations/);
  assert.match(post.description ?? "", /loopback, LAN and Tailscale/);
  const requestBody = post.requestBody;
  assert.equal(requestBody?.required, true);
  assert.equal(requestBody?.["x-sensitive"], true);
  assert.equal(
    requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ObsidianIntegrationSetTokenRequest"
  );
  const setToken = spec.components.schemas.ObsidianIntegrationSetTokenRequest;
  assert.equal(setToken["x-sensitive"], true);
  assert.deepEqual(setToken.required, ["token"]);
  assert.equal(setToken.additionalProperties, false);
  assert.equal(setToken.properties.token.minLength, 1);
  assert.equal(setToken.properties.token.maxLength, 5000);
  assert.equal(setToken.properties.token.writeOnly, true);
  assert.equal(setToken.properties.token["x-sensitive"], true);
  assert.equal(setToken.properties.baseUrl.format, "uri");
  assert.equal(setToken.properties.baseUrl.pattern, "^[hH][tT][tT][pP][sS]?://");
  assert.match(setToken.properties.baseUrl.description, /cloud-metadata and link-local/);
  assert.equal(
    post.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ObsidianIntegrationConnectResponse"
  );
  assert.ok(post.responses?.["400"]);
  for (const statusCode of ["403", "500", "503"]) {
    assert.equal(post.responses?.[statusCode], undefined);
  }
  assert.match(source, /parseAndValidateNonMetadataUrl\(value\)/);
  assert.match(source, /const result = await client\.checkStatus\(\)/);
  assert.ok(
    source.indexOf("const result = await client.checkStatus()") <
      source.indexOf("setObsidianToken(parsed.data.token)"),
    "token persistence must remain after the outbound validation succeeds"
  );

  const del = operation("delete");
  assertObsidianAuthContract(del, "DELETE");
  assert.equal(
    del.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ObsidianIntegrationDisconnectResponse"
  );
  assert.match(del.description ?? "", /server URL and vault path are retained/);
  for (const statusCode of ["401", "500"]) assert.ok(del.responses?.[statusCode]);
  for (const statusCode of ["400", "403", "503"]) {
    assert.equal(del.responses?.[statusCode], undefined);
  }
  assert.match(source, /clearObsidianToken\(\)/);
  assert.deepEqual(spec.paths[routePath], publicSpec.paths[routePath]);
});
