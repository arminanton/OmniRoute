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

const CACHE_OPERATIONS = [
  ["/api/cache/entries", "get"],
  ["/api/cache/entries", "delete"],
  ["/api/cache/reasoning", "get"],
  ["/api/cache/reasoning", "delete"],
] as const;

function operation(route: string, method: string) {
  const result = spec.paths?.[route]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${route}`);
  return result;
}

function sourceCacheOperations() {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (
      relativeFile !== "src/app/api/cache/entries/route.ts" &&
      relativeFile !== "src/app/api/cache/reasoning/route.ts"
    ) {
      continue;
    }
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

test("cache-entry operations match source and document legacy conditional management auth", () => {
  const documented = new Set(CACHE_OPERATIONS.map(([route, method]) => `${method} ${route}`));
  assert.deepEqual([...documented].sort(), [...sourceCacheOperations()].sort());
  assert.equal(documented.size, 4);

  for (const [route, method] of CACHE_OPERATIONS) {
    const op = operation(route, method);
    assert.equal(classifyRoute(route, method.toUpperCase()).routeClass, "MANAGEMENT");
    assert.equal(isPublicApiRoute(route, method.toUpperCase()), false);
    assert.notEqual(op["x-always-protected"], true);
    assert.notEqual(op["x-local-only"], true);
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => "ManagementApiKeyBearerAuth" in entry)
    );
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => "ManagementSessionAuth" in entry)
    );
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${method.toUpperCase()} ${route} documents standalone requireLogin=false access`
    );
    assert.equal(
      op.security?.some((entry: Record<string, unknown>) => "BearerAuth" in entry),
      false,
      "legacy isAuthenticated() does not validate oma_ access tokens when auth is required"
    );
    assert.match(op.description ?? "", /isAuthenticated\(\)/);
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.match(op.description ?? "", /locked management/i);
    assert.match(op.description ?? "", /oma_/i);
    assert.match(op.description ?? "", /loopback CLI tokens/i);
    assert.ok(op.responses?.["401"], `${method.toUpperCase()} ${route} must document 401`);
    assert.equal(op.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
  }
});

test("semantic-cache routes document paginated metadata and selected invalidations", () => {
  const list = operation("/api/cache/entries", "get");
  assert.equal(
    list.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/SemanticCacheEntriesResponse"
  );
  assert.equal(
    list.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  const params = parameterMap(list);
  assert.equal(params.get("page")?.schema?.default, 1);
  assert.equal(params.get("page")?.schema?.minimum, 1);
  assert.equal(params.get("limit")?.schema?.default, 20);
  assert.equal(params.get("limit")?.schema?.maximum, 100);
  assert.equal(params.get("sortBy")?.schema?.default, "created_at");
  assert.equal(params.get("sortBy")?.schema?.enum, undefined);
  assert.match(params.get("sortBy")?.description ?? "", /fall back/i);
  assert.equal(params.get("sortOrder")?.schema?.default, "desc");

  const listSchema = spec.components.schemas.SemanticCacheEntriesResponse;
  assert.deepEqual(listSchema.required, ["entries", "pagination"]);
  assert.equal(listSchema.properties.entries.items.$ref, "#/components/schemas/SemanticCacheEntry");
  assert.deepEqual(
    Object.keys(spec.components.schemas.SemanticCacheEntry.properties).sort(),
    ["created_at", "expires_at", "hit_count", "id", "model", "signature", "tokens_saved"].sort()
  );
  assert.match(
    spec.components.schemas.SemanticCacheEntry.description,
    /response body.*not returned/i
  );

  const remove = operation("/api/cache/entries", "delete");
  assert.equal(remove.requestBody, undefined);
  const deleteParams = parameterMap(remove);
  assert.deepEqual([...deleteParams.keys()].sort(), ["model", "signature"]);
  assert.match(remove.description, /signature takes precedence/i);
  assert.equal(
    remove.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/SemanticCacheDeleteResponse"
  );
  assert.equal(
    remove.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.match(
    spec.components.schemas.SemanticCacheDeleteResponse.description,
    /even if no row matched/i
  );
});

test("reasoning-cache routes protect opaque IDs and mark returned model reasoning sensitive", () => {
  const list = operation("/api/cache/reasoning", "get");
  const response = list.responses?.["200"];
  assert.equal(response?.["x-sensitive"], true);
  assert.equal(
    response?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ReasoningCacheResponse"
  );
  const responseSchema = spec.components.schemas.ReasoningCacheResponse;
  assert.equal(responseSchema["x-sensitive"], true);
  assert.equal(
    responseSchema.properties.entries.items.$ref,
    "#/components/schemas/ReasoningCacheEntry"
  );
  const entrySchema = spec.components.schemas.ReasoningCacheEntry;
  assert.equal(entrySchema.properties.reasoning["x-sensitive"], true);
  assert.equal(entrySchema.properties.toolCallId.pattern, "^rc2h:[a-f0-9]{64}$");
  assert.match(list.description, /raw model reasoning text/i);
  assert.equal(spec.components.schemas.ReasoningCacheStats.properties.replayRate.type, "string");
  assert.ok(
    spec.components.schemas.ReasoningCacheStats.properties.oldestEntry.type.includes("null")
  );

  const listParams = parameterMap(list);
  assert.equal(listParams.get("limit")?.schema?.default, 50);
  assert.equal(listParams.get("limit")?.schema?.maximum, 200);
  assert.equal(listParams.get("offset")?.schema?.default, 0);

  const remove = operation("/api/cache/reasoning", "delete");
  const deleteParams = parameterMap(remove);
  assert.deepEqual([...deleteParams.keys()].sort(), ["provider", "toolCallId"]);
  assert.equal(deleteParams.get("toolCallId")?.schema?.pattern, "^rc2h:[a-f0-9]{64}$");
  assert.match(remove.description, /raw client tool-call IDs are rejected/i);
  const scopes = spec.components.schemas.ReasoningCacheDeleteResponse.oneOf
    .map((variant: any) => variant.properties.scope.const)
    .sort();
  assert.deepEqual(scopes, ["all", "provider", "toolCallId"].sort());
  assert.equal(
    remove.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
});

test("cache-entry contracts are mirrored in the public OpenAPI document", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
