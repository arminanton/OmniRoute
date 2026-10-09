import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-system-lifecycle-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
};
const syncInitializationRoute = await import("../../src/app/api/sync/initialize/route.ts");

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

test.after(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("sync initialization status matches the live GET body", async () => {
  const response = await syncInitializationRoute.GET(
    new Request("http://localhost/api/sync/initialize")
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["initialized", "message", "modelSyncInitialized"]);
  assert.equal(
    operation("/api/sync/initialize", "get").responses["200"].content["application/json"].schema
      .$ref,
    "#/components/schemas/SyncInitializationStatusResponse"
  );
});

test("scheduler initialization documents the idempotent and started results without running jobs", () => {
  const get = operation("/api/sync/initialize", "get");
  const post = operation("/api/sync/initialize", "post");
  for (const op of [get, post]) assertConditionalManagementAuth(op);
  assert.equal(
    post.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/SyncInitializationResponse"
  );
  assert.equal(
    post.responses["500"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.equal(post.requestBody, undefined);
  assert.equal(
    operation("/api/sync/initialize", "get").responses["200"].content["application/json"].schema
      .$ref,
    "#/components/schemas/SyncInitializationStatusResponse"
  );
});

test("restart and shutdown document their delayed signal and protection tiers", () => {
  const restart = operation("/api/restart", "post");
  assertConditionalManagementAuth(restart);
  assert.equal(
    restart.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/RestartResponse"
  );
  assert.match(restart.description, /SIGTERM.*500 ms|SIGTERM/);

  const shutdown = operation("/api/shutdown", "post");
  assert.equal(shutdown["x-always-protected"], true);
  assert.ok(shutdown.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
  assert.ok(
    shutdown.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth"))
  );
  assert.equal(
    shutdown.security?.some((item: object) => Object.keys(item).length === 0),
    false
  );
  assert.equal(
    shutdown.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ShutdownResponse"
  );
});
