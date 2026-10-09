import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  "x-sensitive"?: boolean;
};

type Operation = {
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ name: string; in: string; schema?: Schema }>;
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
  assert.ok(schema, `missing 200 response schema for ${method.toUpperCase()} ${pathTemplate}`);
  return schema;
}

function assertAuth(op: Operation): void {
  const security = op.security ?? [];
  assert.ok(security.some((entry) => Object.hasOwn(entry, "BearerAuth")));
  assert.ok(security.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
  assert.ok(security.some((entry) => Object.keys(entry).length === 0));
  assert.ok(op.responses?.["401"]);
}

const keyOperations: Array<[string, string]> = [
  ["/api/v1/registered-keys", "get"],
  ["/api/v1/registered-keys", "post"],
  ["/api/v1/registered-keys/{id}", "get"],
  ["/api/v1/registered-keys/{id}", "delete"],
  ["/api/v1/registered-keys/{id}/revoke", "post"],
];

test("registered-key routes expose authenticated, typed operations", () => {
  for (const [pathTemplate, method] of keyOperations) {
    const op = operation(pathTemplate, method);
    assertAuth(op);
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      if (!status.startsWith("2")) continue;
      assert.ok(
        response.content?.["application/json"]?.schema,
        `missing success schema on ${method.toUpperCase()} ${pathTemplate}`
      );
    }
  }
  assert.deepEqual(
    operation("/api/v1/registered-keys", "get").parameters?.map((parameter) => parameter.name),
    ["provider", "accountId"]
  );
});

test("key issue contract validates quotas/idempotency and marks the one-time secret", () => {
  const create = operation("/api/v1/registered-keys", "post");
  const request = spec.components.schemas.V1RegisteredKeyIssueRequest;
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/V1RegisteredKeyIssueRequest"
  );
  assert.deepEqual(request.required, ["name"]);
  assert.equal(request.properties?.name.minLength, 1);
  assert.equal(request.properties?.name.maxLength, 120);
  assert.equal(request.properties?.idempotencyKey.maxLength, 256);
  assert.equal(request.properties?.dailyBudget.minimum, 1);
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/V1RegisteredKeyIssueResponse"
  );
  const issue = spec.components.schemas.V1RegisteredKeyIssueResponse;
  assert.equal(issue.properties?.key["x-sensitive"], true);
  assert.equal(
    issue.properties?.warning.const,
    "Store this key securely — it will not be shown again."
  );
  assert.ok(create.responses?.["409"]);
  assert.ok(create.responses?.["429"]);
  assert.equal(
    create.responses?.["409"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/V1RegisteredKeyIssueConflictResponse"
  );
  assert.equal(
    create.responses?.["429"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/V1RegisteredKeyQuotaErrorResponse"
  );
});

test("key detail and both revoke methods return only metadata", () => {
  assert.equal(
    successSchema("/api/v1/registered-keys", "get").$ref,
    "#/components/schemas/V1RegisteredKeyListResponse"
  );
  assert.ok(operation("/api/v1/registered-keys", "get").responses?.["500"]);
  assert.equal(
    successSchema("/api/v1/registered-keys/{id}", "get").$ref,
    "#/components/schemas/V1RegisteredKeyResponse"
  );
  const metadata = spec.components.schemas.V1RegisteredKey;
  assert.equal(metadata.properties?.key, undefined);
  assert.ok(metadata.properties?.keyPrefix);
  assert.equal(
    successSchema("/api/v1/registered-keys/{id}", "delete").$ref,
    "#/components/schemas/V1RegisteredKeyRevokeResponse"
  );
  assert.equal(
    successSchema("/api/v1/registered-keys/{id}/revoke", "post").$ref,
    "#/components/schemas/V1RegisteredKeyRevokeResponse"
  );
  assert.ok(operation("/api/v1/registered-keys/{id}", "get").responses?.["404"]);
  assert.ok(operation("/api/v1/registered-keys/{id}", "delete").responses?.["404"]);
});
