import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type OpenApiDocument = {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const root = process.cwd();
const canonicalText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(root, "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as OpenApiDocument;
const publicSpec = yaml.load(publicText) as OpenApiDocument;
const routeGuard = await import("../../src/server/authz/routeGuard.ts");

function operation(pathTemplate: string, method: string): Record<string, any> {
  const result = spec.paths[pathTemplate]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathTemplate}`);
  return result;
}

function assertConditionalManagementAuth(op: Record<string, any>): void {
  assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
  assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
  assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
}

test("system version documents the safe GET and local-only update POST separately", () => {
  const get = operation("/api/system/version", "get");
  const post = operation("/api/system/version", "post");
  assertConditionalManagementAuth(get);
  assertConditionalManagementAuth(post);

  assert.equal(get["x-local-only"], undefined);
  assert.equal(post["x-local-only"], true);
  assert.equal(routeGuard.isLocalOnlyPath("/api/system/version", "GET"), false);
  assert.equal(routeGuard.isLocalOnlyPath("/api/system/version", "POST"), true);

  assert.equal(get.parameters[0].name, "If-None-Match");
  assert.equal(
    get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/SystemVersionResponse"
  );
  assert.ok(get.responses["200"].headers.ETag);
  assert.match(get.responses["200"].headers["Cache-Control"].schema.example, /private, no-cache/);
  assert.ok(get.responses["304"]);
  assert.equal(get.responses["304"].content, undefined);
  assert.equal(
    get.responses["401"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );

  assert.equal(post.requestBody, undefined);
  assert.equal(
    post.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/SystemVersionUpdateJsonResponse"
  );
  assert.equal(
    post.responses["200"].content["text/event-stream"]["x-sse-event-schema"].$ref,
    "#/components/schemas/SystemVersionUpdateEvent"
  );
  assert.equal(
    post.responses["400"].content["application/json"].schema.$ref,
    "#/components/schemas/SystemVersionUpdateJsonResponse"
  );
  assert.equal(
    post.responses["401"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.ok(post.responses["503"]);

  const updateEvent = spec.components.schemas.SystemVersionUpdateEvent;
  assert.deepEqual(updateEvent.required, ["step", "status", "message"]);
  assert.ok(updateEvent.properties.step.enum.includes("error"));
  assert.ok(updateEvent.properties.status.enum.includes("failed"));
});

test("DB health documents read-only diagnosis and authenticated repair results", () => {
  const get = operation("/api/db/health", "get");
  const post = operation("/api/db/health", "post");
  for (const op of [get, post]) {
    assertConditionalManagementAuth(op);
    assert.equal(
      op.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/DbHealthCheckResult"
    );
    assert.equal(
      op.responses["401"].content["application/json"].schema.$ref,
      "#/components/schemas/DbHealthErrorResponse"
    );
    assert.equal(
      op.responses["500"].content["application/json"].schema.$ref,
      "#/components/schemas/DbHealthErrorResponse"
    );
  }

  assert.match(get.description, /without repairing/i);
  assert.match(post.description, /automatic repair enabled/i);
  assert.match(post.description, /backup is attempted/i);
  assert.match(post.description, /repairedCount/);
  assert.equal(post.requestBody, undefined);

  const resultSchema = spec.components.schemas.DbHealthCheckResult;
  assert.deepEqual(resultSchema.required, [
    "isHealthy",
    "issues",
    "repairedCount",
    "backupCreated",
    "autoRepair",
    "checkedAt",
    "driver",
  ]);
  assert.deepEqual(spec.components.schemas.DbHealthIssue.properties.type.enum, [
    "integrity_check_failed",
    "broken_reference",
    "stale_snapshot",
    "invalid_state",
  ]);
  assert.deepEqual(spec.components.schemas.DbHealthDriver.properties.name.enum, [
    "better-sqlite3",
    "node:sqlite",
    "bun:sqlite",
    "sql.js",
  ]);
});

test("public OpenAPI mirror stays byte-for-byte synchronized for this contract", () => {
  assert.equal(publicText, canonicalText);
  for (const pathTemplate of ["/api/system/version", "/api/db/health"]) {
    assert.deepEqual(publicSpec.paths[pathTemplate], spec.paths[pathTemplate]);
  }
});
