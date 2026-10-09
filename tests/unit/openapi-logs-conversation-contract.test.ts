import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  description?: string;
  "x-sensitive"?: boolean;
  type?: string | string[];
  default?: unknown;
  maximum?: number;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  allOf?: Schema[];
  items?: Schema;
};

type Operation = {
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name: string; required?: boolean; schema?: Schema }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<
    string,
    { description?: string; "x-sensitive"?: boolean; content?: Record<string, { schema?: Schema }> }
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

test("management log routes describe structured, legacy, and downloadable log shapes", () => {
  const consoleLogs = spec.paths["/api/logs/console"]?.get;
  assert.equal(
    responseSchema("/api/logs/console", "get")?.$ref,
    "#/components/schemas/ConsoleLogEntryList"
  );
  assert.deepEqual(
    consoleLogs?.parameters?.find((parameter) => parameter.name === "level")?.schema?.enum,
    undefined
  );
  assert.equal(
    consoleLogs?.parameters?.find((parameter) => parameter.name === "limit")?.schema?.maximum,
    2000
  );

  assert.equal(
    responseSchema("/api/logs/detail", "get")?.$ref,
    "#/components/schemas/RequestDetailLogListResponse"
  );
  assert.equal(
    spec.paths["/api/logs/detail"]?.post?.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RequestDetailCaptureUpdate"
  );
  assert.equal(
    responseSchema("/api/logs/export", "get")?.$ref,
    "#/components/schemas/LogExportResponse"
  );
});

test("persisted and in-memory call-log details distinguish the clientRequest compatibility alias", () => {
  assert.deepEqual(spec.components.schemas.CallLogPipelinePayloads.properties?.clientRequest.type, [
    "object",
    "null",
  ]);
  const persisted = spec.components.schemas.CallLogDetailResponse.allOf?.[1];
  assert.deepEqual(persisted?.required, ["requestBody", "responseBody", "active", "detailState"]);
  assert.equal(persisted?.properties?.active.const, false);
  assert.deepEqual(persisted?.properties?.detailState.enum, [
    "none",
    "ready",
    "missing",
    "corrupt",
    "legacy-inline",
  ]);
  assert.equal(
    responseSchema("/api/usage/call-logs/{id}", "get")?.$ref,
    "#/components/schemas/CallLogDetailResponse"
  );
});

