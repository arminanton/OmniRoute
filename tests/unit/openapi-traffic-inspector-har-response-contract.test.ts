import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { toHar } from "../../src/lib/inspector/harExport.ts";
import type { InterceptedRequest } from "../../src/mitm/inspector/types.ts";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = yaml.load(
  fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")
) as any;

function schema(name: string): any {
  const value = spec.components.schemas[name];
  assert.ok(value, `missing components.schemas.${name}`);
  return value;
}

function assertSchemaKeys(name: string, required: string[], optional: string[] = []): void {
  const value = schema(name);
  assert.deepEqual([...value.required].sort(), [...required].sort(), `${name} required keys`);
  assert.deepEqual(
    Object.keys(value.properties).sort(),
    [...required, ...optional].sort(),
    `${name} declared keys`
  );
}

function fixture(): InterceptedRequest {
  return {
    id: "b2aaeb2d-4896-43a6-a96a-351870552fc9",
    source: "agent-bridge",
    agent: "codex",
    timestamp: "2026-10-10T15:00:00.000Z",
    method: "POST",
    host: "api.example.com",
    path: "/v1/responses?model=test",
    requestHeaders: {
      authorization: "Bearer sk-abcdefghijklmnopqrstuvwxyz012345",
      "content-type": "application/json",
    },
    requestBody: '{"api_key":"sk-abcdefghijklmnopqrstuvwxyz012345","prompt":"hello"}',
    requestSize: 47,
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"token":"0123456789abcdefghijklmnopqrstuvwxyzABCDEFG","ok":true}',
    responseSize: 37,
    status: 200,
    upstreamLatencyMs: 10,
    totalLatencyMs: 15,
    detectedKind: "llm",
    contextKey: "a3f9c2b1d5e4",
    annotation: "review this",
    sessionId: "0c7f0d37-308b-45bd-bf5e-dde0768ba73f",
    note: "captured by fixture",
  };
}

test("both HAR export routes use a typed, sensitive HAR response contract", () => {
  for (const route of [
    "/api/tools/traffic-inspector/export.har",
    "/api/tools/traffic-inspector/sessions/{id}/export.har",
  ]) {
    const response = spec.paths[route].get.responses["200"];
    assert.equal(response["x-sensitive"], true);
    assert.equal(
      response.content["application/json"].schema.$ref,
      "#/components/schemas/TrafficInspectorHarFile"
    );
    assert.equal(response.headers["Cache-Control"].schema.const, "no-store");
  }
});

test("HAR component keys and required fields match the real exporter output", () => {
  const har = toHar([fixture()]);
  const [entry] = har.log.entries;

  assertSchemaKeys("TrafficInspectorHarFile", ["log"]);
  assertSchemaKeys("TrafficInspectorHarLog", ["version", "creator", "entries"]);
  assertSchemaKeys("TrafficInspectorHarCreator", ["name", "version"]);
  assertSchemaKeys("TrafficInspectorHarNameValue", ["name", "value"]);
  assertSchemaKeys("TrafficInspectorHarPostData", ["mimeType", "text"]);
  assertSchemaKeys("TrafficInspectorHarContent", ["size", "mimeType"], ["text"]);
  assertSchemaKeys(
    "TrafficInspectorHarRequest",
    [
      "method",
      "url",
      "httpVersion",
      "headers",
      "queryString",
      "cookies",
      "headersSize",
      "bodySize",
    ],
    ["postData"]
  );
  assertSchemaKeys("TrafficInspectorHarResponse", [
    "status",
    "statusText",
    "httpVersion",
    "headers",
    "cookies",
    "content",
    "redirectURL",
    "headersSize",
    "bodySize",
  ]);
  assert.equal(schema("TrafficInspectorHarResponse").properties.status.minimum, undefined);
  assert.deepEqual(schema("TrafficInspectorHarResponse").properties.statusText.enum, [
    "",
    "in-flight",
    "error",
  ]);
  assert.deepEqual(schema("TrafficInspectorHarCache").maxProperties, 0);
  assertSchemaKeys("TrafficInspectorHarTimings", ["send", "wait", "receive"]);
  assertSchemaKeys(
    "TrafficInspectorHarEntry",
    [
      "startedDateTime",
      "time",
      "request",
      "response",
      "cache",
      "timings",
      "_source",
      "_omniRouteId",
    ],
    ["_agent", "_detectedKind", "_contextKey", "_sessionId", "_annotation", "_note"]
  );

  assert.deepEqual(Object.keys(har), ["log"]);
  assert.deepEqual(Object.keys(har.log).sort(), ["creator", "entries", "version"]);
  assert.deepEqual(
    Object.keys(entry).sort(),
    Object.keys(schema("TrafficInspectorHarEntry").properties).sort()
  );
  assert.deepEqual(
    Object.keys(entry.request).sort(),
    Object.keys(schema("TrafficInspectorHarRequest").properties).sort()
  );
  assert.deepEqual(
    Object.keys(entry.response).sort(),
    Object.keys(schema("TrafficInspectorHarResponse").properties).sort()
  );
  assert.deepEqual(entry.request.queryString, []);
  assert.deepEqual(entry.request.cookies, []);
  assert.deepEqual(entry.response.cookies, []);
  const negativeStatus = toHar([{ ...fixture(), status: -1 }]);
  assert.equal(negativeStatus.log.entries[0].response.status, -1);
  assert.deepEqual(entry.cache, {});
  assert.equal(entry.request.headersSize, -1);
  assert.equal(entry.response.headersSize, -1);
  assert.equal(entry.request.postData?.text.includes("sk-abcdefghijklmnopqrstuvwxyz012345"), false);
  assert.equal(
    entry.response.content.text?.includes("0123456789abcdefghijklmnopqrstuvwxyzABCDEFG"),
    false
  );
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror the canonical document");
});
