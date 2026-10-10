import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as yaml from "js-yaml";

const canonicalText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

function operation(method: string, pathname: string) {
  const value = spec.paths[pathname]?.[method];
  assert.ok(value, `Missing ${method.toUpperCase()} ${pathname}`);
  return value;
}

const contracts = [
  ["delete", "/api/mcp/stream", ["2XX", "400", "401", "403", "404", "500", "503"], "McpStreamSdkResponse"],
  ["get", "/api/mcp/stream", ["2XX", "400", "401", "403", "404", "500", "503"], "McpStreamSdkResponse"],
  ["post", "/api/mcp/stream", ["2XX", "400", "401", "403", "404", "500", "503"], "McpStreamSdkResponse"],
  ["delete", "/api/middleware/hooks/{name}", ["200", "401", "403", "404", "500", "503"], "MiddlewareHookDeleteResponse"],
  ["get", "/api/middleware/hooks/{name}", ["200", "401", "403", "404", "500", "503"], "MiddlewareHookDetailResponse"],
  ["put", "/api/middleware/hooks/{name}", ["200", "400", "401", "403", "404", "500", "503"], "MiddlewareHookResponse"],
  ["get", "/api/modality-bridge/stats", ["200", "401"], "ModalityBridgeStatsResponse"],
  ["delete", "/api/modality-bridge/video/drilldown", ["200", "400", "403", "404"], "VideoDrilldownDeleteResponse"],
  ["get", "/api/modality-bridge/video/drilldown", ["200", "400", "403", "404"], "VideoDrilldownResult"],
  ["post", "/api/modality-bridge/video/drilldown", ["201", "400", "403", "404", "413", "499", "500"], "VideoDrilldownStoredResponse"],
  ["post", "/api/modality-bridge/video/extract", ["200", "400", "403", "413", "422", "499", "503", "504"], "VideoExtractionResponse"],
  ["get", "/api/modality-bridge/video/runtime", ["200", "401", "403"], "VideoRuntimeStatus"],
  ["delete", "/api/monitoring/health", ["200", "401", "403", "500", "503"], "MonitoringHealthResetResponse"],
  ["post", "/api/omniroute/route/preview", ["200", "400", "401", "403", "503"], "OmniRouteCandidatePreviewResponse"],
  ["post", "/api/playground/simulate-route", ["200", "400", "401", "403", "404", "500", "503"], "PlaygroundRouteSimulationResponse"],
] as const;

test("all 15 audited operations declare exact statuses and typed success responses", () => {
  assert.equal(contracts.length, 15);
  for (const [method, pathname, statuses, schemaName] of contracts) {
    const op = operation(method, pathname);
    assert.deepEqual(Object.keys(op.responses).sort(), [...statuses].sort(), `${method.toUpperCase()} ${pathname}`);
    const status = pathname === "/api/modality-bridge/video/drilldown" && method === "post" ? "201" : pathname === "/api/mcp/stream" ? "2XX" : "200";
    const success = op.responses[status];
    assert.ok(success, `${method.toUpperCase()} ${pathname} has ${status}`);
    if (pathname === "/api/mcp/stream") {
      assert.equal(success.content?.["application/json"]?.schema?.$ref, "#/components/schemas/McpStreamSdkResponse");
      if (method !== "delete") assert.ok(success.content?.["text/event-stream"]);
      continue;
    }
    const schema = success.content?.["application/json"]?.schema;
    assert.ok(schema, `${method.toUpperCase()} ${pathname} has a JSON response schema`);
    if (pathname === "/api/modality-bridge/video/extract") {
      assert.equal(schema.$ref, "#/components/schemas/VideoExtractionResponse");
      assert.deepEqual(spec.components.schemas.VideoExtractionResponse.oneOf.map((entry: any) => entry.$ref), [
        "#/components/schemas/VideoFrameResponse",
        "#/components/schemas/VideoAudioResponse",
        "#/components/schemas/VideoSubtitleResponse",
      ]);
    } else {
      assert.equal(schema.$ref, `#/components/schemas/${schemaName}`, `${method.toUpperCase()} ${pathname}`);
    }
    assert.ok(spec.components.schemas[schemaName!], `Missing ${schemaName}`);
  }
});

