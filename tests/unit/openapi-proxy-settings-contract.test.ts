import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
  default?: unknown;
  minItems?: number;
  maxItems?: number;
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
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, Response>;
};

const specText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const spec = yaml.load(specText) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function operation(pathTemplate: string, method: string): Operation {
  const result = spec.paths[pathTemplate]?.[method];
  assert.ok(result, `missing OpenAPI operation ${method.toUpperCase()} ${pathTemplate}`);
  return result;
}

function successSchema(pathTemplate: string, method: string, status = "200"): Schema {
  const result = operation(pathTemplate, method).responses?.[status]?.content?.["application/json"]
    ?.schema;
  assert.ok(result, `missing JSON schema for ${method.toUpperCase()} ${pathTemplate} ${status}`);
  return result;
}

function assertManagementAuth(op: Operation) {
  const alternatives = op.security ?? [];
  assert.equal(
    alternatives.some((entry) => Object.hasOwn(entry, "BearerAuth")),
    true
  );
  assert.equal(
    alternatives.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")),
    true
  );
  // Management auth is optional only in standalone mode; deployments with it enabled reject
  // missing/invalid credentials and can return an unavailable response when auth state is down.
  assert.equal(
    alternatives.some((entry) => Object.keys(entry).length === 0),
    true
  );
  assert.equal(
    op.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
}

const proxyOperations: Array<[string, string]> = [
  ["/api/settings/proxies", "get"],
  ["/api/settings/proxies", "post"],
  ["/api/settings/proxies", "patch"],
  ["/api/settings/proxies", "delete"],
  ["/api/settings/proxies/{id}/repair-relay", "post"],
  ["/api/settings/proxies/assignments", "get"],
  ["/api/settings/proxies/assignments", "put"],
  ["/api/settings/proxies/auto-test", "post"],
  ["/api/settings/proxies/batch-activate", "post"],
  ["/api/settings/proxies/batch-delete", "post"],
  ["/api/settings/proxies/bulk-assign", "put"],
  ["/api/settings/proxies/bulk-import", "post"],
  ["/api/settings/proxies/egress", "get"],
  ["/api/settings/proxies/egress", "post"],
  ["/api/settings/proxies/health", "get"],
  ["/api/settings/proxies/migrate", "post"],
  ["/api/settings/proxies/pool", "get"],
  ["/api/settings/proxies/pool", "put"],
  ["/api/settings/proxies/pool", "delete"],
  ["/api/settings/proxies/pool", "patch"],
];

const freeProxyOperations: Array<[string, string]> = [
  ["/api/settings/free-proxies", "get"],
  ["/api/settings/free-proxies", "delete"],
  ["/api/settings/free-proxies/{id}/add-to-pool", "post"],
  ["/api/settings/free-proxies/bulk-add-to-pool", "post"],
  ["/api/settings/free-proxies/stats", "get"],
  ["/api/settings/free-proxies/sync", "post"],
];

test("registry proxy settings document all success payloads and management auth variants", () => {
  for (const [pathTemplate, method] of proxyOperations) {
    const op = operation(pathTemplate, method);
    assertManagementAuth(op);
    const successResponses = Object.entries(op.responses ?? {}).filter(([status]) =>
      status.startsWith("2")
    );
    assert.ok(successResponses.length > 0, `missing success response: ${method} ${pathTemplate}`);
    for (const [status, response] of successResponses) {
      assert.ok(
        response.content?.["application/json"]?.schema,
        `empty ${status} ${method.toUpperCase()} ${pathTemplate}`
      );
    }
  }
});

test("proxy registry input, secret-bearing records, and lookup variants match their handlers", () => {
  const list = operation("/api/settings/proxies", "get");
  const listSchema = successSchema("/api/settings/proxies", "get");
  assert.equal(listSchema.$ref, "#/components/schemas/ProxyRegistryGetResponse");
  assert.deepEqual(
    spec.components.schemas.ProxyRegistryGetResponse.oneOf?.map((variant) => variant.$ref),
    [
      "#/components/schemas/ProxyRegistryListResponse",
      "#/components/schemas/ProxyRegistryRecord",
      "#/components/schemas/ProxyRegistryWhereUsedResponse",
    ]
  );
  assert.match(list.description ?? "", /username\/password.*redacted/i);
  assert.match(list.description ?? "", /lookup currently returns stored username/i);
  assert.deepEqual(
    list.parameters
      ?.filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name),
    ["id", "whereUsed"]
  );
  assert.ok(list.responses?.["404"]);
  const username = spec.components.schemas.ProxyRegistryRecord.properties?.username;
  const password = spec.components.schemas.ProxyRegistryRecord.properties?.password;
  assert.match(username?.description ?? "", /stored proxy username/i);
  assert.match(password?.description ?? "", /stored proxy password/i);

  const create = operation("/api/settings/proxies", "post");
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProxyRegistryMutationResponse"
  );
  assert.equal(create.responses?.["200"], undefined);
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProxyRegistryCreateRequest"
  );
  assert.equal(
    spec.components.schemas.ProxyRegistryCreateRequest.properties?.password?.writeOnly,
    true
  );
  assert.deepEqual(spec.components.schemas.ProxyRegistryCreateRequest.properties?.type?.enum, [
    "http",
    "https",
    "socks5",
    "vercel",
    "deno",
    "cloudflare",
  ]);
  assert.deepEqual(
    spec.components.schemas.ProxyRegistryCreateRequest.properties?.port?.oneOf?.map(
      (variant) => variant.type
    ),
    ["integer", "string"]
  );
  assert.deepEqual(
    spec.components.schemas.ProxyRegistryFields.properties?.port?.oneOf?.map(
      (variant) => variant.type
    ),
    ["integer", "string"]
  );
  assert.ok(create.responses?.["400"]);
  assert.ok(create.responses?.["403"]);
  assert.ok(create.responses?.["500"]);

  const deletion = operation("/api/settings/proxies", "delete");
  assert.equal(deletion.parameters?.find((parameter) => parameter.name === "id")?.required, true);
  assert.deepEqual(
    deletion.parameters?.find((parameter) => parameter.name === "force")?.schema?.enum,
    ["1"]
  );
  assert.ok(deletion.responses?.["409"]);
  assert.ok(deletion.responses?.["400"]);
  assert.ok(deletion.responses?.["404"]);
  assert.equal(
    successSchema("/api/settings/proxies", "delete").$ref,
    "#/components/schemas/SuccessResponse"
  );
});

