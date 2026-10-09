import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string;
  const?: string;
  format?: string;
  enum?: unknown[];
  properties?: Record<string, Schema>;
  required?: string[];
  oneOf?: Schema[];
  minLength?: number;
  maxLength?: number;
};

type Operation = {
  operationId?: string;
  summary?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name: string; required?: boolean }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: Schema }>;
      headers?: Record<string, { schema?: Schema }>;
    }
  >;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function responseSchema(pathTemplate: string, method: string, status = "200") {
  return spec.paths[pathTemplate]?.[method]?.responses?.[status]?.content?.["application/json"]
    ?.schema;
}

test("auth status, login, logout, and CSRF contracts match route behavior", () => {
  assert.equal(spec.paths["/api/auth/status"]?.get?.security?.length, 0);
  assert.equal(
    responseSchema("/api/auth/status", "get")?.$ref,
    "#/components/schemas/AuthStatusResponse"
  );

  const login = spec.paths["/api/auth/login"]?.post;
  assert.equal(
    login?.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/AuthLoginRequest"
  );
  assert.equal(login?.responses?.["200"]?.headers?.["Set-Cookie"]?.schema?.type, "string");
  assert.equal(
    responseSchema("/api/auth/login", "post")?.$ref,
    "#/components/schemas/SuccessResponse"
  );
  assert.equal(spec.components.schemas.AuthLoginRequest.properties?.password.maxLength, 200);

  assert.equal(
    responseSchema("/api/auth/logout", "post")?.$ref,
    "#/components/schemas/SuccessResponse"
  );
  const csrf = spec.paths["/api/auth/csrf"]?.get;
  assert.equal(
    csrf?.security?.some((requirement) => Object.keys(requirement).length === 0),
    true
  );
  assert.equal(
    responseSchema("/api/auth/csrf", "get")?.$ref,
    "#/components/schemas/DashboardCsrfResponse"
  );
});

test("database backup CRUD models restore, optional retention bodies, and result envelopes", () => {
  const route = spec.paths["/api/db-backups"];
  assert.match(route?.post?.summary ?? "", /Restore/);
  assert.equal(
    route?.post?.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/DbBackupRestoreRequest"
  );
  assert.equal(
    responseSchema("/api/db-backups", "get")?.$ref,
    "#/components/schemas/DbBackupListResponse"
  );
  assert.equal(
    responseSchema("/api/db-backups", "put")?.$ref,
    "#/components/schemas/DbBackupPutResponse"
  );
  assert.equal(route?.patch?.requestBody?.required, false);
  assert.equal(route?.delete?.requestBody?.required, false);
  assert.equal(
    responseSchema("/api/db-backups", "delete")?.$ref,
    "#/components/schemas/DbBackupCleanupResponse"
  );
});

test("database export/import use their actual archive formats and upload media types", () => {
  const exportAll = spec.paths["/api/db-backups/exportAll"]?.get;
  assert.equal(
    exportAll?.responses?.["200"]?.content?.["application/gzip"]?.schema?.format,
    "binary"
  );
  assert.match(exportAll?.summary ?? "", /tar\.gz/);

  const exportDb = spec.paths["/api/db-backups/export"]?.get;
  assert.equal(
    exportDb?.responses?.["200"]?.content?.["application/octet-stream"]?.schema?.format,
    "binary"
  );

  const importDb = spec.paths["/api/db-backups/import"]?.post;
  assert.equal(importDb?.requestBody?.required, true);
  assert.equal(
    importDb?.requestBody?.content?.["multipart/form-data"]?.schema?.properties?.file?.format,
    "binary"
  );
  assert.equal(
    importDb?.requestBody?.content?.["application/octet-stream"]?.schema?.format,
    "binary"
  );
  assert.equal(
    responseSchema("/api/db-backups/import", "post")?.$ref,
    "#/components/schemas/DbBackupImportResponse"
  );
});
