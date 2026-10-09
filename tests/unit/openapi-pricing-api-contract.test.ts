import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { isPublicApiRoute } from "../../src/shared/constants/publicApiRoutes.ts";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;

const PRICING_PATHS = new Set([
  "/api/pricing",
  "/api/pricing/defaults",
  "/api/pricing/models",
  "/api/pricing/sync",
]);
const PRICING_CONTRACT_OPERATIONS = [
  ["/api/pricing", "get"],
  ["/api/pricing", "patch"],
  ["/api/pricing", "delete"],
  ["/api/pricing/defaults", "get"],
  ["/api/pricing/sync", "get"],
  ["/api/pricing/sync", "post"],
  ["/api/pricing/sync", "delete"],
] as const;

function operation(route: string, method: string) {
  const result = spec.paths?.[route]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${route}`);
  return result;
}

function sourcePricingOperations() {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (!relativeFile.startsWith("src/app/api/pricing/")) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

function parameterMap(op: any) {
  return new Map((op.parameters ?? []).map((parameter: any) => [parameter.name, parameter]));
}

function assertConditionalPricingManagementAuth(op: any, method: string, pathTemplate: string) {
  for (const scheme of [
    "BearerAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
  ]) {
    assert.ok(
      op.security?.some((requirement: Record<string, unknown>) => scheme in requirement),
      `${method.toUpperCase()} ${pathTemplate} must document ${scheme}`
    );
  }
  assert.ok(
    op.security?.some(
      (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
    ),
    `${method.toUpperCase()} ${pathTemplate} must reflect standalone requireLogin=false access`
  );
  assert.notEqual(op["x-always-protected"], true);
  assert.match(op.description ?? "", /requireLogin=false/);
  assert.match(op.description ?? "", /locked management/);
  for (const status of ["401", "403", "503"]) {
    assert.ok(
      op.responses?.[status],
      `${method.toUpperCase()} ${pathTemplate} must document ${status}`
    );
  }
}

test("pricing OpenAPI inventory matches source methods and conditional management auth", () => {
  const documented = new Set<string>();
  for (const pathTemplate of PRICING_PATHS) {
    for (const method of Object.keys(spec.paths[pathTemplate] ?? {})) {
      if (spec.paths[pathTemplate][method]?.operationId) {
        documented.add(`${method} ${pathTemplate}`);
      }
    }
  }
  assert.deepEqual([...documented].sort(), [...sourcePricingOperations()].sort());
  assert.equal(documented.size, 8, "seven pricing operations plus the already typed model catalog");

  for (const [pathTemplate, method] of PRICING_CONTRACT_OPERATIONS) {
    const op = operation(pathTemplate, method);
    assert.equal(classifyRoute(pathTemplate, method.toUpperCase()).routeClass, "MANAGEMENT");
    assert.equal(isPublicApiRoute(pathTemplate, method.toUpperCase()), false);
    assertConditionalPricingManagementAuth(op, method, pathTemplate);
    const write = method !== "get";
    assert.match(
      op.description ?? "",
      write ? /write-scoped access token/i : /read-scoped access token/i
    );
  }

  const modelCatalog = operation("/api/pricing/models", "get");
  assert.equal(
    modelCatalog.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingModelCatalogResponse"
  );
});

test("merged pricing read, source provenance, overrides, and resets are typed accurately", () => {
  const get = operation("/api/pricing", "get");
  const includeSources = parameterMap(get).get("includeSources");
  assert.equal(includeSources?.in, "query");
  assert.equal(includeSources?.required, false);
  assert.match(includeSources?.description ?? "", /exactly to `1`/);
  assert.equal(
    get.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingGetResponse"
  );
  assert.deepEqual(
    spec.components.schemas.PricingGetResponse.oneOf.map((variant: any) => variant.$ref),
    ["#/components/schemas/PricingMap", "#/components/schemas/PricingWithSourcesResponse"]
  );
  const sources = spec.components.schemas.PricingWithSourcesResponse.properties.sourceMap;
  assert.deepEqual(sources.additionalProperties.additionalProperties.enum, [
    "default",
    "litellm",
    "modelsDev",
    "user",
  ]);
  assert.match(spec.components.schemas.PricingRateEntry.description, /USD per one million tokens/i);

  const patch = operation("/api/pricing", "patch");
  assert.equal(
    patch.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingOverrideRequestMap"
  );
  assert.equal(
    patch.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingOverrideMap"
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.PricingOverrideRate.properties).sort(),
    ["input", "output", "cached", "reasoning", "cache_creation"].sort()
  );
  for (const field of Object.values(
    spec.components.schemas.PricingOverrideRate.properties
  ) as any[]) {
    assert.equal(field.minimum, 0);
  }
  assert.equal(spec.components.schemas.PricingOverrideRate.additionalProperties, false);
  assert.match(patch.description, /user overrides only/i);
  assert.match(patch.description, /not.*merged/i);
  assert.ok(patch.responses?.["400"]?.content?.["application/json"]?.schema?.oneOf);

  const defaults = operation("/api/pricing/defaults", "get");
  assert.equal(
    defaults.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingMap"
  );
  const reset = operation("/api/pricing", "delete");
  assert.deepEqual([...parameterMap(reset).keys()], ["provider", "model"]);
  assert.match(reset.description, /If `provider` is absent, resets all user overrides/i);
  assert.equal(
    reset.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingMap"
  );
});

test("pricing sync input, success/failure/status/clear responses match the source", () => {
  const start = operation("/api/pricing/sync", "post");
  assert.equal(start.requestBody?.required, true);
  assert.equal(
    start.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingSyncRequest"
  );
  const syncRequest = spec.components.schemas.PricingSyncRequest;
  assert.equal(syncRequest.additionalProperties, false);
  assert.equal(syncRequest.properties.sources.minItems, 1);
  assert.deepEqual(syncRequest.properties.sources.items.enum, ["litellm"]);
  assert.equal(syncRequest.properties.dryRun.default, false);
  assert.equal(
    start.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingSyncSuccessResponse"
  );
  assert.equal(
    start.responses?.["502"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingSyncFailureResponse"
  );
  assert.equal(
    start.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ValidationErrorResponse"
  );
  assert.equal(
    spec.components.schemas.PricingSyncSuccessResponse.properties.data.$ref,
    "#/components/schemas/PricingMap"
  );

  const status = operation("/api/pricing/sync", "get");
  assert.equal(
    status.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingSyncStatusResponse"
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.PricingSyncStatusResponse.properties).sort(),
    ["enabled", "lastSync", "lastSyncModelCount", "nextSync", "intervalMs", "sources"].sort()
  );
  const clear = operation("/api/pricing/sync", "delete");
  assert.equal(
    clear.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PricingSyncClearResponse"
  );
  assert.match(clear.description, /only.*pricing_synced/i);
});

test("pricing API contract is mirrored in public OpenAPI", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
