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
  description?: string;
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
    [key: string]: any;
  };
  responses?: Record<
    string,
    {
      content?: Record<string, { schema?: Schema }>;
      headers?: Record<string, { schema?: Schema }>;
      [key: string]: any;
    }
  >;
  [key: string]: any;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  tags: Array<{ name: string; description?: string }>;
  components: {
    schemas: Record<string, Schema>;
    securitySchemes: Record<string, Schema>;
  };
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
  assert.match(route?.put?.description ?? "", /awaits the native SQLite snapshot/i);
  assert.match(
    spec.components.schemas.DbBackupCreatedResponse.properties?.size.description ?? "",
    /measured before the native backup copy starts/i
  );
  assert.ok(route?.post?.responses?.["404"], "a missing backup ID is a 404");
  assert.match(route?.post?.responses?.["400"]?.description ?? "", /malformed backup ID/i);
});

test("backup security reflects legacy handler behavior and unlocked access-token policy", () => {
  const operations = [
    ["/api/db-backups", "get"],
    ["/api/db-backups", "put"],
    ["/api/db-backups", "post"],
    ["/api/db-backups", "patch"],
    ["/api/db-backups", "delete"],
    ["/api/db-backups/export", "get"],
    ["/api/db-backups/exportAll", "get"],
    ["/api/db-backups/import", "post"],
  ] as const;

  for (const [path, method] of operations) {
    const operation = spec.paths[path]?.[method];
    assert.equal(operation?.["x-always-protected"], true, `${method.toUpperCase()} ${path}`);
    assert.ok(
      operation?.security?.some((requirement) => "ManagementApiKeyBearerAuth" in requirement)
    );
    assert.ok(operation?.security?.some((requirement) => "ManagementSessionAuth" in requirement));
    assert.ok(operation?.security?.some((requirement) => "LocalCliTokenAuth" in requirement));
    assert.ok(
      operation?.security?.some((requirement) => "BearerAuth" in requirement),
      `${method.toUpperCase()} ${path} documents the central unlocked-profile bearer path`
    );
    assert.equal(
      operation?.security?.some((requirement) => Object.keys(requirement).length === 0),
      false,
      `${method.toUpperCase()} ${path} cannot be anonymous because the central path is always protected`
    );
  }

  assert.equal(spec.paths["/api/db-backups/exportAll"]?.get?.["x-local-only"], true);
  assert.match(
    spec.tags.find((tag) => tag.name === "Db backups")?.description ?? "",
    /requireLogin=false/
  );
  assert.match(
    spec.tags.find((tag) => tag.name === "Db backups")?.description ?? "",
    /local CLI token/i
  );
  assert.match(
    spec.components.securitySchemes.ManagementApiKeyBearerAuth.description,
    /do not validate `oma_live_` access tokens/i
  );
  assert.match(spec.components.securitySchemes.BearerAuth.description ?? "", /oma_live_/i);
});

test("database export/import use their actual archive formats and upload media types", () => {
  const exportAll = spec.paths["/api/db-backups/exportAll"]?.get;
  assert.equal(
    exportAll?.responses?.["200"]?.content?.["application/gzip"]?.schema?.format,
    "binary"
  );
  assert.match(exportAll?.summary ?? "", /tar\.gz/);
  assert.equal(exportAll?.responses?.["200"]?.["x-sensitive"], true);
  assert.match(exportAll?.description ?? "", /raw API keys/i);

  const exportDb = spec.paths["/api/db-backups/export"]?.get;
  assert.equal(
    exportDb?.responses?.["200"]?.content?.["application/octet-stream"]?.schema?.format,
    "binary"
  );
  assert.equal(exportDb?.responses?.["200"]?.["x-sensitive"], true);

  const importDb = spec.paths["/api/db-backups/import"]?.post;
  assert.equal(importDb?.requestBody?.required, true);
  assert.equal(importDb?.requestBody?.["x-sensitive"], true);
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
