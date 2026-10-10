import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const publicSpec = yaml.load(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8"));

const successContracts = [
  ["/api/health/ping", "get", "HealthPingResponse"],
  ["/api/health/degradation", "get", "HealthDegradationResponse"],
  ["/api/omniroute/status", "get", "OmniRouteStatusResponse"],
  ["/api/network/info", "get", "NetworkInfoResponse"],
  ["/api/search/stats", "get", "SearchStatsResponse"],
  ["/api/search/providers", "get", "SearchProviderCatalogResponse"],
  ["/api/session-pools", "get", "WebSessionPoolHealthReport"],
  ["/api/session-pools/{provider}", "get", "WebSessionPoolProviderResponse"],
  ["/api/resilience/model-cooldowns", "get", "ModelCooldownListResponse"],
  ["/api/resilience/model-cooldowns", "delete", "ModelCooldownClearResponse"],
  ["/api/analytics/auto-routing", "get", "AutoRoutingAnalyticsResponse"],
  ["/api/analytics/compression", "get", "CompressionAnalyticsSummaryResponse"],
  ["/api/analytics/diversity", "get", "ProviderDiversityReportResponse"],
  ["/api/free-provider-rankings", "get", "FreeProviderRankingsResponse"],
  ["/api/tags", "get", "OllamaTagsResponse"],
] as const;

const responseStatusContracts = [
  ["/api/health/ping", "get", ["200", "503"]],
  ["/api/health/degradation", "get", ["200", "401", "403", "500", "503"]],
  ["/api/omniroute/status", "get", ["200", "401", "403", "500", "503"]],
  ["/api/network/info", "get", ["200", "401", "403", "503"]],
  ["/api/search/stats", "get", ["200", "401", "403", "500", "503"]],
  ["/api/search/providers", "get", ["200", "401", "403", "500", "503"]],
  ["/api/session-pools", "get", ["200", "401", "403", "500", "503"]],
  ["/api/session-pools/{provider}", "get", ["200", "401", "403", "404", "500", "503"]],
  ["/api/resilience/model-cooldowns", "get", ["200", "401", "403", "500", "503"]],
  ["/api/resilience/model-cooldowns", "delete", ["200", "400", "401", "403", "500", "503"]],
  ["/api/analytics/auto-routing", "get", ["200", "401", "403", "503"]],
  ["/api/analytics/compression", "get", ["200", "401", "403", "500", "503"]],
  ["/api/analytics/diversity", "get", ["200", "401", "403", "500", "503"]],
  ["/api/free-provider-rankings", "get", ["200", "400", "401", "403", "500", "503"]],
  ["/api/tags", "get", ["200", "401", "403", "503"]],
] as const;

const errorResponseContracts = [
  ["/api/health/ping", "get", "503", "HealthPingErrorResponse"],
  ["/api/health/degradation", "get", "500", "StringErrorResponse"],
  ["/api/omniroute/status", "get", "500", "StringErrorResponse"],
  ["/api/network/info", "get", "401", "StringErrorResponse"],
  ["/api/search/stats", "get", "401", "StringErrorResponse"],
  ["/api/search/stats", "get", "500", "StringErrorResponse"],
  ["/api/search/providers", "get", "401", "ApiErrorResponse"],
  ["/api/search/providers", "get", "500", "ApiErrorResponse"],
  ["/api/session-pools", "get", "500", "StringErrorResponse"],
  ["/api/session-pools/{provider}", "get", "404", "StringErrorResponse"],
  ["/api/session-pools/{provider}", "get", "500", "StringErrorResponse"],
  ["/api/resilience/model-cooldowns", "get", "500", "StringErrorResponse"],
  ["/api/resilience/model-cooldowns", "delete", "400", "StringErrorResponse"],
  ["/api/resilience/model-cooldowns", "delete", "500", "StringErrorResponse"],
  ["/api/analytics/compression", "get", "500", "StringErrorResponse"],
  ["/api/analytics/diversity", "get", "500", "ProviderDiversityErrorResponse"],
  ["/api/free-provider-rankings", "get", "400", "FreeProviderRankingsQueryErrorResponse"],
] as const;

function schema(name: string): any {
  const value = spec.components.schemas[name];
  assert.ok(value, `components.schemas.${name} must exist`);
  return value;
}

function operation(pathname: string, method: string): any {
  const value = spec.paths[pathname]?.[method];
  assert.ok(value, `${method.toUpperCase()} ${pathname} must exist`);
  return value;
}

function assertSchemaRef(
  pathname: string,
  method: string,
  status: string,
  component: string
): void {
  assert.equal(
    operation(pathname, method).responses?.[status]?.content?.["application/json"]?.schema?.$ref,
    `#/components/schemas/${component}`,
    `${method.toUpperCase()} ${pathname} ${status} response schema`
  );
}

test("runtime and observability operations expose source-backed success response schemas", () => {
  assert.equal(successContracts.length, 15);
  assert.equal(responseStatusContracts.length, 15);
  assert.equal(errorResponseContracts.length, 17);

  for (const [pathname, method, component] of successContracts) {
    assertSchemaRef(pathname, method, "200", component);
  }

  for (const [pathname, method, expectedStatuses] of responseStatusContracts) {
    assert.deepEqual(
      Object.keys(operation(pathname, method).responses ?? {}).sort(),
      [...expectedStatuses].sort(),
      `${method.toUpperCase()} ${pathname} response statuses`
    );
  }

  for (const [pathname, method, status, component] of errorResponseContracts) {
    assertSchemaRef(pathname, method, status, component);
  }

  assert.equal(schema("HealthDegradationResponse").oneOf.length, 2);
  assert.equal(schema("ModelCooldownClearResponse").oneOf.length, 2);
  assert.equal(
    operation("/api/resilience/model-cooldowns", "delete").responses["400"].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.equal(
    operation("/api/session-pools/{provider}", "get").responses["404"].content["application/json"]
      .schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.equal(
    operation("/api/free-provider-rankings", "get").responses["400"].content["application/json"]
      .schema.$ref,
    "#/components/schemas/FreeProviderRankingsQueryErrorResponse"
  );
});

test("management errors reuse canonical response refs and source-specific error envelopes remain distinct", () => {
  const managementOperations = [
    ["/api/omniroute/status", "get"],
    ["/api/session-pools", "get"],
    ["/api/session-pools/{provider}", "get"],
    ["/api/resilience/model-cooldowns", "get"],
    ["/api/resilience/model-cooldowns", "delete"],
    ["/api/analytics/auto-routing", "get"],
    ["/api/analytics/compression", "get"],
  ] as const;

  for (const [pathname, method] of managementOperations) {
    const responses = operation(pathname, method).responses;
    assert.equal(responses["401"].$ref, "#/components/responses/ManagementAuthenticationRequired");
    assert.equal(responses["403"].$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(responses["503"].$ref, "#/components/responses/ManagementAuthUnavailable");
  }

  assert.equal(
    operation("/api/search/providers", "get").responses["401"].content["application/json"].schema
      .$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  assert.equal(
    operation("/api/search/stats", "get").responses["401"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.equal(
    operation("/api/health/ping", "get").responses["503"].content["application/json"].schema.$ref,
    "#/components/schemas/HealthPingErrorResponse"
  );

  const diversityError = schema("ProviderDiversityErrorResponse");
  assert.equal(diversityError.properties.error.type, "string");
  assert.equal(diversityError.required, undefined);
});

test("special response shapes preserve their source-specific compatibility details", () => {
  const searchProviders = schema("SearchProviderCatalogResponse");
  assert.deepEqual(searchProviders.required, ["providers", "data"]);
  assert.equal(
    searchProviders.properties.data.items.$ref,
    "#/components/schemas/SearchProviderLegacyDataItem"
  );

  const tags = schema("OllamaTagModel");
  assert.deepEqual(tags.required, ["name", "modified_at", "size", "digest", "details"]);
  assert.equal(tags.properties.model, undefined);
  assert.equal(
    operation("/api/tags", "get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/OllamaTagsResponse"
  );
  assert.notEqual(schema("OllamaTagsResponse"), schema("VscodeOllamaTagsResponse"));

  const statsFilters = schema("SearchStatsRecentItem").properties.filters;
  assert.equal(statsFilters.type, undefined, "request-summary filters are arbitrary parsed JSON");

  const healthStatus = schema("OmniRouteStatusResponse");
  assert.equal(healthStatus.properties.liveRequestExecuted.const, false);
  assert.equal(healthStatus.properties.circuits.oneOf.length, 2);
});

test("public OpenAPI artifact mirrors the canonical document", () => {
  assert.deepEqual(publicSpec, spec);
});
