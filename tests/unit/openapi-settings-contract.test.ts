import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  enum?: string[];
  minProperties?: number;
  maxLength?: number;
  minimum?: number;
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
};

type Operation = {
  parameters?: Array<{ name: string; schema?: Schema }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function jsonResponse(pathTemplate: string, method: string, status = "200") {
  return spec.paths[pathTemplate]?.[method]?.responses?.[status]?.content?.["application/json"]
    ?.schema;
}

test("system prompt and thinking budget settings describe accepted and returned fields", () => {
  assert.equal(
    jsonResponse("/api/settings/system-prompt", "get")?.$ref,
    "#/components/schemas/SystemPromptConfig"
  );
  const prompt = spec.components.schemas.SystemPromptUpdate;
  assert.equal(prompt.minProperties, 1);
  assert.equal(prompt.properties.prefixPrompt.maxLength, 50000);
  assert.equal(prompt.properties.suffixPrompt.maxLength, 50000);
  assert.equal(prompt.additionalProperties, false);

  assert.equal(
    jsonResponse("/api/settings/thinking-budget", "get")?.$ref,
    "#/components/schemas/ThinkingBudgetConfig"
  );
  assert.deepEqual(spec.components.schemas.ThinkingBudgetUpdate.properties.mode.enum, [
    "passthrough",
    "auto",
    "custom",
    "adaptive",
  ]);
  assert.deepEqual(spec.components.schemas.ThinkingBudgetUpdate.properties.effortLevel.enum, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("IP filtering documents whitelist priority, temporary bans, and non-empty updates", () => {
  assert.deepEqual(spec.components.schemas.IpFilterConfig.properties.mode.enum, [
    "blacklist",
    "whitelist",
    "whitelist-priority",
  ]);
  assert.equal(spec.components.schemas.IpFilterUpdate.minProperties, 1);
  assert.equal(spec.components.schemas.IpFilterTempBanUpdate.properties.durationMs.minimum, 1);
  assert.equal(
    jsonResponse("/api/settings/ip-filter", "put")?.$ref,
    "#/components/schemas/IpFilterConfig"
  );
});

test("proxy settings describe query variants, scoped mutations, and test outcomes", () => {
  const proxyGet = spec.paths["/api/settings/proxy"]?.get;
  assert.deepEqual(
    proxyGet?.parameters?.find((parameter) => parameter.name === "level")?.schema?.enum,
    ["global", "provider", "combo", "key"]
  );
  assert.equal(
    jsonResponse("/api/settings/proxy", "get")?.$ref,
    "#/components/schemas/ProxyReadResponse"
  );
  assert.equal(
    spec.paths["/api/settings/proxy"]?.put?.requestBody?.content?.["application/json"]?.schema
      ?.$ref,
    "#/components/schemas/ProxyConfigUpdate"
  );
  assert.equal(
    jsonResponse("/api/settings/proxy/test", "post")?.$ref,
    "#/components/schemas/ProxyTestResponse"
  );
  assert.equal(spec.components.schemas.ProxyTestResponse.oneOf.length, 2);
});
