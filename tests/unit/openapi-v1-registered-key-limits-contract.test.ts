import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  minimum?: number;
};

type Operation = {
  security?: Array<Record<string, unknown>>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function operation(pathTemplate: string, method: string): Operation {
  const result = spec.paths[pathTemplate]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathTemplate}`);
  return result;
}

function successSchema(pathTemplate: string, method: string): Schema {
  const schema = operation(pathTemplate, method).responses?.["200"]?.content?.["application/json"]
    ?.schema;
  assert.ok(schema, `missing 200 JSON schema for ${method.toUpperCase()} ${pathTemplate}`);
  return schema;
}

test("registered-key account/provider limit routes document authenticated access modes", () => {
  const paths = ["/api/v1/accounts/{id}/limits", "/api/v1/providers/{provider}/limits"];
  for (const pathTemplate of paths) {
    for (const method of ["get", "put"]) {
      const op = operation(pathTemplate, method);
      const security = op.security ?? [];
      assert.ok(security.some((entry) => Object.hasOwn(entry, "BearerAuth")));
      assert.ok(security.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
      assert.ok(security.some((entry) => Object.keys(entry).length === 0));
      assert.ok(op.responses?.["401"]);
    }
  }
});

test("limit updates match positive nullable Zod fields and return current issuance counters", () => {
  const update = spec.components.schemas.V1RegisteredKeyLimitsUpdate;
  assert.deepEqual(Object.keys(update.properties ?? {}), [
    "maxActiveKeys",
    "dailyIssueLimit",
    "hourlyIssueLimit",
  ]);
  for (const property of Object.values(update.properties ?? {})) {
    assert.deepEqual(property.type, ["integer", "null"]);
    assert.equal(property.minimum, 1);
  }
  assert.deepEqual(spec.components.schemas.V1AccountKeyLimits.required, [
    "accountId",
    "maxActiveKeys",
    "dailyIssueLimit",
    "hourlyIssueLimit",
    "dailyIssued",
    "hourlyIssued",
    "updatedAt",
  ]);
  assert.deepEqual(spec.components.schemas.V1ProviderKeyLimits.required, [
    "provider",
    "maxActiveKeys",
    "dailyIssueLimit",
    "hourlyIssueLimit",
    "dailyIssued",
    "hourlyIssued",
    "updatedAt",
  ]);
  assert.equal(
    successSchema("/api/v1/accounts/{id}/limits", "get").$ref,
    "#/components/schemas/V1AccountKeyLimitsResponse"
  );
  assert.equal(
    successSchema("/api/v1/providers/{provider}/limits", "get").$ref,
    "#/components/schemas/V1ProviderKeyLimitsResponse"
  );
  for (const [pathTemplate, expected] of [
    ["/api/v1/accounts/{id}/limits", "V1AccountKeyLimitsResponse"],
    ["/api/v1/providers/{provider}/limits", "V1ProviderKeyLimitsResponse"],
  ]) {
    const put = operation(pathTemplate, "put");
    assert.equal(
      put.requestBody?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/V1RegisteredKeyLimitsUpdate"
    );
    assert.equal(
      put.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${expected}`
    );
    assert.ok(put.responses?.["400"]);
  }
});