test("MCP SDK pass-through and wrapper-owned errors/session headers are documented", () => {
  for (const method of ["get", "post", "delete"]) {
    const op = operation(method, "/api/mcp/stream");
    const success = op.responses["2XX"];
    assert.equal(success.headers["Mcp-Session-Id"].required, true);
    assert.equal(success.headers["Mcp-Session-Id"].schema["x-sensitive"], true);
    assert.ok(op.responses["400"].content["application/json"].schema.oneOf.some((entry: any) => entry.$ref === "#/components/schemas/McpStreamJsonRpcErrorResponse"));
    assert.equal(op.responses["404"].content["application/json"].schema.$ref, "#/components/schemas/McpStreamJsonRpcErrorResponse");
    assert.equal(op.responses["500"].content["application/json"].schema.$ref, "#/components/schemas/StringErrorResponse");
    assert.equal(op["x-local-only"], true);
    assert.ok(op.security.some((alternative: any) => alternative.McpConnectApiKeyBearerAuth));
    assert.ok(op["x-authentication-branches"].some((branch: any) => /default MCP manage-scope bypass/.test(branch.when)));
  }
  const post = operation("post", "/api/mcp/stream").responses["2XX"];
  assert.match(post.headers["Cache-Control"].description, /appends `no-transform`/);
});

test("existing LOCAL_ONLY and management declarations remain intact", () => {
  for (const method of ["delete", "get", "put"]) {
    const hook = operation(method, "/api/middleware/hooks/{name}");
    assert.equal(hook["x-local-only"], true);
    assert.match(hook.description, /LOCAL_ONLY/);
  }
  assert.equal(operation("get", "/api/modality-bridge/stats").security[0].ManagementSessionAuth.length, 0);
  assert.equal(operation("get", "/api/modality-bridge/video/runtime")["x-local-only"], true);
  assert.equal(operation("post", "/api/modality-bridge/video/extract")["x-local-only"], true);
  assert.equal(operation("delete", "/api/monitoring/health").security.length, 5);
  assert.match(operation("delete", "/api/monitoring/health").description, /isAuthenticated\(\)/);
  assert.equal(operation("post", "/api/omniroute/route/preview").security.length, 7);
  assert.equal(operation("post", "/api/playground/simulate-route").security.length, 7);
});

test("media, routing payloads, hook code, and MCP content are marked sensitive", () => {
  assert.equal(operation("get", "/api/middleware/hooks/{name}").responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.MiddlewareHookConfig.properties.code["x-sensitive"], true);
  assert.equal(operation("put", "/api/middleware/hooks/{name}").requestBody["x-sensitive"], true);
  assert.equal(spec.components.schemas.McpStreamSdkResponse["x-sensitive"], true);
  assert.equal(operation("post", "/api/modality-bridge/video/extract").responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.VideoSubtitleResponse.properties.fingerprint["x-sensitive"], true);
  assert.equal(operation("get", "/api/modality-bridge/video/drilldown").responses["200"]["x-sensitive"], true);
  assert.equal(operation("post", "/api/omniroute/route/preview").requestBody["x-sensitive"], true);
  assert.equal(operation("post", "/api/playground/simulate-route").responses["200"]["x-sensitive"], true);
});

test("live-cache headers and nonstandard modality statuses are represented", () => {
  assert.equal(operation("get", "/api/modality-bridge/stats").responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(operation("get", "/api/modality-bridge/video/runtime").responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(operation("post", "/api/modality-bridge/video/extract").responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(operation("post", "/api/modality-bridge/video/extract").responses["503"].headers["Retry-After"].schema.const, "1");
  assert.equal(operation("get", "/api/modality-bridge/video/drilldown").responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(operation("post", "/api/modality-bridge/video/drilldown").responses["201"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(operation("delete", "/api/modality-bridge/video/drilldown").responses["200"].headers, undefined);
  for (const status of ["400", "403", "404", "413", "499", "500"]) {
    assert.equal(operation("post", "/api/modality-bridge/video/drilldown").responses[status].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  }
});

test("source-backed middleware, health, and playground error branches are represented", () => {
  assert.equal(operation("put", "/api/middleware/hooks/{name}").responses["400"].content["application/json"].schema.$ref, "#/components/schemas/ValidationErrorResponse");
  assert.equal(operation("delete", "/api/monitoring/health").responses["401"].content["application/json"].schema.$ref, "#/components/schemas/StringErrorResponse");
  assert.deepEqual(operation("post", "/api/playground/simulate-route").responses["400"].content["application/json"].schema.oneOf.map((entry: any) => entry.$ref), [
    "#/components/schemas/ValidationErrorResponse",
    "#/components/schemas/StringErrorResponse",
  ]);
  assert.equal(operation("post", "/api/playground/simulate-route").responses["404"].content["application/json"].schema.$ref, "#/components/schemas/StringErrorResponse");
  assert.equal(operation("post", "/api/playground/simulate-route").responses["500"].content["application/json"].schema.$ref, "#/components/schemas/StringErrorResponse");
});

test("public OpenAPI mirror remains byte-identical to the canonical document", () => {
  assert.equal(fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8"), canonicalText);
});
