import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  minItems?: number;
  oneOf?: Schema[];
};

type Response = {
  $ref?: string;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Schema;
  }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, Response>;
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

function successSchema(pathTemplate: string, method: string, status = "200"): Schema {
  const schema = operation(pathTemplate, method).responses?.[status]?.content?.["application/json"]
    ?.schema;
  assert.ok(
    schema,
    `missing ${status} response schema for ${method.toUpperCase()} ${pathTemplate}`
  );
  return schema;
}

function assertManagementAuth(op: Operation): void {
  const security = op.security ?? [];
  assert.ok(security.some((entry) => Object.hasOwn(entry, "BearerAuth")));
  assert.ok(security.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
  assert.ok(security.some((entry) => Object.keys(entry).length === 0));
  assert.equal(
    op.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
}

const quotaOperations: Array<[string, string]> = [
  ["/api/quota/pools", "get"],
  ["/api/quota/pools", "post"],
  ["/api/quota/pools/{id}", "get"],
  ["/api/quota/pools/{id}", "patch"],
  ["/api/quota/pools/{id}", "delete"],
  ["/api/quota/pools/{id}/usage", "get"],
  ["/api/quota/pools/{id}/log", "get"],
  ["/api/quota/plans", "get"],
  ["/api/quota/plans/{connectionId}", "get"],
  ["/api/quota/plans/{connectionId}", "put"],
  ["/api/quota/plans/{connectionId}", "delete"],
  ["/api/quota/preview", "get"],
  ["/api/quota/groups", "get"],
  ["/api/quota/groups", "post"],
  ["/api/quota/groups/{id}", "patch"],
  ["/api/quota/groups/{id}", "delete"],
  ["/api/quota/keys/{id}/models", "get"],
];

test("quota-sharing routes document conditional management auth and successful responses", () => {
  for (const [pathTemplate, method] of quotaOperations) {
    const op = operation(pathTemplate, method);
    assertManagementAuth(op);
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      if (!status.startsWith("2") || status === "204") continue;
      assert.ok(
        Object.values(response.content ?? {}).some((entry) => entry.schema),
        `missing success response schema for ${method.toUpperCase()} ${pathTemplate} ${status}`
      );
    }
  }
});

test("pool CRUD bodies, envelopes, allocations, and usage snapshot reflect current structures", () => {
  const poolList = successSchema("/api/quota/pools", "get");
  assert.equal(poolList.$ref, "#/components/schemas/QuotaPoolListResponse");
  const create = operation("/api/quota/pools", "post");
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PoolCreate"
  );
  assert.equal(create.parameters?.find((p) => p.name === "ensure")?.schema?.enum?.[0], "true");
  assert.equal(
    create.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/QuotaPoolEnvelope"
  );
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/QuotaPoolEnvelope"
  );
  assert.deepEqual(
    spec.components.schemas.PoolCreate.properties?.connectionIds?.items?.type,
    "string"
  );
  assert.ok(spec.components.schemas.PoolCreate.properties?.groupId);
  assert.ok(spec.components.schemas.PoolUpdate.properties?.exclusive);
  assert.equal(spec.components.schemas.QuotaDimension.properties?.limit.exclusiveMinimum, 0);

  assert.equal(
    successSchema("/api/quota/pools/{id}", "get").$ref,
    "#/components/schemas/QuotaPoolEnvelope"
  );
  assert.equal(
    successSchema("/api/quota/pools/{id}", "patch").$ref,
    "#/components/schemas/QuotaPoolEnvelope"
  );
  assert.equal(operation("/api/quota/pools/{id}", "delete").responses?.["204"] !== undefined, true);
  assert.equal(
    successSchema("/api/quota/pools/{id}/usage", "get").$ref,
    "#/components/schemas/QuotaPoolUsageResponse"
  );
  assert.equal(
    successSchema("/api/quota/pools/{id}/log", "get").$ref,
    "#/components/schemas/QuotaPoolLogResponse"
  );
  assert.equal(spec.components.schemas.PoolUsageSnapshot.properties?.burnRate.type, "object");
});

test("groups, plans, preview decisions, and key-visible models are typed", () => {
  const groupCreate = operation("/api/quota/groups", "post");
  assert.equal(
    groupCreate.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/QuotaGroupCreateRequest"
  );
  assert.equal(
    groupCreate.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/QuotaGroupEnvelope"
  );
  assert.equal(
    successSchema("/api/quota/groups", "get").$ref,
    "#/components/schemas/QuotaGroupListResponse"
  );
  assert.ok(operation("/api/quota/groups/{id}", "delete").responses?.["409"]);
  assert.equal(
    operation("/api/quota/groups/{id}", "delete").responses?.["204"] !== undefined,
    true
  );

  assert.equal(
    successSchema("/api/quota/plans", "get").$ref,
    "#/components/schemas/ProviderPlanListResponse"
  );
  const putPlan = operation("/api/quota/plans/{connectionId}", "put");
  assert.equal(
    putPlan.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/PlanUpsert"
  );
  assert.deepEqual(spec.components.schemas.PlanUpsert.properties?.dimensions?.minItems, 1);
  assert.equal(
    successSchema("/api/quota/plans/{connectionId}", "get").$ref,
    "#/components/schemas/ProviderPlanEnvelope"
  );
  assert.equal(
    operation("/api/quota/plans/{connectionId}", "delete").responses?.["204"] !== undefined,
    true
  );

  const preview = operation("/api/quota/preview", "get");
  assert.deepEqual(
    preview.parameters?.filter((p) => p.required).map((p) => p.name),
    ["apiKeyId", "poolId"]
  );
  assert.equal(
    successSchema("/api/quota/preview", "get").$ref,
    "#/components/schemas/QuotaPreviewResponse"
  );
  assert.equal(
    successSchema("/api/quota/keys/{id}/models", "get").properties?.models?.type,
    "array"
  );
});
