import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  readOnly?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
  maxItems?: number;
  required?: string[];
  oneOf?: Schema[];
};

type Response = {
  $ref?: string;
  description?: string;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  security?: Array<Record<string, unknown>>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, Response>;
};

const docsSpecText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const spec = yaml.load(docsSpecText) as {
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
  // `requireManagementAuth` permits anonymous calls only when the local
  // standalone policy has management login disabled.
  assert.equal(
    alternatives.some((entry) => Object.keys(entry).length === 0),
    true
  );
  assert.equal(
    operation.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  const forbidden = operation.responses?.["403"];
  assert.ok(forbidden);
  assert.equal(
    forbidden.$ref === "#/components/responses/ManagementInvalidToken" ||
      forbidden.content?.["application/json"]?.schema?.oneOf?.some(
        (variant) => variant.$ref === "#/components/schemas/ApiErrorResponse"
      ),
    true,
    "403 must document the management-auth error, optionally alongside a route-specific denial"
  );
  assert.equal(
    operation.responses?.["503"]?.$ref,
    "#/components/responses/ManagementAuthUnavailable"
  );
}

test("provider batch mutations document partial results, limits, and management auth", () => {
  const patch = op("/api/providers", "patch");
  const patchBody = patch.requestBody?.content?.["application/json"]?.schema;
  assert.ok(patchBody);
  assert.deepEqual(patchBody.required, ["ids", "isActive"]);
  assert.equal(patchBody.properties?.ids?.maxItems, 100);
  assert.equal(
    responseSchema("/api/providers", "patch").$ref,
    "#/components/schemas/ProviderConnectionsBatchUpdateResponse"
  );
  assert.equal(
    responseSchema("/api/providers", "patch", "410").$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  assertManagementAuth(patch);

  const deletion = op("/api/providers", "delete");
  const deleteBody = deletion.requestBody?.content?.["application/json"]?.schema;
  assert.ok(deleteBody);
  assert.deepEqual(deleteBody.required, ["ids"]);
  assert.equal(deleteBody.properties?.ids?.maxItems, 100);
  assert.equal(
    responseSchema("/api/providers", "delete").$ref,
    "#/components/schemas/ProviderConnectionsBatchDeleteResponse"
  );
  assertManagementAuth(deletion);
});

test("API-key detail and update distinguish masked metadata from update secrets", () => {
  const detail = op("/api/keys/{id}", "get");
  const detailSchema = responseSchema("/api/keys/{id}", "get");
  assert.equal(detailSchema.$ref, "#/components/schemas/ApiKey");
  const keyProperty = spec.components.schemas.ApiKey.properties?.key;
  assert.deepEqual(keyProperty?.type, ["string", "null"]);
  assert.match(keyProperty?.description ?? "", /masked/i);
  assertManagementAuth(detail);

  const update = op("/api/keys/{id}", "patch");
  assert.equal(
    update.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiKeyPermissionsUpdate"
  );
  const updateResponse = responseSchema("/api/keys/{id}", "patch");
  assert.equal(updateResponse.$ref, "#/components/schemas/ApiKeyPermissionsUpdateResponse");
  assert.equal(updateResponse.properties?.connectionAccessMode, undefined);
  assert.deepEqual(
    update.responses?.["400"]?.content?.["application/json"]?.schema?.oneOf?.map(
      (variant) => variant.$ref
    ),
    ["#/components/schemas/ValidationErrorResponse", "#/components/schemas/ApiErrorResponse"]
  );
  assertManagementAuth(update);

  const deletion = op("/api/keys/{id}", "delete");
  assert.equal(
    responseSchema("/api/keys/{id}", "delete").$ref,
    "#/components/schemas/ApiKeyDeleteResponse"
  );
  assertManagementAuth(deletion);
});

test("key reveal and regeneration explicitly expose full secrets only on their dedicated routes", () => {
  const regenerate = op("/api/keys/{id}/regenerate", "post");
  const regenerated = responseSchema("/api/keys/{id}/regenerate", "post");
  assert.equal(regenerated.$ref, "#/components/schemas/ApiKeyRegenerateResponse");
  const regeneratedSchema = spec.components.schemas.ApiKeyRegenerateResponse;
  assert.equal(regeneratedSchema.properties?.key?.readOnly, true);
  assert.match(regeneratedSchema.description ?? "", /full API-key secret/i);
  assertManagementAuth(regenerate);

  const reveal = op("/api/keys/{id}/reveal", "get");
  const revealed = responseSchema("/api/keys/{id}/reveal", "get");
  assert.equal(revealed.$ref, "#/components/schemas/ApiKeySecretResponse");
  assert.equal(spec.components.schemas.ApiKeySecretResponse.properties?.key?.readOnly, true);
  assert.deepEqual(
    reveal.responses?.["403"]?.content?.["application/json"]?.schema?.oneOf?.map(
      (variant) => variant.$ref
    ),
    ["#/components/schemas/ApiErrorResponse", "#/components/schemas/StringErrorResponse"]
  );
  assertManagementAuth(reveal);
});

test("API-key device and usage-limit results document their privacy and accounting fields", () => {
  const devices = op("/api/keys/{id}/devices", "get");
  const deviceSchema = responseSchema("/api/keys/{id}/devices", "get");
  assert.equal(deviceSchema.$ref, "#/components/schemas/ApiKeyDevicesResponse");
  assert.match(spec.components.schemas.ApiKeyDeviceDetail.description ?? "", /masked|truncated/i);
  assertManagementAuth(devices);

  const usage = op("/api/keys/{id}/usage-limits", "get");
  const usageSchema = responseSchema("/api/keys/{id}/usage-limits", "get");
  assert.equal(usageSchema.$ref, "#/components/schemas/ApiKeyUsageLimitsResponse");
  assert.deepEqual(
    Object.keys(spec.components.schemas.ApiKeyUsageLimitStatus.properties ?? {}).sort(),
    [
      "dailyExceeded",
      "dailyLimitUsd",
      "dailyResetAtIso",
      "dailySpentUsd",
      "dailyWindowStartIso",
      "enabled",
      "weeklyExceeded",
      "weeklyLimitUsd",
      "weeklyResetAtIso",
      "weeklySpentUsd",
      "weeklyWindowStartIso",
    ].sort()
  );
  assertManagementAuth(usage);
});

test("selected management routes have non-empty successful response contracts and synced public spec", () => {
  const selected: Array<[string, string]> = [
    ["/api/providers", "patch"],
    ["/api/providers", "delete"],
    ["/api/keys/{id}", "get"],
    ["/api/keys/{id}", "patch"],
    ["/api/keys/{id}", "delete"],
    ["/api/keys/{id}/regenerate", "post"],
    ["/api/keys/{id}/reveal", "get"],
    ["/api/keys/{id}/devices", "get"],
    ["/api/keys/{id}/usage-limits", "get"],
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

  const publicSpecText = fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8");
  assert.equal(publicSpecText, docsSpecText, "public/openapi.yaml must match docs/openapi.yaml");
});
