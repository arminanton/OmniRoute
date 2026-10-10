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

test("the published OpenAPI document matches the canonical session lease contract", () => {
  assert.equal(publicText, canonicalText);
});
