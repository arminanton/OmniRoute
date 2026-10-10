import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;

test("TPROXY status schema follows the source status type and GET implementation", () => {
  const status = spec.components.schemas.AgentBridgeTproxyStatus;
  assert.ok(status, "AgentBridgeTproxyStatus schema exists");
  assert.deepEqual([...status.required].sort(), ["available", "running"]);
  assert.deepEqual(Object.keys(status.properties).sort(), [
    "available",
    "interceptCount",
    "onPort",
    "running",
    "startedAt",
  ]);
  assert.equal(status.properties.running.type, "boolean");
  assert.equal(status.properties.available.type, "boolean");
  assert.equal(status.properties.startedAt.format, "date-time");
  assert.equal(status.properties.interceptCount.type, "integer");
  assert.equal(status.properties.interceptCount.minimum, 0);
  assert.equal(status.properties.onPort.type, "integer");
  assert.equal(status.properties.onPort.minimum, 1);
  assert.equal(status.properties.onPort.maximum, 65535);
  assert.equal(status.additionalProperties, false);

  const pathItem = spec.paths["/api/tools/agent-bridge/tproxy"];
  assert.equal(
    pathItem.get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/AgentBridgeTproxyStatus"
  );
  assert.equal(
    spec.components.schemas.AgentBridgeTproxyActionResponse.properties.status.$ref,
    "#/components/schemas/AgentBridgeTproxyStatus"
  );

  const manager = fs.readFileSync(path.join(ROOT, "src/mitm/tproxy/captureManager.ts"), "utf8");
  const route = fs.readFileSync(
    path.join(ROOT, "src/app/api/tools/agent-bridge/tproxy/route.ts"),
    "utf8"
  );
  const statusInterface = manager.match(
    /export interface CaptureManagerStatus\s*\{([\s\S]*?)^\}/m
  )?.[1];
  assert.ok(statusInterface, "capture manager declares CaptureManagerStatus");
  const sourceFields = [
    ...statusInterface.matchAll(/^\s*(\w+)(\?)?:\s*(boolean|string|number);/gm),
  ].map(([, name, optional, type]) => ({ name, optional: Boolean(optional), type }));
  assert.deepEqual(
    sourceFields.map(({ name }) => name).sort(),
    Object.keys(status.properties).sort(),
    "OpenAPI fields must track all source status fields"
  );
  assert.deepEqual(
    sourceFields
      .filter(({ optional }) => !optional)
      .map(({ name }) => name)
      .sort(),
    [...status.required].sort(),
    "OpenAPI required fields must track the source interface"
  );
  for (const { name, type } of sourceFields) {
    const documentedType = type === "number" ? "integer" : type;
    assert.equal(status.properties[name].type, documentedType, `${name} type tracks source`);
  }
  assert.match(manager, /if \(!active\) return \{ running: false, available \};/);
  assert.match(
    manager,
    /return \{\s*running: true,\s*available,\s*startedAt: active\.startedAt,\s*interceptCount: active\.intercepts\.count,\s*onPort: active\.handle\.cfg\.onPort,/s
  );
  assert.match(
    route,
    /export function GET\(\): Response \{\s*return Response\.json\(getCaptureStatus\(\)\);/
  );
});

test("the public OpenAPI artifact mirrors the canonical TPROXY contract", () => {
  assert.deepEqual(publicSpec, spec);
});
