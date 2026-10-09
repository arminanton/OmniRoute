import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-task-routing-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const taskRoutingRoute = await import("../../src/app/api/settings/task-routing/route.ts");
const taskRouter = await import("../../open-sse/services/taskAwareRouter.ts");
const { updateTaskRoutingSchema, taskRoutingActionSchema } =
  await import("../../src/shared/validation/schemas/routing.ts");

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/settings/task-routing"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings/task-routing`);
  return result;
}

function taskRequest(method: string, body?: unknown): Promise<Request> {
  return makeManagementSessionRequest("http://localhost/api/settings/task-routing", {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function resetTaskConfig(): void {
  taskRouter.setTaskRoutingConfig({
    enabled: false,
    taskModelMap: taskRouter.getDefaultTaskModelMap(),
    detectionEnabled: true,
    patternOverrides: undefined,
  });
  taskRouter.resetTaskRoutingStats();
}

test.beforeEach(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  resetTaskConfig();
});

test.after(() => {
  resetTaskConfig();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("task-routing GET exposes active config, counters, built-in models and patterns", async () => {
  taskRouter.setTaskRoutingConfig({
    enabled: true,
    patternOverrides: { coding: { patterns: ["ship code"] } },
  });

  const response = await taskRoutingRoute.GET((await taskRequest("GET")) as never);
  const body = await response.json();
  const schema = spec.components.schemas.TaskRoutingGetResponse;
  assert.equal(response.status, 200);
  for (const key of schema.required) assert.ok(Object.hasOwn(body, key));
  assert.deepEqual(Object.keys(body).sort(), [...schema.required, "patternOverrides"].sort());
  assert.equal(body.enabled, true);
  assert.equal(body.patternOverrides.coding.patterns[0], "ship code");
  assert.deepEqual(
    Object.keys(body.defaultTaskModelMap).sort(),
    Object.keys(body.taskModelMap).sort()
  );
  assert.deepEqual(Object.keys(body.defaultTaskPatterns).sort(), [
    "analysis",
    "background",
    "chat",
    "coding",
    "creative",
    "summarization",
    "vision",
  ]);
  assert.equal(body.stats.detected, 0);
  assert.equal(body.stats.routed, 0);
});

test("task-routing PUT accepts partial bounded updates and returns persisted runtime config", async () => {
  const input = {
    enabled: true,
    detectionEnabled: false,
    taskModelMap: { coding: "cx/gpt-6.1-sol" },
    patternOverrides: { coding: { patterns: ["ship code"] } },
  };
  assert.equal(updateTaskRoutingSchema.safeParse(input).success, true);
  assert.equal(
    updateTaskRoutingSchema.safeParse({ patternOverrides: { coding: { patterns: [""] } } }).success,
    false
  );

  const response = await taskRoutingRoute.PUT((await taskRequest("PUT", input)) as never);
  const body = await response.json();
  const schema = spec.components.schemas.TaskRoutingUpdateResponse;
  assert.equal(response.status, 200);
  for (const key of schema.required) assert.ok(Object.hasOwn(body, key));
  assert.deepEqual(Object.keys(body).sort(), [...schema.required, "patternOverrides"].sort());
  assert.equal(body.success, true);
  assert.equal(body.enabled, true);
  assert.equal(body.detectionEnabled, false);
  assert.deepEqual(body.taskModelMap, { coding: "cx/gpt-6.1-sol" });
  assert.equal(body.patternOverrides.coding.patterns[0], "ship code");
  assert.deepEqual(Object.keys(body.stats).sort(), ["detected", "routed"]);
});

test("task-routing actions return reset stats and task-detection result variants", async () => {
  const reset = await taskRoutingRoute.POST(
    (await taskRequest("POST", { action: "reset-stats" })) as never
  );
  const resetBody = await reset.json();
  assert.equal(reset.status, 200);
  assert.deepEqual(Object.keys(resetBody).sort(), ["stats", "success"]);
  assert.equal(resetBody.success, true);
  assert.deepEqual(resetBody.stats, { detected: 0, routed: 0 });

  const detect = await taskRoutingRoute.POST(
    (await taskRequest("POST", {
      action: "detect",
      body: { messages: [{ role: "user", content: "hello" }] },
    })) as never
  );
  const detectBody = await detect.json();
  assert.equal(detect.status, 200);
  assert.deepEqual(Object.keys(detectBody).sort(), ["preferredModel", "taskType"]);
  assert.equal(detectBody.taskType, "chat");
  assert.equal(detectBody.preferredModel, "(no override)");
  assert.equal(taskRoutingActionSchema.safeParse({ action: "detect", body: {} }).success, true);
  assert.equal(taskRoutingActionSchema.safeParse({ action: "unknown" }).success, false);
});

test("task-routing operations document conditional auth, validated bodies and result unions", () => {
  for (const method of ["get", "post", "put"]) {
    const op = operation(method);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.ok(op.responses["401"]);
    assert.ok(op.responses["503"]);
  }
  assert.equal(
    operation("get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/TaskRoutingGetResponse"
  );
  assert.equal(
    operation("put").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/TaskRoutingUpdateRequest"
  );
  assert.equal(
    operation("put").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/TaskRoutingUpdateResponse"
  );
  assert.equal(
    operation("post").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/TaskRoutingActionRequest"
  );
  assert.equal(
    operation("post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/TaskRoutingActionResponse"
  );
  assert.ok(spec.components.schemas.TaskRoutingActionRequest.oneOf);
  assert.ok(spec.components.schemas.TaskRoutingActionResponse.oneOf);
});
