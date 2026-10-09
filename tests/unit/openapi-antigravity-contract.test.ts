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
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  additionalProperties?: boolean | Schema;
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
    name: string;
    in: string;
    required?: boolean;
    schema?: Schema;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<string, Response>;
  "x-always-protected"?: boolean;
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

function assertConditionalManagementAuth(operation: Operation) {
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

function assertAlwaysProtectedManagementAuth(operation: Operation) {
  assert.equal(operation["x-always-protected"], true);
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
    false
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
    true
  );
  assert.equal(
    operation.responses?.["503"]?.$ref,
    "#/components/responses/ManagementAuthUnavailable"
  );
}

test("Antigravity CLI token imports and local detection document inputs and sanitized outcomes", () => {
  const single = op("/api/providers/agy-auth/import", "post");
  assert.equal(
    single.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AgyAuthImportRequest"
  );
  const sourceVariants =
    spec.components.schemas.AgyAuthImportRequest.properties?.source?.oneOf ?? [];
  assert.deepEqual(
    sourceVariants.map((variant) => variant.properties?.kind?.const),
    ["json", "text"]
  );
  assert.equal(sourceVariants[1]?.properties?.text?.maxLength, 262144);
  assert.equal(
    responseSchema("/api/providers/agy-auth/import", "post").$ref,
    "#/components/schemas/AgyAuthImportResponse"
  );
  assertConditionalManagementAuth(single);

  const bulk = op("/api/providers/agy-auth/import-bulk", "post");
  assert.equal(
    bulk.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AgyAuthBulkImportRequest"
  );
  assert.equal(spec.components.schemas.AgyAuthBulkImportRequest.properties?.entries?.maxItems, 50);
  assert.equal(
    responseSchema("/api/providers/agy-auth/import-bulk", "post").$ref,
    "#/components/schemas/AgyAuthBulkImportResponse"
  );
  assert.equal(
    spec.components.schemas.AgyAuthBulkImportResponse.properties?.success?.type,
    "integer"
  );
  assertConditionalManagementAuth(bulk);

  const applyLocal = op("/api/providers/agy-auth/apply-local", "post");
  assertAlwaysProtectedManagementAuth(applyLocal);
  assert.equal(applyLocal.requestBody?.required, false);
  assert.equal(
    applyLocal.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AgyAuthApplyLocalRequest"
  );
  assert.equal(
    spec.components.schemas.AgyAuthApplyLocalRequest.properties?.overwriteExisting?.default,
    true
  );
  assert.equal(
    applyLocal.responses?.["404"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AgyAuthFlowErrorResponse"
  );
});

test("Antigravity ZIP import and pasted remote-login blob document raw credential handling", () => {
  const zip = op("/api/providers/agy-auth/zip-extract", "post");
  assert.equal(zip.requestBody?.required, true);
  assert.equal(zip.requestBody?.content?.["application/zip"]?.schema?.format, "binary");
  assert.match(zip.description ?? "", /11 MiB.*50 JSON files.*256 KiB.*10 MiB/s);
  assert.match(
    spec.components.schemas.AgyAuthZipEntry.properties?.json?.description ?? "",
    /OAuth token values/
  );
  assert.equal(
    responseSchema("/api/providers/agy-auth/zip-extract", "post").$ref,
    "#/components/schemas/AgyAuthZipExtractResponse"
  );
  assert.equal(
    zip.responses?.["413"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AgyAuthFlowErrorResponse"
  );
  assertConditionalManagementAuth(zip);

  const paste = op("/api/oauth/{provider}/paste-credentials", "post");
  assert.deepEqual(
    spec.paths["/api/oauth/{provider}/paste-credentials"].parameters?.[0]?.schema?.enum,
    ["antigravity", "agy"]
  );
  assert.equal(
    paste.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AntigravityPastedCredentialRequest"
  );
  assert.match(
    spec.components.schemas.AntigravityPastedCredentialRequest.properties?.blob?.description ?? "",
    /keep it private/i
  );
  assert.equal(
    responseSchema("/api/oauth/{provider}/paste-credentials", "post").$ref,
    "#/components/schemas/AntigravityPastedCredentialResponse"
  );
  assert.deepEqual(
    Object.keys(
      spec.components.schemas.AntigravityPastedCredentialResponse.properties?.connection
        ?.properties ?? {}
    ).sort(),
    ["displayName", "email", "id", "provider"].sort()
  );
  assert.equal(
    paste.responses?.["401"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
});

test("provider model sync covers Antigravity branches, modes, status errors, and internal auth", () => {
  const route = op("/api/providers/{id}/sync-models", "post");
  assert.equal(route.requestBody, undefined);
  assert.equal(
    route.parameters?.find((parameter) => parameter.name === "mode")?.schema?.default,
    "sync"
  );
  assert.deepEqual(route.parameters?.find((parameter) => parameter.name === "mode")?.schema?.enum, [
    "sync",
    "import",
  ]);
  assert.deepEqual(
    route.parameters?.find((parameter) => parameter.name === "quiet")?.schema?.enum,
    ["1"]
  );
  assert.equal(
    route.parameters?.find((parameter) => parameter.name === "x-model-sync-internal-auth")?.in,
    "header"
  );
  assert.equal(
    route.security?.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")),
    true
  );
  assert.equal(
    route.security?.some((entry) => Object.hasOwn(entry, "BearerAuth")),
    true
  );
  assert.equal(
    route.security?.some((entry) => Object.keys(entry).length === 0),
    true
  );
  const syncResponse = responseSchema("/api/providers/{id}/sync-models", "post");
  assert.equal(syncResponse.$ref, "#/components/schemas/ProviderModelSyncResponse");
  assert.equal(spec.components.schemas.ProviderModelSyncResponse.oneOf?.length, 3);
  assert.equal(
    spec.components.schemas.ProviderModelSyncStandardResponse.properties?.provider?.type,
    "string"
  );
  assert.equal(
    spec.components.schemas.ProviderModelSyncStandardResponse.required?.includes("importedChanges"),
    true
  );
  assert.equal(
    route.responses?.["502"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderModelSyncErrorResponse"
  );
});

test("selected Antigravity and sync routes have typed successful JSON bodies", () => {
  const selected: Array<[string, string]> = [
    ["/api/providers/agy-auth/import", "post"],
    ["/api/providers/agy-auth/import-bulk", "post"],
    ["/api/providers/agy-auth/zip-extract", "post"],
    ["/api/providers/agy-auth/apply-local", "post"],
    ["/api/oauth/{provider}/paste-credentials", "post"],
    ["/api/providers/{id}/sync-models", "post"],
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
