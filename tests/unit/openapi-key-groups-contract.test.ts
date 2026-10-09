import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  default?: unknown;
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
  minProperties?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
};

type Response = {
  $ref?: string;
  description?: string;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    $ref?: string;
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

function op(pathTemplate: string, method: string): Operation {
  const operation = spec.paths[pathTemplate]?.[method];
  assert.ok(operation, `missing OpenAPI operation ${method.toUpperCase()} ${pathTemplate}`);
  return operation;
}

function responseSchema(pathTemplate: string, method: string, status = "200"): Schema {
  const schema = op(pathTemplate, method).responses?.[status]?.content?.["application/json"]
    ?.schema;
  assert.ok(schema, `missing JSON schema for ${method.toUpperCase()} ${pathTemplate} ${status}`);
  return schema;
}

function assertManagementAuth(operation: Operation) {
  const alternatives = operation.security ?? [];
  assert.equal(
    alternatives.some((entry) => Object.hasOwn(entry, "BearerAuth")),
    true
  );
  assert.equal(
    alternatives.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")),
    true
  );
  assert.equal(
    alternatives.some((entry) => Object.keys(entry).length === 0),
    true
  );
  assert.equal(
    operation.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(operation.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
  assert.equal(
    operation.responses?.["503"]?.$ref,
    "#/components/responses/ManagementAuthUnavailable"
  );
}

test("API-key group collection and item CRUD match source payloads and status codes", () => {
  const collection = spec.paths["/api/keys/groups"];
  assert.equal(
    responseSchema("/api/keys/groups", "get").$ref,
    "#/components/schemas/ApiKeyGroupListResponse"
  );
  assert.equal(
    spec.components.schemas.ApiKeyGroupListResponse.properties?.groups?.items?.$ref,
    "#/components/schemas/ApiKeyGroup"
  );

  const create = collection.post;
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiKeyGroupCreate"
  );
  assert.deepEqual(spec.components.schemas.ApiKeyGroupCreate.required, ["name"]);
  assert.equal(spec.components.schemas.ApiKeyGroupCreate.properties?.description?.default, "");
  assert.equal(spec.components.schemas.ApiKeyGroup.properties?.createdAt?.format, undefined);
  assert.equal(spec.components.schemas.ApiKeyGroup.properties?.updatedAt?.format, undefined);
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiKeyGroupEnvelope"
  );
  assert.equal(create.responses?.["200"], undefined);
  assert.equal(
    create.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assertManagementAuth(collection.get);
  assertManagementAuth(create);

  const item = spec.paths["/api/keys/groups/{id}"];
  assert.equal(item.parameters?.[0]?.$ref, "#/components/parameters/ResourceId");
  assert.equal(
    responseSchema("/api/keys/groups/{id}", "get").$ref,
    "#/components/schemas/ApiKeyGroupDetailsResponse"
  );
  const detailGroup = spec.components.schemas.ApiKeyGroupDetailsResponse.properties?.group;
  assert.equal(detailGroup?.$ref, "#/components/schemas/ApiKeyGroupWithPermissions");
  assert.equal(
    spec.components.schemas.ApiKeyGroupWithPermissions.properties?.memberCount?.type,
    "integer"
  );
  assert.equal(
    spec.components.schemas.ApiKeyGroupWithPermissions.properties?.createdAt?.format,
    undefined
  );
  assert.equal(
    spec.components.schemas.ApiKeyGroupWithPermissions.properties?.updatedAt?.format,
    undefined
  );

  assert.equal(
    item.put.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiKeyGroupUpdate"
  );
  assert.equal(spec.components.schemas.ApiKeyGroupUpdate.minProperties, 1);
  assert.equal(
    responseSchema("/api/keys/groups/{id}", "put").$ref,
    "#/components/schemas/ApiKeyGroupEnvelope"
  );
  assert.equal(
    responseSchema("/api/keys/groups/{id}", "delete").$ref,
    "#/components/schemas/SuccessResponse"
  );
  assert.equal(item.put.responses?.["500"]?.description?.includes("Malformed JSON") ?? false, true);
  for (const method of ["get", "put", "delete"]) assertManagementAuth(item[method]);
});

test("nested API-key group member and permission routes document queries, creation, and envelopes", () => {
  const members = spec.paths["/api/keys/groups/{id}/keys"];
  assert.equal(
    responseSchema("/api/keys/groups/{id}/keys", "get").$ref,
    "#/components/schemas/ApiKeyGroupMembersResponse"
  );
  assert.equal(
    members.post.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiKeyGroupMemberCreate"
  );
  assert.equal(
    members.post.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/SuccessResponse"
  );
  assert.equal(members.post.responses?.["200"], undefined);
  assert.equal(
    members.delete.parameters?.find((parameter) => parameter.name === "keyId")?.required,
    true
  );
  assert.equal(
    responseSchema("/api/keys/groups/{id}/keys", "delete").$ref,
    "#/components/schemas/SuccessResponse"
  );
  assert.equal(
    members.post.responses?.["500"]?.description?.includes("Malformed JSON") ?? false,
    true
  );

  const permissions = spec.paths["/api/keys/groups/{id}/permissions"];
  assert.equal(
    responseSchema("/api/keys/groups/{id}/permissions", "get").$ref,
    "#/components/schemas/ApiKeyGroupPermissionsResponse"
  );
  assert.equal(
    permissions.post.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiKeyGroupPermissionCreate"
  );
  assert.deepEqual(
    spec.components.schemas.ApiKeyGroupPermissionCreate.properties?.accessType?.enum,
    ["allow", "deny"]
  );
  assert.equal(
    spec.components.schemas.ApiKeyGroupPermission.properties?.createdAt?.format,
    undefined
  );
  assert.equal(spec.components.schemas.ApiKeyGroupMember.properties?.createdAt?.format, undefined);
  assert.equal(
    permissions.post.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiKeyGroupPermissionEnvelope"
  );
  assert.equal(permissions.post.responses?.["200"], undefined);
  assert.equal(
    permissions.delete.parameters?.find((parameter) => parameter.name === "permissionId")?.required,
    true
  );
  assert.match(permissions.delete.description ?? "", /does not verify it belongs to `\{id\}`/);
  assert.equal(
    responseSchema("/api/keys/groups/{id}/permissions", "delete").$ref,
    "#/components/schemas/SuccessResponse"
  );
  assert.deepEqual(spec.components.schemas.ApiKeyGroupPermission.properties?.provider?.type, [
    "string",
    "null",
  ]);
  assert.equal(
    permissions.post.responses?.["500"]?.description?.includes("Malformed JSON") ?? false,
    true
  );

  for (const route of [members, permissions]) {
    for (const method of Object.keys(route).filter((key) =>
      ["get", "post", "delete"].includes(key)
    )) {
      assertManagementAuth(route[method]);
    }
  }
});

test("all group routes have typed successful bodies and error contracts", () => {
  const selected: Array<[string, string]> = [
    ["/api/keys/groups", "get"],
    ["/api/keys/groups", "post"],
    ["/api/keys/groups/{id}", "get"],
    ["/api/keys/groups/{id}", "put"],
    ["/api/keys/groups/{id}", "delete"],
    ["/api/keys/groups/{id}/keys", "get"],
    ["/api/keys/groups/{id}/keys", "post"],
    ["/api/keys/groups/{id}/keys", "delete"],
    ["/api/keys/groups/{id}/permissions", "get"],
    ["/api/keys/groups/{id}/permissions", "post"],
    ["/api/keys/groups/{id}/permissions", "delete"],
  ];
  for (const [pathTemplate, method] of selected) {
    const success = Object.entries(op(pathTemplate, method).responses ?? {}).filter(([status]) =>
      status.startsWith("2")
    );
    assert.ok(success.length > 0);
    for (const [status, response] of success) {
      assert.ok(
        response.content?.["application/json"]?.schema,
        `empty ${status} ${method} ${pathTemplate}`
      );
    }
  }
});
