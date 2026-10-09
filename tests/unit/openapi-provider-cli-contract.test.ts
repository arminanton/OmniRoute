import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  enum?: Array<string | null>;
  const?: string;
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  items?: Schema;
  additionalProperties?: Schema | boolean;
};

type Operation = {
  parameters?: Array<{ name: string; required?: boolean }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
  security?: Array<Record<string, string[]>>;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function responseSchema(pathTemplate: string, method: string, status = "200") {
  return spec.paths[pathTemplate]?.[method]?.responses?.[status]?.content?.["application/json"]
    ?.schema;
}

function requestSchema(pathTemplate: string, method: string) {
  return spec.paths[pathTemplate]?.[method]?.requestBody?.content?.["application/json"]?.schema;
}

test("provider filter and interception routes document validator-backed management contracts", () => {
  assert.equal(
    spec.paths["/api/providers/{id}/param-filters"]?.get?.security?.some(
      (requirement) => Object.keys(requirement).length === 0
    ),
    true,
    "management auth is conditional when the deployment does not require it"
  );
  assert.equal(
    responseSchema("/api/providers/{id}/param-filters", "get")?.$ref,
    "#/components/schemas/ProviderParamFilter"
  );
  assert.equal(
    requestSchema("/api/providers/{id}/param-filters", "put")?.$ref,
    "#/components/schemas/ProviderParamFilterUpdate"
  );
  assert.equal(
    responseSchema("/api/providers/{id}/param-filters", "delete")?.$ref,
    "#/components/schemas/SuccessResponse"
  );
  assert.deepEqual(spec.components.schemas.ProviderInterceptionRule.properties?.fetchBackend.enum, [
    "firecrawl",
    "jina",
    "tavily",
  ]);
  assert.equal(
    requestSchema("/api/providers/{id}/interception-rules", "put")?.$ref,
    "#/components/schemas/ProviderInterceptionRulesUpdate"
  );
  assert.equal(
    responseSchema("/api/providers/{id}/interception-rules", "get")?.$ref,
    "#/components/schemas/ProviderInterceptionRules"
  );
});

test("provider Claude Code aliases expose nullable inheritance overrides", () => {
  assert.deepEqual(spec.components.schemas.ProviderCcAliasValue.enum, ["on", "off", null]);
  assert.equal(
    responseSchema("/api/providers/{id}/cc-alias", "get")?.$ref,
    "#/components/schemas/ProviderCcAliasResponse"
  );
  assert.equal(
    requestSchema("/api/providers/{id}/cc-alias", "put")?.$ref,
    "#/components/schemas/ProviderCcAliasUpdate"
  );
});

test("Antigravity MITM and alias operations describe their body and response variants", () => {
  assert.equal(
    spec.paths["/api/cli-tools/antigravity-mitm"]?.get?.security?.some(
      (requirement) => Object.keys(requirement).length === 0
    ),
    true
  );
  assert.equal(
    responseSchema("/api/cli-tools/antigravity-mitm", "get")?.$ref,
    "#/components/schemas/AntigravityMitmStatus"
  );
  assert.equal(
    requestSchema("/api/cli-tools/antigravity-mitm", "post")?.$ref,
    "#/components/schemas/AntigravityMitmStartRequest"
  );
  assert.equal(
    requestSchema("/api/cli-tools/antigravity-mitm", "delete")?.$ref,
    "#/components/schemas/AntigravityMitmStopRequest"
  );

  const aliasGet = spec.paths["/api/cli-tools/antigravity-mitm/alias"]?.get;
  assert.equal(
    aliasGet?.parameters?.find((parameter) => parameter.name === "tool")?.required,
    false
  );
  assert.equal(
    responseSchema("/api/cli-tools/antigravity-mitm/alias", "get")?.$ref,
    "#/components/schemas/AntigravityMitmAliasGetResponse"
  );
  assert.equal(
    requestSchema("/api/cli-tools/antigravity-mitm/alias", "put")?.$ref,
    "#/components/schemas/AntigravityMitmAliasUpdateRequest"
  );
  assert.deepEqual(
    spec.components.schemas.AntigravityMitmAliasEntry.properties?.reasoningEffort.enum,
    ["none", "low", "medium", "high", "xhigh", "max", "extra"]
  );
});
