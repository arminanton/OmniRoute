import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  description?: string;
  format?: string;
  default?: unknown;
  const?: unknown;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  required?: string[];
  readOnly?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  not?: { anyOf?: Schema[] };
  additionalProperties?: boolean | Schema;
};

type Response = {
  $ref?: string;
  description?: string;
  headers?: Record<string, { schema?: Schema }>;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  description?: string;
  security?: Array<Record<string, unknown>>;
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

test("Codex imports document auth JSON forms, secret redaction, and bulk partial results", () => {
  const single = op("/api/providers/codex-auth/import", "post");
  assert.equal(
    single.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexAuthImportRequest"
  );
  const sourceVariants =
    spec.components.schemas.CodexAuthImportRequest.properties?.source?.oneOf ?? [];
  assert.deepEqual(
    sourceVariants.map((variant) => variant.properties?.kind?.const),
    ["json", "text"]
  );
  assert.equal(sourceVariants[1]?.properties?.text?.maxLength, 262144);
  assert.equal(
    responseSchema("/api/providers/codex-auth/import", "post").$ref,
    "#/components/schemas/CodexAuthImportResponse"
  );
  assert.match(spec.components.schemas.CodexAuthImportResponse.description ?? "", /omits apiKey/);
  const strippedConnectionFields = spec.components.schemas.ProviderConnection.not?.anyOf?.flatMap(
    (group) => group.required ?? []
  );
  for (const field of ["accessToken", "refreshToken", "idToken"]) {
    assert.ok(
      strippedConnectionFields?.includes(field),
      `connection response must exclude ${field}`
    );
  }
  assertConditionalManagementAuth(single);

  const bulk = op("/api/providers/codex-auth/import-bulk", "post");
  assert.equal(
    bulk.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexAuthBulkImportRequest"
  );
  assert.equal(
    spec.components.schemas.CodexAuthBulkImportRequest.properties?.entries?.maxItems,
    50
  );
  assert.equal(
    responseSchema("/api/providers/codex-auth/import-bulk", "post").$ref,
    "#/components/schemas/CodexAuthBulkImportResponse"
  );
  assert.equal(
    spec.components.schemas.CodexAuthBulkImportResponse.properties?.success?.type,
    "integer"
  );
  assert.match(
    spec.components.schemas.CodexAuthBulkImportResponse.description ?? "",
    /even when all entries fail/
  );
  assertConditionalManagementAuth(bulk);
});

test("Codex ZIP extraction documents raw ZIP media and compressed/extracted limits", () => {
  const zip = op("/api/providers/codex-auth/zip-extract", "post");
  assert.equal(zip.requestBody?.required, true);
  assert.equal(zip.requestBody?.content?.["application/zip"]?.schema?.format, "binary");
  assert.match(zip.description ?? "", /11 MiB.*50 JSON files.*256 KiB.*10 MiB/s);
  assert.equal(
    responseSchema("/api/providers/codex-auth/zip-extract", "post").$ref,
    "#/components/schemas/CodexAuthZipExtractResponse"
  );
  assert.equal(
    zip.responses?.["413"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexAuthFlowErrorResponse"
  );
  assert.equal(
    zip.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexAuthFlowErrorResponse"
  );
  assert.match(
    spec.components.schemas.CodexAuthZipEntry.properties?.json?.description ?? "",
    /raw Codex OAuth token values/
  );
  assertConditionalManagementAuth(zip);
});

test("Codex export is an always-protected raw JSON attachment exposing the auth-file token set", () => {
  const route = op("/api/providers/{id}/codex-auth/export", "post");
  assertAlwaysProtectedManagementAuth(route);
  const response = route.responses?.["200"];
  assert.equal(
    response?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexAuthFilePayload"
  );
  assert.ok(response?.headers?.["Content-Disposition"]);
  assert.equal(response?.headers?.["Cache-Control"]?.schema?.const, "no-store, max-age=0");
  assert.equal(response?.headers?.["X-Content-Type-Options"]?.schema?.const, "nosniff");
  const payload = spec.components.schemas.CodexAuthFilePayload;
  assert.equal(payload.properties?.auth_mode?.const, "chatgpt");
  for (const field of ["id_token", "access_token", "refresh_token"]) {
    assert.equal(payload.properties?.tokens?.properties?.[field]?.readOnly, true);
  }
  assert.match(payload.description ?? "", /contains credentials/i);
  for (const status of ["400", "404", "409", "502"]) {
    assert.equal(
      route.responses?.[status]?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/CodexAuthFileErrorResponse"
    );
  }
});

test("Codex apply-local documents optional force, write/skip results, and protected auth", () => {
  const route = op("/api/providers/{id}/codex-auth/apply-local", "post");
  assertAlwaysProtectedManagementAuth(route);
  assert.equal(route.requestBody?.required, false);
  assert.equal(
    route.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexAuthApplyLocalRequest"
  );
  assert.equal(
    spec.components.schemas.CodexAuthApplyLocalRequest.properties?.force?.default,
    false
  );
  assert.deepEqual(spec.components.schemas.CodexAuthApplyLocalResponse.properties?.decision?.enum, [
    "written",
    "skipped_present_fresh",
  ]);
  assert.match(
    spec.components.schemas.CodexAuthApplyLocalResponse.description ?? "",
    /token values are not returned/
  );
  assert.equal(
    responseSchema("/api/providers/{id}/codex-auth/apply-local", "post").$ref,
    "#/components/schemas/CodexAuthApplyLocalResponse"
  );
  assert.deepEqual(
    route.responses?.["403"]?.content?.["application/json"]?.schema?.oneOf?.map(
      (variant) => variant.$ref
    ),
    ["#/components/schemas/ApiErrorResponse", "#/components/schemas/CodexAuthFileErrorResponse"]
  );
});

test("every Codex credential-flow success response has a typed body", () => {
  const selected: Array<[string, string]> = [
    ["/api/providers/codex-auth/import", "post"],
    ["/api/providers/codex-auth/import-bulk", "post"],
    ["/api/providers/codex-auth/zip-extract", "post"],
    ["/api/providers/{id}/codex-auth/export", "post"],
    ["/api/providers/{id}/codex-auth/apply-local", "post"],
  ];
  for (const [pathTemplate, method] of selected) {
    const success = Object.entries(op(pathTemplate, method).responses ?? {}).filter(([status]) =>
      status.startsWith("2")
    );
    assert.ok(success.length > 0);
    for (const [status, response] of success) {
      const expectedContent = pathTemplate.endsWith("/codex-auth/export")
        ? "application/json"
        : "application/json";
      assert.ok(
        response.content?.[expectedContent]?.schema,
        `empty ${status} ${method} ${pathTemplate}`
      );
    }
  }
});
