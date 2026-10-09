import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: Array<{
          name: string;
          in: string;
          required?: boolean;
          schema?: { enum?: unknown[]; default?: unknown; maxLength?: number };
        }>;
        requestBody?: {
          content?: Record<string, { schema?: { $ref?: string } }>;
        };
        responses?: Record<
          string,
          {
            content?: Record<
              string,
              { schema?: { $ref?: string; oneOf?: Array<{ $ref?: string }> } }
            >;
          }
        >;
      }
    >
  >;
  components: {
    schemas: Record<
      string,
      {
        description?: string;
        oneOf?: Array<{ $ref?: string }>;
        properties?: Record<
          string,
          { format?: string; pattern?: string; description?: string; $ref?: string }
        >;
      }
    >;
  };
};

function responseSchema(pathTemplate: string, method: string, status = "200") {
  return spec.paths[pathTemplate]?.[method]?.responses?.[status]?.content?.["application/json"]
    ?.schema;
}

test("usage analytics contracts document their source-defined query and response shapes", () => {
  const analytics = spec.paths["/api/usage/analytics"]?.get;
  assert.deepEqual(
    analytics?.parameters?.find((parameter) => parameter.name === "range")?.schema?.enum,
    ["1h", "1d", "7d", "30d", "90d", "180d", "365d", "ytd", "all"]
  );
  assert.equal(
    responseSchema("/api/usage/analytics", "get", "400")?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );

  const utilization = spec.paths["/api/usage/utilization"]?.get;
  assert.deepEqual(
    utilization?.parameters?.find((parameter) => parameter.name === "range")?.schema?.enum,
    ["1h", "24h", "7d", "30d"]
  );
  assert.equal(
    responseSchema("/api/usage/utilization", "get")?.$ref,
    "#/components/schemas/ProviderUtilizationResponse"
  );

  const quota = spec.paths["/api/usage/quota"]?.get;
  assert.equal(
    quota?.parameters?.some((parameter) => parameter.name === "connectionId"),
    true
  );
  assert.equal(
    responseSchema("/api/usage/quota", "get")?.$ref,
    "#/components/schemas/QuotaResponse"
  );

  const health = spec.paths["/api/usage/combo-health"]?.get;
  assert.equal(health?.parameters?.find((parameter) => parameter.name === "range")?.required, true);
  assert.equal(
    responseSchema("/api/usage/combo-health", "get")?.$ref,
    "#/components/schemas/ComboHealthResponse"
  );

  const forecast = spec.paths["/api/usage/combo-forecast"]?.get;
  assert.equal(
    forecast?.parameters?.find((parameter) => parameter.name === "range")?.schema?.default,
    "7d"
  );
  assert.equal(
    forecast?.parameters?.find((parameter) => parameter.name === "horizon")?.schema?.default,
    "30d"
  );
  assert.equal(
    responseSchema("/api/usage/combo-forecast", "get")?.$ref,
    "#/components/schemas/ComboForecastResponse"
  );
});

test("token-limit CRUD documents the validator body and all response envelopes", () => {
  const route = spec.paths["/api/usage/token-limits"];
  assert.equal(
    route?.post?.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/SetTokenLimitRequest"
  );
  assert.equal(
    responseSchema("/api/usage/token-limits", "get")?.$ref,
    "#/components/schemas/TokenLimitListResponse"
  );
  assert.equal(
    responseSchema("/api/usage/token-limits", "post")?.$ref,
    "#/components/schemas/TokenLimitUpsertResponse"
  );
  assert.equal(
    responseSchema("/api/usage/token-limits", "delete")?.$ref,
    "#/components/schemas/TokenLimitDeleteResponse"
  );

  const invalidBody = responseSchema("/api/usage/token-limits", "post", "400");
  assert.deepEqual(
    invalidBody?.oneOf?.map((schema) => schema.$ref),
    ["#/components/schemas/ApiErrorResponse", "#/components/schemas/ValidationErrorResponse"]
  );
  assert.equal(
    spec.components.schemas.TokenLimitWithUsage.properties?.windowStart?.pattern,
    "^\\d+$"
  );
  assert.equal(spec.components.schemas.TokenLimit.properties?.createdAt?.format, undefined);
});

test("combo autopilot, dashboard, and scoring contracts expose their typed results", () => {
  const autopilot = spec.paths["/api/usage/combo-health-autopilot"]?.get;
  assert.equal(
    autopilot?.parameters?.find((parameter) => parameter.name === "range")?.schema?.default,
    "24h"
  );
  assert.equal(
    autopilot?.parameters?.find((parameter) => parameter.name === "includeHealthy")?.schema
      ?.default,
    "false"
  );
  assert.equal(
    responseSchema("/api/usage/combo-health-autopilot", "get")?.$ref,
    "#/components/schemas/ComboAutopilotReport"
  );

  const dashboard = spec.paths["/api/usage/combo-health-dashboard"]?.get;
  assert.equal(
    dashboard?.parameters?.find((parameter) => parameter.name === "taskType")?.schema?.maxLength,
    64
  );
  assert.equal(
    responseSchema("/api/usage/combo-health-dashboard", "get")?.$ref,
    "#/components/schemas/ComboHealthDashboardResponse"
  );
  assert.equal(
    responseSchema("/api/usage/combo-scoring-inspector", "get")?.$ref,
    "#/components/schemas/ComboScoringInspectorResponse"
  );
});

test("provider limits and quota-window usage expose their source-defined response shapes", () => {
  assert.equal(
    responseSchema("/api/usage/provider-limits", "get")?.$ref,
    "#/components/schemas/ProviderLimitsCacheResponse"
  );
  assert.equal(
    responseSchema("/api/usage/provider-limits", "post")?.$ref,
    "#/components/schemas/ProviderLimitsSyncResponse"
  );
  assert.match(
    spec.components.schemas.ProviderLimitsSyncResponse.description ?? "",
    /unchanged cached entries/
  );

  const windowCosts = spec.paths["/api/usage/provider-window-costs"]?.get;
  assert.equal(
    windowCosts?.parameters?.find((parameter) => parameter.name === "provider")?.required,
    true
  );
  assert.equal(
    responseSchema("/api/usage/provider-window-costs", "get")?.$ref,
    "#/components/schemas/ProviderWindowCostBreakdown"
  );

  const dailyUsage = spec.paths["/api/usage/requests-by-provider-date"]?.get;
  assert.equal(
    dailyUsage?.parameters?.find((parameter) => parameter.name === "date")?.required ?? false,
    false
  );
  assert.equal(
    responseSchema("/api/usage/requests-by-provider-date", "get")?.$ref,
    "#/components/schemas/RequestsByProviderDateResponse"
  );
  assert.deepEqual(
    spec.components.schemas.ProviderBillingStatus.oneOf?.map((schema) => schema.$ref),
    ["#/components/schemas/GrokBillingStatus", "#/components/schemas/KimiBillingStatus"]
  );
});
