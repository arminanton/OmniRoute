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
          schema?: { enum?: unknown[]; default?: unknown };
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
    schemas: Record<string, { properties?: Record<string, { format?: string; pattern?: string }> }>;
  };
};

function responseSchema(pathTemplate: string, method: string, status = "200") {
  return spec.paths[pathTemplate]?.[method]?.responses?.[status]?.content?.["application/json"]
    ?.schema;
}

test("usage analytics contracts document their source-defined query and response shapes", () => {
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
