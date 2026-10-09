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
  oneOf?: Schema[];
  anyOf?: Schema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
};

type Response = { content?: Record<string, { schema?: Schema }> };

type Operation = {
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema }>;
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

const operations: Array<[string, string]> = [
  ["/api/combos", "get"],
  ["/api/combos", "post"],
  ["/api/combos/{id}", "get"],
  ["/api/combos/{id}", "put"],
  ["/api/combos/{id}", "patch"],
  ["/api/combos/{id}", "delete"],
  ["/api/combos/metrics", "get"],
  ["/api/combos/metrics", "delete"],
  ["/api/combos/test", "post"],
  ["/api/combos/auto", "get"],
  ["/api/combos/builder/options", "get"],
  ["/api/combos/duplicate", "post"],
  ["/api/combos/reorder", "post"],
];

test("combo routing CRUD, tests, metrics, and builder endpoints use conditional management auth", () => {
  for (const [pathTemplate, method] of operations) {
    const op = operation(pathTemplate, method);
    assertManagementAuth(op);
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      if (!status.startsWith("2")) continue;
      assert.ok(
        Object.values(response.content ?? {}).some((entry) => entry.schema),
        `missing ${status} success schema for ${method.toUpperCase()} ${pathTemplate}`
      );
    }
  }
});

test("combo CRUD contracts match normalized models, current strategies, and partial-update rules", () => {
  const create = operation("/api/combos", "post");
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ComboCreate"
  );
  assert.equal(
    successSchema("/api/combos", "post", "201").$ref,
    "#/components/schemas/ComboRecord"
  );
  const strategies = spec.components.schemas.ComboCreate.properties?.strategy?.enum ?? [];
  for (const strategy of ["pipeline", "cache-optimized", "quota-weighted"]) {
    assert.ok(strategies.includes(strategy), `missing current strategy ${strategy}`);
  }
  assert.equal(spec.components.schemas.ComboModelEntry.oneOf?.length, 3);
  assert.equal(
    spec.components.schemas.ComboRecord.properties?.warning?.properties?.code?.const,
    "COMBO_NAME_SHADOWS_MODEL"
  );

  const update = operation("/api/combos/{id}", "put");
  assert.equal(
    update.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ComboUpdate"
  );
  assert.ok(spec.components.schemas.ComboUpdate.anyOf?.length);
  assert.ok(update.responses?.["409"]);
  assert.ok(operation("/api/combos/{id}", "patch").responses?.["409"]);
  assert.equal(
    successSchema("/api/combos/{id}", "delete").$ref,
    "#/components/schemas/SuccessResponse"
  );
});

test("combo test, metrics, auto candidates, builder, duplicate, and reorder payloads are typed", () => {
  const comboTest = operation("/api/combos/test", "post");
  assert.equal(
    comboTest.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ComboTestRequest"
  );
  assert.equal(
    successSchema("/api/combos/test", "post").$ref,
    "#/components/schemas/ComboTestResponse"
  );

  const metrics = operation("/api/combos/metrics", "get");
  assert.equal(
    metrics.parameters?.find((parameter) => parameter.name === "combo")?.required,
    false
  );
  assert.equal(
    successSchema("/api/combos/metrics", "get").$ref,
    "#/components/schemas/ComboMetricsResponse"
  );
  assert.equal(spec.components.schemas.ComboMetricsResponse.properties?.metrics.anyOf?.length, 3);
  assert.equal(
    successSchema("/api/combos/metrics", "delete").$ref,
    "#/components/schemas/ComboMetricsResetResponse"
  );

  assert.equal(
    successSchema("/api/combos/auto", "get").$ref,
    "#/components/schemas/ComboAutoResponse"
  );
  assert.equal(
    spec.components.schemas.ComboAutoResponse.properties?.combos?.items?.properties?.candidatePool
      ?.items?.type,
    "string"
  );
  assert.equal(
    successSchema("/api/combos/builder/options", "get").$ref,
    "#/components/schemas/ComboBuilderOptions"
  );

  const duplicate = operation("/api/combos/duplicate", "post");
  assert.equal(
    duplicate.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ComboDuplicateRequest"
  );
  assert.equal(
    duplicate.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ComboRecord"
  );
  assert.ok(duplicate.responses?.["422"]);

  const reorder = operation("/api/combos/reorder", "post");
  assert.equal(
    reorder.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ComboReorderRequest"
  );
  assert.equal(
    successSchema("/api/combos/reorder", "post").$ref,
    "#/components/schemas/ComboReorderResponse"
  );
  assert.equal(spec.components.schemas.ComboReorderRequest.properties?.comboIds?.maxItems, 1000);
});