test("sensitive log contracts describe raw detail, noLog, global capture, auth, and token scopes", () => {
  const detailGet = spec.paths["/api/logs/detail"]?.get;
  const detailPost = spec.paths["/api/logs/detail"]?.post;
  const callLogGet = spec.paths["/api/usage/call-logs/{id}"]?.get;
  for (const [name, operation] of [
    ["GET /api/logs/detail", detailGet],
    ["POST /api/logs/detail", detailPost],
    ["GET /api/usage/call-logs/{id}", callLogGet],
  ] as const) {
    assert.ok(operation, `${name} should be documented`);
    for (const scheme of [
      "BearerAuth",
      "ManagementAnthropicApiKeyAuth",
      "ManagementGoogleApiKeyAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
    ]) {
      assert.ok(
        operation.security?.some((alternative) => scheme in alternative),
        `${name} should document ${scheme}`
      );
    }
    assert.ok(
      operation.security?.some((alternative) => Object.keys(alternative).length === 0),
      `${name} can be anonymous when management authentication is disabled`
    );
    assert.match(operation.description ?? "", /unlocked deployment.*accessed anonymously/s);
  }

  assert.equal(detailGet?.responses?.["200"]?.["x-sensitive"], true);
  assert.match(detailGet?.description ?? "", /raw client prompts.*provider\/client responses/s);
  assert.match(detailGet?.description ?? "", /ENABLE_REQUEST_LOGS.*call_log_pipeline_enabled/s);
  assert.match(detailGet?.description ?? "", /diverge from actual chat pipeline capture/);
  assert.match(detailGet?.description ?? "", /`read` scope/);
  assert.match(detailPost?.description ?? "", /global.*across API keys and providers/s);
  assert.match(detailPost?.description ?? "", /`noLog` remain excluded/);
  assert.match(detailPost?.description ?? "", /OMNI_DIAGNOSTIC_OVERFLOW_ENABLED/);
  assert.match(detailPost?.description ?? "", /`write` scope/);

  const legacyRow = spec.components.schemas.RequestDetailLogRow.properties;
  for (const field of [
    "client_request",
    "translated_request",
    "provider_response",
    "client_response",
  ]) {
    assert.equal(legacyRow?.[field]["x-sensitive"], true, `${field} contains raw payloads`);
  }
  const callLogDetail = spec.components.schemas.CallLogDetailResponse.allOf?.[1];
  assert.equal(callLogGet?.responses?.["200"]?.["x-sensitive"], true);
  assert.equal(callLogDetail?.properties?.requestBody["x-sensitive"], true);
  assert.equal(callLogDetail?.properties?.responseBody["x-sensitive"], true);
  assert.equal(spec.components.schemas.CallLogPipelinePayloads["x-sensitive"], true);
  assert.match(callLogGet?.description ?? "", /raw client prompts.*provider requests\/responses/s);
  assert.match(callLogGet?.description ?? "", /`noLog` enabled/);
  assert.match(callLogGet?.description ?? "", /`read` scope/);
  assert.match(
    spec.components.schemas.ApiKey.properties?.noLog.description ?? "",
    /request and response bodies, pipeline diagnostics, and private diagnostic overflow/
  );

  const root = process.cwd();
  const toggleRoute = fs.readFileSync(path.join(root, "src/app/api/logs/detail/route.ts"), "utf8");
  const detailedLogs = fs.readFileSync(path.join(root, "src/lib/db/detailedLogs.ts"), "utf8");
  const chatCore = fs.readFileSync(path.join(root, "open-sse/handlers/chatCore.ts"), "utf8");
  const callLogs = fs.readFileSync(path.join(root, "src/lib/usage/callLogs.ts"), "utf8");
  const overflow = fs.readFileSync(path.join(root, "src/lib/usage/diagnosticOverflow.ts"), "utf8");
  assert.match(toggleRoute, /updateSettings\(\{ call_log_pipeline_enabled: enabled \}\)/);
  assert.match(toggleRoute, /detailedLogsEnabled: enabled/);
  assert.match(detailedLogs, /process\.env\.ENABLE_REQUEST_LOGS/);
  assert.match(chatCore, /settings\.call_log_pipeline_enabled === true/);
  assert.match(callLogs, /noLogEnabled \? null : entry\.requestBody/);
  assert.match(callLogs, /noLogEnabled\s*\?\s*null\s*:\s*\(entry\.pipelinePayloads/);
  assert.match(overflow, /process\.env\.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED !== "true"/);
});

test("conversation limits and turn counts describe the source semantics", () => {
  const list = spec.paths["/api/conversations"]?.get;
  assert.equal(
    list?.parameters?.find((parameter) => parameter.name === "limit")?.schema?.maximum,
    200
  );
  assert.match(
    spec.components.schemas.ConversationSummary.properties?.turnCount.description ?? "",
    /not the number of turn nodes/
  );
  assert.match(
    spec.paths["/api/conversations/{id}/tree"]?.get?.description ?? "",
    /afterSeq.*precedence/s
  );
  assert.match(
    spec.paths["/api/conversations/{id}/tree"]?.get?.description ?? "",
    /empty page rather than 404/
  );
});

test("private overflow routes document their category errors, auth failures, and file states", () => {
  const paths = [
    "/api/usage/diagnostic-overflow",
    "/api/usage/diagnostic-overflow/{traceId}",
    "/api/usage/diagnostic-overflow/{traceId}/client-request",
    "/api/usage/diagnostic-overflow/{traceId}/{attemptId}/{kind}",
  ];
  for (const pathTemplate of paths) {
    const get = spec.paths[pathTemplate]?.get;
    assert.ok(get?.security?.some((alternative) => "ManagementSessionAuth" in alternative));
    assert.ok(get?.security?.some((alternative) => "BearerAuth" in alternative));
    assert.ok(get?.security?.some((alternative) => "ManagementAnthropicApiKeyAuth" in alternative));
    assert.ok(get?.security?.some((alternative) => "ManagementGoogleApiKeyAuth" in alternative));
    assert.ok(get?.responses?.["401"]);
    assert.ok(get?.responses?.["403"]);
    assert.ok(get?.responses?.["503"]);
  }

  const list = spec.paths[paths[0]]?.get;
  assert.equal(
    list?.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/DiagnosticOverflowErrorResponse"
  );
  assert.equal(
    spec.paths[paths[1]]?.get?.responses?.["404"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/DiagnosticOverflowErrorResponse"
  );
  for (const pathTemplate of paths.slice(2)) {
    assert.equal(
      spec.paths[pathTemplate]?.get?.responses?.["404"]?.content?.["application/json"]?.schema
        ?.$ref,
      "#/components/schemas/DiagnosticOverflowFileMissingResponse"
    );
    assert.equal(
      spec.paths[pathTemplate]?.get?.responses?.["409"]?.content?.["application/json"]?.schema
        ?.$ref,
      "#/components/schemas/DiagnosticOverflowFileUnavailableResponse"
    );
  }
  for (const pathTemplate of paths) {
    const head = spec.paths[pathTemplate]?.head;
    assert.ok(head?.responses?.["405"]);
    assert.ok(head?.responses?.["401"]);
    assert.ok(head?.responses?.["403"]);
    assert.ok(head?.responses?.["503"]);
  }
});
