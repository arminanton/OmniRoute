import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  maxItems?: number;
  maximum?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: Schema | boolean;
};

type Operation = {
  parameters?: Array<{ name: string; required?: boolean; schema?: Schema }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function responseSchema(
  pathTemplate: string,
  method: string,
  status = "200",
  contentType = "application/json"
) {
  return spec.paths[pathTemplate]?.[method]?.responses?.[status]?.content?.[contentType]?.schema;
}

test("usage text logs, proxy logs, and bulk budget describe their returned shapes", () => {
  assert.equal(
    responseSchema("/api/usage/logs", "get")?.$ref,
    "#/components/schemas/UsageTextLogListResponse"
  );
  const logs = spec.components.schemas.UsageTextLogListResponse;
  assert.equal(logs.type, "array");
  assert.equal(logs.maxItems, 200);
  assert.equal(logs.items?.type, "string");
  assert.equal(
    responseSchema("/api/usage/request-logs", "get")?.$ref,
    "#/components/schemas/UsageTextLogListResponse"
  );
  assert.equal(
    responseSchema("/api/usage/proxy-logs", "get")?.$ref,
    "#/components/schemas/ProxyLogListResponse"
  );
  assert.equal(
    responseSchema("/api/usage/proxy-logs", "delete")?.$ref,
    "#/components/schemas/ProxyLogsClearedResponse"
  );
  assert.equal(
    responseSchema("/api/usage/budget/bulk", "get")?.$ref,
    "#/components/schemas/UsageBudgetBulkResponse"
  );
});

test("reset-credit, combo trace, and route-explanation responses expose typed records", () => {
  const resetRoute = spec.paths["/api/usage/codex-reset-credit"];
  assert.equal(
    resetRoute?.get?.parameters?.find((parameter) => parameter.name === "connectionId")?.required,
    true
  );
  assert.equal(
    resetRoute?.post?.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ResetCreditRedeemRequest"
  );
  assert.equal(
    responseSchema("/api/usage/codex-reset-credit", "get")?.$ref,
    "#/components/schemas/ResetCreditListResponse"
  );
  assert.deepEqual(spec.components.schemas.ComboDecisionTraceEntry.properties?.decision.enum, [
    "dispatched",
    "skipped_before_dispatch",
    "not_reached",
  ]);
  assert.equal(
    responseSchema("/api/usage/combo-trace/{id}", "get")?.$ref,
    "#/components/schemas/ComboDecisionTrace"
  );
  assert.equal(
    responseSchema("/api/usage/route-explain/{id}", "get")?.$ref,
    "#/components/schemas/RouteExplainabilityResponse"
  );
  assert.equal(
    spec.components.schemas.RouteExplainTargetStats.properties?.successRate.maximum,
    100
  );
});

test("om-usage documents text and JSON modes and provider-specific usage remains open-ended", () => {
  const omUsage = spec.paths["/api/usage/om-usage"]?.get;
  assert.equal(omUsage?.responses?.["200"]?.content?.["text/plain"]?.schema?.type, "string");
  assert.equal(
    omUsage?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/UsageCommandJson"
  );
  assert.equal(
    responseSchema("/api/usage/{connectionId}", "get")?.$ref,
    "#/components/schemas/ProviderQuotaUsageRecord"
  );
  assert.equal(spec.components.schemas.ProviderQuotaUsageRecord.additionalProperties, true);
});
