import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as yaml from "js-yaml";

const canonicalText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

function operation(method: string, pathname: string) {
  const value = spec.paths[pathname]?.[method];
  assert.ok(value, `Missing ${method.toUpperCase()} ${pathname}`);
  return value;
}

const contracts = [
  ["post", "/api/compression/compare/verify", ["200", "400", "401", "403", "500", "503"], "CompressionFidelityBatchResult"],
  ["get", "/api/compression/engines", ["200", "401", "403", "500", "503"], "CompressionEnginesResponse"],
  ["post", "/api/compression/retrieve", ["200", "400", "401", "403", "500", "503"], "CompressionRetrieveResponse"],
  ["get", "/api/context/analytics/engine", ["200", "400", "401", "403", "500", "503"], "CompressionEngineAnalyticsResponse"],
  ["get", "/api/context/caveman/config", ["200", "401", "403", "500", "503"], "CompressionSettingsResponse"],
  ["put", "/api/context/caveman/config", ["200", "400", "401", "403", "500", "503"], "CompressionSettingsResponse"],
  ["delete", "/api/context/combos/{id}", ["200", "401", "403", "404", "503"], "ContextCompressionComboDeleteResponse"],
  ["get", "/api/context/combos/{id}", ["200", "401", "403", "404", "503"], "ContextCompressionComboRecord"],
  ["put", "/api/context/combos/{id}", ["200", "400", "401", "403", "404", "503"], "ContextCompressionComboRecord"],
  ["get", "/api/context/combos/{id}/assignments", ["200", "401", "403", "404", "503"], "ContextCompressionComboAssignmentsResponse"],
  ["put", "/api/context/combos/{id}/assignments", ["200", "400", "401", "403", "404", "503"], "ContextCompressionComboAssignmentsResponse"],
  ["get", "/api/context/combos/default", ["200", "401", "403", "503"], "ContextCompressionDerivedPlanResponse"],
  ["get", "/api/discovery/results", ["200", "401", "403", "500", "503"], "DiscoveryResultsResponse"],
] as const;

test("the audited compression/context/discovery operations have typed success and exact statuses", () => {
  assert.equal(contracts.length + 2, 15);
  for (const [method, pathname, statuses, schemaName] of contracts) {
    const op = operation(method, pathname);
    const success = op.responses["200"];
    assert.ok(success, `${method.toUpperCase()} ${pathname} has 200`);
    assert.ok(spec.components.schemas[schemaName], `Missing ${schemaName}`);
    assert.equal(
      success.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${schemaName}`,
      `${method.toUpperCase()} ${pathname}`,
    );
    assert.deepEqual(Object.keys(op.responses).sort(), [...statuses].sort());
  }
});

test("prompt/config/discovery response sensitivity is recorded", () => {
  assert.equal(operation("post", "/api/compression/compare/verify").requestBody["x-sensitive"], true);
  assert.equal(operation("post", "/api/compression/compare/verify").responses["200"]["x-sensitive"], true);
  assert.equal(operation("post", "/api/compression/retrieve").responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.CompressionCcrRetrieveBlockResponse.properties.block["x-sensitive"], true);
  assert.equal(operation("get", "/api/context/caveman/config").responses["200"]["x-sensitive"], true);
  assert.equal(operation("put", "/api/context/caveman/config").requestBody["x-sensitive"], true);
  assert.equal(operation("get", "/api/context/combos/{id}").responses["200"]["x-sensitive"], true);
  assert.equal(operation("put", "/api/context/combos/{id}").requestBody["x-sensitive"], true);
  assert.equal(operation("get", "/api/discovery/results").responses["200"]["x-sensitive"], true);
});

test("Cursor CLI models token exchange separately and limits no-store to that branch", () => {
  const get = operation("get", "/api/cursor-cli/{path}");
  const post = operation("post", "/api/cursor-cli/{path}");
  assert.deepEqual(
    Object.keys(get.responses).sort(),
    ["200", "401", "405", "502", "503", "default"].sort(),
  );
  assert.deepEqual(
    Object.keys(post.responses).sort(),
    ["200", "400", "401", "405", "502", "503", "default"].sort(),
  );
  assert.equal(get.responses["200"].content["*/*"].schema.$ref,
    "#/components/schemas/CursorCliPassthroughBody");
  assert.equal(get.responses["200"].headers?.["Cache-Control"], undefined);
  assert.equal(post.requestBody["x-sensitive"], true);
  assert.ok(post.responses["200"].content["application/json"].schema.anyOf.some(
    (schema: any) => schema.$ref === "#/components/schemas/CursorCliSessionTokenExchangeResponse",
  ));
  assert.equal(
    post.responses["200"].headers["Cache-Control"].schema.example,
    "no-store",
  );
  assert.equal(post.responses["200"].headers["Cache-Control"].schema.type, "string");
  assert.match(post.responses["200"].headers["Cache-Control"].description, /only.*exchange|exchange.*only/i);
  assert.match(post.responses["200"].headers["Cache-Control"].description, /preserve Cursor's.*cache headers/i);
});

test("public OpenAPI mirror remains byte-identical to the canonical document", () => {
  assert.equal(fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8"), canonicalText);
});