test("proxy probes, batch limits, migration, and pool strategies are typed", () => {
  const autoTest = operation("/api/settings/proxies/auto-test", "post");
  assert.equal(autoTest.requestBody?.required, false);
  assert.equal(
    successSchema("/api/settings/proxies/auto-test", "post").$ref,
    "#/components/schemas/ProxyAutoTestResponse"
  );

  assert.equal(spec.components.schemas.ProxyBatchActivateRequest.properties?.ids?.maxItems, 500);
  assert.equal(spec.components.schemas.ProxyBatchDeleteRequest.properties?.ids?.maxItems, 100);
  assert.equal(
    operation("/api/settings/proxies/batch-activate", "post").requestBody?.content?.[
      "application/json"
    ]?.schema?.$ref,
    "#/components/schemas/ProxyBatchActivateRequest"
  );
  assert.equal(
    successSchema("/api/settings/proxies/bulk-import", "post").$ref,
    "#/components/schemas/ProxyBulkImportResponse"
  );
  assert.equal(spec.components.schemas.ProxyBulkImportRequest.properties?.items?.maxItems, 100);

  const poolGet = operation("/api/settings/proxies/pool", "get");
  assert.equal(poolGet.parameters?.find((parameter) => parameter.name === "scope")?.required, true);
  assert.equal(
    successSchema("/api/settings/proxies/pool", "patch").$ref,
    "#/components/schemas/ProxyPoolStrategyResponse"
  );
  assert.deepEqual(spec.components.schemas.ProxyPoolStrategyRequest.properties?.strategy?.enum, [
    "round-robin",
    "random",
    "sticky",
    "latency",
  ]);
  assert.ok(operation("/api/settings/proxies/pool", "get").responses?.["400"]);
  assert.ok(operation("/api/settings/proxies/migrate", "post").responses?.["403"]);
  assert.deepEqual(operation("/api/settings/proxies/health", "get").parameters?.[0]?.name, "hours");
  assert.ok(operation("/api/settings/proxies/health", "get").responses?.["500"]);
});

test("free-proxy discovery and promotion contracts match the route handlers", () => {
  for (const [pathTemplate, method] of freeProxyOperations) {
    assertManagementAuth(operation(pathTemplate, method));
  }

  assert.equal(
    successSchema("/api/settings/free-proxies", "get").$ref,
    "#/components/schemas/FreeProxyListResponse"
  );
  const deletion = successSchema("/api/settings/free-proxies", "delete");
  assert.deepEqual(
    deletion.oneOf?.map((variant) => variant.$ref),
    [
      "#/components/schemas/FreeProxyDeleteResponse",
      "#/components/schemas/FreeProxySourceClearResponse",
    ]
  );

  const add = operation("/api/settings/free-proxies/{id}/add-to-pool", "post");
  assert.equal(
    successSchema("/api/settings/free-proxies/{id}/add-to-pool", "post").$ref,
    "#/components/schemas/FreeProxyAddToPoolResponse"
  );
  assert.equal(
    add.responses?.["422"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/FreeProxyProbeFailureResponse"
  );

  const bulkAdd = operation("/api/settings/free-proxies/bulk-add-to-pool", "post");
  assert.equal(
    bulkAdd.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/FreeProxyBulkAddRequest"
  );
  assert.equal(spec.components.schemas.FreeProxyBulkAddRequest.properties?.ids?.minItems, 1);
  assert.equal(spec.components.schemas.FreeProxyBulkAddRequest.properties?.ids?.maxItems, 100);
  assert.equal(
    successSchema("/api/settings/free-proxies/bulk-add-to-pool", "post").$ref,
    "#/components/schemas/FreeProxyBulkAddResponse"
  );

  assert.equal(
    successSchema("/api/settings/free-proxies/stats", "get").$ref,
    "#/components/schemas/FreeProxyStatsResponse"
  );
  const sync = operation("/api/settings/free-proxies/sync", "post");
  assert.equal(sync.requestBody?.required, false);
  assert.equal(
    sync.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/FreeProxySyncRequest"
  );
  assert.equal(
    successSchema("/api/settings/free-proxies/sync", "post").$ref,
    "#/components/schemas/FreeProxySyncResponse"
  );

  const repair = operation("/api/settings/proxies/{id}/repair-relay", "post");
  assertManagementAuth(repair);
  assert.equal(
    successSchema("/api/settings/proxies/{id}/repair-relay", "post").$ref,
    "#/components/schemas/ProxyRelayRepairResponse"
  );
  assert.ok(repair.responses?.["409"]);
});
