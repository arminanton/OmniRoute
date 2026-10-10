import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

const root = process.cwd();
const canonicalText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(root, "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as any;
const operation = spec.paths["/api/v1/session-leases"]?.post;

test("session lease 429 documents both source-backed response shapes", () => {
  assert.ok(operation, "missing POST /api/v1/session-leases");

  const response = operation.responses?.["429"];
  assert.ok(response, "session lease acquisition can return HTTP 429");
  const bodySchema = response.content?.["application/json"]?.schema;
  assert.deepEqual(
    (bodySchema?.oneOf ?? []).map((schema: { $ref?: string }) => schema.$ref).sort(),
    [
      "#/components/schemas/ApiErrorResponse",
      "#/components/schemas/ExclusiveConnectionLeaseCapacity",
    ].sort()
  );
  assert.match(response.description, /WAITING_FOR_CAPACITY.*Retry-After/i);
  assert.match(response.description, /LEASE_ELIGIBILITY_UNAVAILABLE/i);
  assert.match(
    response.headers?.["Retry-After"]?.description,
    /only present for WAITING_FOR_CAPACITY/i
  );

  const capacity = spec.components.schemas.ExclusiveConnectionLeaseCapacity;
  assert.deepEqual(capacity.required, [
    "state",
    "error",
    "reason",
    "retryAfter",
    "eligibleCount",
    "freeCount",
  ]);
  assert.equal(capacity.properties.state.const, "WAITING_FOR_CAPACITY");
  assert.equal(capacity.properties.error.properties.code.const, "LEASE_CAPACITY_UNAVAILABLE");
});

test("session lease documents JSON error bodies, service unavailability, and validator bounds", () => {
  assert.ok(operation, "missing POST /api/v1/session-leases");
  for (const status of ["400", "401", "403", "409", "415", "503"]) {
    assert.equal(
      operation.responses?.[status]?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/ApiErrorResponse",
      `HTTP ${status} has the source JSON error envelope`
    );
  }

  const actions = operation.requestBody?.content?.["application/json"]?.schema?.oneOf ?? [];
  const acquire = actions.find((schema: any) => schema.properties?.action?.const === "acquire");
  assert.equal(acquire?.properties?.model?.pattern, "\\S");
  for (const actionName of ["status", "renew", "release"]) {
    const actionSchema = actions.find(
      (schema: any) => schema.properties?.action?.const === actionName
    );
    assert.equal(actionSchema?.properties?.generation?.maximum, Number.MAX_SAFE_INTEGER);
  }
});

test("the published OpenAPI document matches the canonical session lease contract", () => {
  assert.equal(publicText, canonicalText);
});
