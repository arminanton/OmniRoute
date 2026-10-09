import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  description?: string;
  enum?: string[];
  oneOf?: Schema[];
  allOf?: Schema[];
  properties?: Record<string, Schema>;
  items?: Schema;
  [key: string]: unknown;
};

type Operation = {
  description?: string;
  parameters?: Array<{
    name: string;
    in?: string;
    required?: boolean;
    schema?: Schema;
  }>;
  security?: Array<Record<string, string[]>>;
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: Schema }>;
    }
  >;
  [key: string]: unknown;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    securitySchemes: Record<string, Schema>;
  };
};

function operation(pathTemplate: string, method: string): Operation {
  const value = spec.paths[pathTemplate]?.[method];
  assert.ok(value, `Expected ${method.toUpperCase()} ${pathTemplate} in OpenAPI`);
  return value;
}

function responseSchema(pathTemplate: string, method: string, status = "200"): Schema | undefined {
  return operation(pathTemplate, method).responses?.[status]?.content?.["application/json"]?.schema;
}

function isAnonymousAlternative(operationValue: Operation): boolean {
  return (
    operationValue.security?.some((requirement) => Object.keys(requirement).length === 0) ?? false
  );
}

test("CLI tools status endpoints match their source response contracts and auth locality", () => {
  assert.equal(
    responseSchema("/api/cli-tools/status", "get")?.$ref,
    "#/components/schemas/CliToolsStatusResponse"
  );
  assert.equal(
    responseSchema("/api/cli-tools/all-statuses", "get")?.$ref,
    "#/components/schemas/CliToolsAllStatusesResponse"
  );
  assert.equal(
    operation("/api/cli-tools/all-statuses", "get").parameters?.find((p) => p.name === "refresh")
      ?.required,
    false
  );
  assert.equal(
    responseSchema("/api/cli-tools/detect", "get")?.$ref,
    "#/components/schemas/CliToolsDetectResponse"
  );

  const status = operation("/api/cli-tools/status", "get");
  assert.equal(isAnonymousAlternative(status), true, "ordinary status remains Tier 3");
  assert.match(status.description ?? "", /management login is enabled/i);
  assert.ok(status.responses?.["401"]);
  assert.ok(status.responses?.["403"]);
  assert.ok(status.responses?.["503"]);

  for (const route of ["/api/cli-tools/all-statuses", "/api/cli-tools/detect"]) {
    const op = operation(route, "get");
    assert.equal(isAnonymousAlternative(op), false, `${route} must not allow anonymous access`);
    assert.equal(op["x-always-protected"], true);
    assert.match(op.description ?? "", /always-protected, including when `?requireLogin=false`?/);
    assert.ok(op.responses?.["401"]);
    assert.ok(op.responses?.["403"]);
    assert.ok(op.responses?.["503"]);
  }

  const detect = operation("/api/cli-tools/detect", "get");
  assert.equal(detect.parameters?.find((parameter) => parameter.name === "tool")?.required, false);
  const detectedTool = spec.components.schemas.CliToolDetectedTool;
  assert.equal(detectedTool.properties?.configContents?.["x-sensitive"], true);
  assert.match(detectedTool.properties?.configContents?.description ?? "", /may contain API keys/i);
});

test("CLI runtime path is loopback-only and documents the runtime catalog id", () => {
  const runtime = operation("/api/cli-tools/runtime/{toolId}", "get");
  assert.equal(runtime["x-loopback-only"], true);
  assert.equal(runtime.parameters?.[0]?.schema?.$ref, "#/components/schemas/CliToolId");
  assert.match(runtime.parameters?.[0]?.description ?? "", /case-normalization/i);
  assert.ok(spec.components.schemas.CliToolId.enum?.includes("amp"));
  assert.ok(spec.components.schemas.CliToolId.enum?.includes("grok-build"));
  assert.ok(spec.components.schemas.CliToolId.enum?.includes("5dive"));
  assert.equal(
    responseSchema("/api/cli-tools/runtime/{toolId}", "get")?.$ref,
    "#/components/schemas/CliToolsRuntimeResponse"
  );
  assert.ok(runtime.responses?.["404"]);
  assert.equal(isAnonymousAlternative(runtime), true);
});

test("guide settings GET is documented as its source-backed 400-only operation", () => {
  const guideGet = operation("/api/cli-tools/guide-settings/{toolId}", "get");
  assert.equal(guideGet.responses?.["200"], undefined);
  assert.equal(
    guideGet.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.match(guideGet.description ?? "", /does not implement reads/i);
});

test("CLI tools key listing marks rawKey sensitive and always protected", () => {
  const keysGet = operation("/api/cli-tools/keys", "get");
  assert.equal(keysGet["x-always-protected"], true);
  assert.equal(isAnonymousAlternative(keysGet), false);
  assert.ok(keysGet.security?.some((requirement) => "LocalCliTokenAuth" in requirement));
  assert.equal(spec.components.securitySchemes.LocalCliTokenAuth["name"], "x-omniroute-cli-token");
  assert.equal(
    responseSchema("/api/cli-tools/keys", "get")?.$ref,
    "#/components/schemas/CliToolsKeysResponse"
  );
  assert.match(
    spec.components.schemas.ApiKey.properties?.key?.description ?? "",
    /shorter.*fully masked as `\*\*\*\*`/i
  );
  const rawKey = spec.components.schemas.CliToolsApiKey.allOf?.find(
    (schema) => schema.properties?.rawKey
  )?.properties?.rawKey;
  assert.equal(rawKey?.["x-sensitive"], true);
  assert.match(rawKey?.description ?? "", /full, unmasked API key/i);
});
