import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  oneOf?: Schema[];
  anyOf?: Schema[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
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

const proxyOperations: Array<[string, string]> = [
  ["/api/v1/management/proxies", "get"],
  ["/api/v1/management/proxies", "post"],
  ["/api/v1/management/proxies", "patch"],
  ["/api/v1/management/proxies", "delete"],
  ["/api/v1/management/proxies/assignments", "get"],
  ["/api/v1/management/proxies/assignments", "put"],
  ["/api/v1/management/proxies/bulk-assign", "put"],
  ["/api/v1/management/proxies/health", "get"],
];

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

function assertConditionalManagementAuth(op: Operation): void {
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

test("V1 proxy-management route family has conditional management auth and typed successes", () => {
  for (const [pathTemplate, method] of proxyOperations) {
    const op = operation(pathTemplate, method);
    assertConditionalManagementAuth(op);
    for (const [status, response] of Object.entries(op.responses ?? {})) {
      if (!status.startsWith("2")) continue;
      assert.ok(
        response.content?.["application/json"]?.schema,
        `missing ${status} response schema on ${method.toUpperCase()} ${pathTemplate}`
      );
    }
  }
});

test("proxy registry lookup and mutations document their distinct request/result shapes", () => {
  const list = operation("/api/v1/management/proxies", "get");
  const listVariants = successSchema("/api/v1/management/proxies", "get").anyOf?.map(
    (schema) => schema.$ref
  );
  assert.deepEqual(listVariants, [
    "#/components/schemas/V1ManagementProxyListResponse",
    "#/components/schemas/ProxyRegistryRecord",
    "#/components/schemas/ProxyRegistryWhereUsedResponse",
  ]);
  assert.deepEqual(
    list.parameters
      ?.filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name),
    ["id", "where_used", "limit", "offset"]
  );
  assert.match(list.description ?? "", /username\/password redacted/i);

  const create = operation("/api/v1/management/proxies", "post");
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProxyRegistryCreateRequest"
  );
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProxyRegistryMutationResponse"
  );
  const update = operation("/api/v1/management/proxies", "patch");
  assert.equal(
    update.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProxyRegistryUpdateRequest"
  );
  assert.equal(
    successSchema("/api/v1/management/proxies", "patch").$ref,
    "#/components/schemas/ProxyRegistryMutationResponse"
  );

  const deletion = operation("/api/v1/management/proxies", "delete");
  assert.equal(deletion.parameters?.find((parameter) => parameter.name === "id")?.required, true);
  assert.deepEqual(
    deletion.parameters?.find((parameter) => parameter.name === "force")?.schema?.enum,
    ["1"]
  );
  assert.ok(deletion.responses?.["409"]);
  assert.equal(
    successSchema("/api/v1/management/proxies", "delete").$ref,
    "#/components/schemas/SuccessResponse"
  );
});

test("proxy assignment resolution, bulk updates, and health-window bounds match the handlers", () => {
  const getAssignments = operation("/api/v1/management/proxies/assignments", "get");
  assert.deepEqual(
    getAssignments.parameters
      ?.filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name),
    ["proxy_id", "scope", "scope_id", "resolve_connection_id", "limit", "offset"]
  );
  assert.deepEqual(
    successSchema("/api/v1/management/proxies/assignments", "get").anyOf?.map(
      (schema) => schema.$ref
    ),
    [
      "#/components/schemas/V1ManagementProxyAssignmentsListResponse",
      "#/components/schemas/ProxyResolutionResult",
    ]
  );

  const assign = operation("/api/v1/management/proxies/assignments", "put");
  assert.equal(
    assign.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProxyAssignmentRequest"
  );
  assert.match(assign.description ?? "", /scopeId.*required/);
  assert.equal(
    successSchema("/api/v1/management/proxies/assignments", "put").$ref,
    "#/components/schemas/ProxyAssignmentMutationResponse"
  );
  assert.ok(assign.responses?.["404"]);

  const bulk = operation("/api/v1/management/proxies/bulk-assign", "put");
  assert.equal(
    bulk.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProxyBulkAssignmentRequest"
  );
  assert.equal(
    successSchema("/api/v1/management/proxies/bulk-assign", "put").$ref,
    "#/components/schemas/ProxyBulkAssignmentResponse"
  );

  const health = operation("/api/v1/management/proxies/health", "get");
  const hours = health.parameters?.find((parameter) => parameter.name === "hours");
  assert.equal(hours?.schema?.default, 24);
  assert.equal(hours?.schema?.minimum, 1);
  assert.equal(hours?.schema?.maximum, 720);
  assert.equal(
    successSchema("/api/v1/management/proxies/health", "get").$ref,
    "#/components/schemas/ProxyHealthStatsResponse"
  );
});
