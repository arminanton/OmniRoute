import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  description?: string;
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
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
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
      "#/components/schemas/DiagnosticOverflowFileUnavailableResponse"
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
