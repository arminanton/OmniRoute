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
  ["get", "/api/guardrails", ["200", "401", "403", "503"], "GuardrailsListResponse"],
  ["post", "/api/guardrails/test", ["200", "400", "401", "403", "503"], "GuardrailsTestResponse"],
  ["post", "/api/headroom/start", ["200", "400", "401", "403", "500", "503"], "HeadroomStartResponse"],
  ["get", "/api/headroom/status", ["200", "401", "403", "500", "503"], "HeadroomStatusResponse"],
  ["post", "/api/headroom/stop", ["200", "401", "403", "409", "500", "503"], "HeadroomStopSuccessResponse"],
  ["delete", "/api/intelligence/sync", ["200", "401", "403", "500", "503"], "IntelligenceSyncClearedResponse"],
  ["get", "/api/intelligence/sync", ["200", "401", "403", "500", "503"], "IntelligenceSyncStatusResponse"],
  ["post", "/api/intelligence/sync", ["200", "400", "401", "403", "500", "502", "503"], "IntelligenceSyncSuccessResponse"],
  ["get", "/api/issue-agent/runs", ["200", "401", "403", "503"], "IssueAgentStatusResponse"],
  ["post", "/api/issue-agent/runs", ["200", "400", "401", "403", "503", "504"], "IssueAgentRunResponse"],
  ["post", "/api/local/redis/start", ["200", "401", "403", "500", "503"], "LocalRedisStartResponse"],
  ["get", "/api/local/redis/status", ["200", "401", "403", "500", "503"], "LocalRedisStatusResponse"],
  ["post", "/api/local/redis/stop", ["200", "401", "403", "404", "500", "503"], "LocalRedisStopResponse"],
  ["get", "/api/mcp/sse", ["200", "400", "401", "403", "503"], null],
  ["post", "/api/mcp/sse", ["200", "400", "401", "403", "503"], "McpSseJsonRpcResponse"],
] as const;

