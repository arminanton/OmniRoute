import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

function responseSchema(route: string, method: string, status = "200") {
  const schema =
    spec.paths[route]?.[method]?.responses?.[status]?.content?.["application/json"]?.schema;
  assert.ok(schema, `missing JSON schema for ${method.toUpperCase()} ${route} ${status}`);
  return schema;
}

test("Qdrant semantic-search 200 documents typed results and an unconfigured outcome", () => {
  const operation = spec.paths["/api/settings/qdrant/search"]?.post;
  assert.ok(operation, "missing POST /api/settings/qdrant/search");

  const response = operation.responses?.["200"];
  assert.equal(
    response?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/QdrantSearchResponse"
  );
  assert.equal(response?.["x-sensitive"], true);
  assert.deepEqual(response?.content?.["application/json"]?.examples?.qdrantNotConfigured?.value, {
    ok: false,
    results: [],
  });

  const result = spec.components.schemas.QdrantSearchResponse;
  assert.deepEqual(result.required, ["ok", "results"]);
  assert.equal(result.properties.ok.type, "boolean");
  assert.equal(result.properties.results.type, "array");
  assert.equal(result.properties.results.items.$ref, "#/components/schemas/QdrantSearchResult");
  assert.equal(result.additionalProperties, false);

  const item = spec.components.schemas.QdrantSearchResult;
  assert.deepEqual(item.required, ["id", "score"]);
  assert.equal(item.properties.id.type, "string");
  assert.equal(item.properties.score.type, "number");
  assert.equal(item.properties.payload.type, "object");
  assert.equal(item.properties.payload["x-sensitive"], true);
  assert.equal(item.properties.payload.additionalProperties, true);
  assert.equal(item.additionalProperties, false);
});

test("authz inventory 200 documents the five tiers, bypass state, and CORS status", () => {
  assert.equal(
    responseSchema("/api/settings/authz-inventory", "get").$ref,
    "#/components/schemas/AuthzInventoryResponse"
  );

  const inventory = spec.components.schemas.AuthzInventoryResponse;
  assert.deepEqual(inventory.required, [
    "tiers",
    "bypassEnabled",
    "bypassPrefixes",
    "spawnCapablePrefixes",
    "cors",
  ]);
  assert.deepEqual(Object.keys(inventory.properties).sort(), [
    "bypassEnabled",
    "bypassPrefixes",
    "cors",
    "spawnCapablePrefixes",
    "tiers",
  ]);
  assert.equal(inventory.properties.bypassEnabled.type, "boolean");
  assert.equal(inventory.properties.bypassPrefixes.items.type, "string");
  assert.equal(inventory.properties.spawnCapablePrefixes.items.type, "string");
  assert.equal(inventory.properties.tiers.minItems, 5);
  assert.equal(inventory.properties.tiers.maxItems, 5);
  assert.equal(inventory.properties.tiers.items.$ref, "#/components/schemas/AuthzInventoryTier");
  assert.equal(inventory.properties.cors.$ref, "#/components/schemas/AuthzInventoryCorsStatus");
  assert.equal(inventory.additionalProperties, false);

  const tier = spec.components.schemas.AuthzInventoryTier;
  assert.deepEqual(tier.required, ["name", "prefixes", "description", "bypassable"]);
  assert.deepEqual(tier.properties.name.enum, [
    "LOCAL_ONLY",
    "ALWAYS_PROTECTED",
    "MANAGEMENT",
    "CLIENT_API",
    "PUBLIC",
  ]);
  assert.equal(tier.properties.prefixes.items.type, "string");
  assert.equal(tier.properties.description.type, "string");
  assert.equal(tier.properties.bypassable.type, "boolean");
  assert.equal(tier.additionalProperties, false);

  const cors = spec.components.schemas.AuthzInventoryCorsStatus;
  assert.deepEqual(cors.required, ["allowAll", "allowedOrigins"]);
  assert.equal(cors.properties.allowAll.type, "boolean");
  assert.equal(cors.properties.allowedOrigins.items.type, "string");
  assert.equal(cors.additionalProperties, false);
});