test("all 15 selected operations have typed success contracts and exact declared statuses", () => {
  assert.equal(contracts.length, 15);
  for (const [method, pathname, statuses, schemaName] of contracts) {
    const op = operation(method, pathname);
    assert.deepEqual(Object.keys(op.responses).sort(), [...statuses].sort(), `${method.toUpperCase()} ${pathname}`);
    const response = op.responses["200"];
    assert.ok(response, `${method.toUpperCase()} ${pathname} has a 200 response`);
    if (pathname === "/api/mcp/sse" && method === "get") {
      assert.equal(response.content?.["text/event-stream"]?.schema?.type, "string");
      continue;
    }
    if (pathname === "/api/mcp/sse" && method === "post") {
      assert.equal(response.content?.["application/json"]?.schema?.$ref, "#/components/schemas/McpSseJsonRpcResponse");
      assert.equal(response.content?.["text/event-stream"]?.schema?.type, "string");
      continue;
    }
    assert.equal(
      response.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${schemaName}`,
      `${method.toUpperCase()} ${pathname}`,
    );
    assert.ok(spec.components.schemas[schemaName!], `Missing ${schemaName}`);
  }
});

test("management, LOCAL_ONLY, and MCP remote-bypass annotations remain unchanged", () => {
  for (const pathname of ["/api/guardrails", "/api/guardrails/test", "/api/intelligence/sync"]) {
    const verbs = pathname === "/api/intelligence/sync" ? ["get", "post", "delete"] : [pathname.endsWith("/test") ? "post" : "get"];
    for (const method of verbs) {
      const op = operation(method, pathname);
      assert.notDeepEqual(op.security, []);
      assert.ok(op.security.some((alternative: object) => Object.keys(alternative).length === 0));
      assert.equal(op["x-local-only"], undefined);
    }
  }
  assert.equal(operation("post", "/api/headroom/start")["x-local-only"], true);
  assert.equal(operation("post", "/api/headroom/stop")["x-local-only"], true);
  assert.equal(operation("get", "/api/headroom/status")["x-local-only"], undefined);
  for (const method of ["get", "post"]) {
    const issue = operation(method, "/api/issue-agent/runs");
    assert.equal(issue["x-local-only"], true);
    assert.ok(issue["x-authentication-branches"].some((branch: any) => /path-specific manage-scope bypass/.test(branch.when)));
  }
  for (const [method, pathname] of [["post", "/api/local/redis/start"], ["get", "/api/local/redis/status"], ["post", "/api/local/redis/stop"]]) {
    const local = operation(method, pathname);
    assert.equal(local["x-local-only"], true);
    assert.match(local.description, /spawn-capable/);
  }
  for (const method of ["get", "post"]) {
    const mcp = operation(method, "/api/mcp/sse");
    assert.equal(mcp["x-local-only"], true);
    assert.ok(mcp.security.some((alternative: any) => alternative.McpConnectApiKeyBearerAuth));
    assert.ok(mcp["x-authentication-branches"].some((branch: any) => /default MCP manage-scope bypass/.test(branch.when)));
  }
});

test("sensitive payloads and process/account identifiers are marked", () => {
  assert.equal(operation("post", "/api/guardrails/test").requestBody["x-sensitive"], true);
  assert.equal(operation("post", "/api/guardrails/test").responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.GuardrailExecutionResult["x-sensitive"], true);
  assert.equal(spec.components.schemas.HeadroomStatusResponse.properties.url["x-sensitive"], true);
  assert.equal(spec.components.schemas.HeadroomStatusResponse.properties.managedPid["x-sensitive"], true);
  assert.equal(operation("get", "/api/intelligence/sync").responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.IntelligenceSyncFailureResponse.properties.error["x-sensitive"], true);
  assert.equal(operation("post", "/api/issue-agent/runs").requestBody["x-sensitive"], true);
  assert.equal(operation("post", "/api/issue-agent/runs").responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.IssueAgentRunBase.properties.auditPath["x-sensitive"], true);
  assert.equal(operation("post", "/api/local/redis/start").responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.LocalRedisStartResponse.properties.stdout["x-sensitive"], true);
  assert.equal(operation("get", "/api/mcp/sse").responses["200"]["x-sensitive"], true);
  assert.equal(operation("post", "/api/mcp/sse").requestBody["x-sensitive"], true);
});

test("source-dependent response unions and error envelopes are represented", () => {
  assert.equal(operation("post", "/api/guardrails/test").responses["400"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  assert.equal(operation("post", "/api/headroom/start").responses["400"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorResponse");
  assert.equal(operation("post", "/api/intelligence/sync").requestBody.content["application/json"].schema.$ref, "#/components/schemas/IntelligenceSyncRequest");
  assert.equal(operation("post", "/api/intelligence/sync").responses["400"].content["application/json"].schema.$ref, "#/components/schemas/ValidationErrorResponse");
  assert.equal(operation("post", "/api/intelligence/sync").responses["500"].content["application/json"].schema.$ref, "#/components/schemas/StringErrorResponse");
  assert.equal(operation("post", "/api/intelligence/sync").responses["502"].content["application/json"].schema.$ref, "#/components/schemas/IntelligenceSyncFailureResponse");
  assert.equal(operation("post", "/api/headroom/stop").responses["409"].content["application/json"].schema.$ref, "#/components/schemas/HeadroomStopConflictResponse");
  assert.deepEqual(spec.components.schemas.IssueAgentRunResponse.oneOf.map((entry: any) => entry.$ref), [
    "#/components/schemas/IssueAgentDryRunResponse",
    "#/components/schemas/IssueAgentModelRunResponse",
  ]);
  assert.equal(operation("post", "/api/issue-agent/runs").responses["504"].content["application/json"].schema.$ref, "#/components/schemas/IssueAgentTimeoutResponse");
  assert.deepEqual(
    operation("post", "/api/issue-agent/runs").responses["400"].content["application/json"].schema.oneOf.map((entry: any) => entry.$ref),
    ["#/components/schemas/StringErrorResponse", "#/components/schemas/ValidationErrorResponse", "#/components/schemas/IssueAgentUnsupportedModeResponse"],
  );
  assert.deepEqual(
    operation("post", "/api/issue-agent/runs").responses["403"].content["application/json"].schema.oneOf.map((entry: any) => entry.$ref),
    ["#/components/schemas/ApiErrorResponse", "#/components/schemas/IssueAgentDisabledResponse"],
  );
  assert.equal(operation("post", "/api/local/redis/start").responses["500"].content["application/json"].schema.$ref, "#/components/schemas/LocalRedisRuntimeFailureResponse");
  assert.equal(operation("post", "/api/local/redis/stop").responses["500"].content["application/json"].schema.$ref, "#/components/schemas/LocalRedisRuntimeFailureResponse");
  assert.equal(operation("post", "/api/local/redis/stop").responses["404"].content["application/json"].schema.$ref, "#/components/schemas/LocalRedisNotRunningResponse");
  assert.equal(operation("get", "/api/mcp/sse").responses["400"].content["application/json"].schema.$ref, "#/components/schemas/StringErrorResponse");
});

test("public OpenAPI mirror remains byte-identical to the canonical document", () => {
  assert.equal(fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8"), canonicalText);
});
