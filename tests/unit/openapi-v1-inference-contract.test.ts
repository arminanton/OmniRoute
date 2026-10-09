import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  maxLength?: number;
  maxItems?: number;
  minLength?: number;
  pattern?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
};

type Operation = {
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema }>;
};

type Contract = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    responses: Record<string, { content?: Record<string, { schema?: Schema }> }>;
  };
};

const openapi = yaml.load(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")
) as Contract;

function responseSchema(pathTemplate: string, method: string, status = "200"): Schema {
  const schema =
    openapi.paths[pathTemplate]?.[method]?.responses?.[status]?.content?.["application/json"]
      ?.schema;
  assert.ok(schema, `${method.toUpperCase()} ${pathTemplate} ${status} response is typed`);
  return schema;
}

function requestSchema(pathTemplate: string, method: string): Schema {
  const schema =
    openapi.paths[pathTemplate]?.[method]?.requestBody?.content?.["application/json"]?.schema;
  assert.ok(schema, `${method.toUpperCase()} ${pathTemplate} request body is typed`);
  return schema;
}

function assertRef(schema: Schema, target: string): void {
  assert.equal(schema.$ref, `#/components/schemas/${target}`);
  assert.ok(openapi.components.schemas[target], `schema ${target} exists`);
}

test("versioned inference and media endpoints use source-backed success schemas", () => {
  assertRef(responseSchema("/api/v1/issues/report", "post", "200"), "V1IssueReportCreatedResponse");
  assertRef(
    responseSchema("/api/v1/issues/report", "post", "202"),
    "V1IssueReportAcceptedResponse"
  );
  assertRef(
    responseSchema("/api/v1/issues/report", "post", "207"),
    "V1IssueReportPartialFailureResponse"
  );
  assertRef(responseSchema("/api/v1/music/generations", "get"), "ModelListResponse");
  assertRef(responseSchema("/api/v1/music/generations", "post"), "MediaGenerationResponse");
  assertRef(responseSchema("/api/v1/search/analytics", "get"), "SearchAnalyticsResponse");
  assertRef(responseSchema("/api/v1/video-bridge/drilldown", "get"), "VideoBridgeDrilldownPage");
  assertRef(
    responseSchema("/api/v1/video-bridge/drilldown", "delete"),
    "VideoBridgeDrilldownDeleteResponse"
  );
  assertRef(responseSchema("/api/v1/videos/generations", "get"), "ModelListResponse");
  assertRef(responseSchema("/api/v1/videos/generations", "post"), "MediaGenerationResponse");
  assertRef(responseSchema("/api/v1/web/fetch", "post"), "WebFetchResponse");
});

test("versioned inference request schemas preserve route validation constraints", () => {
  const issue = openapi.components.schemas.V1IssueReportRequest;
  assert.deepEqual(issue.required, ["title"]);
  assert.equal(issue.properties?.title?.minLength, 1);
  assert.equal(issue.properties?.title?.maxLength, 300);

  const music = requestSchema("/api/v1/music/generations", "post");
  assertRef(music, "MusicGenerationRequest");
  assert.deepEqual(openapi.components.schemas.MusicGenerationRequest.required, ["model", "prompt"]);

  const video = requestSchema("/api/v1/videos/generations", "post");
  assertRef(video, "VideoGenerationRequest");
  assert.deepEqual(openapi.components.schemas.VideoGenerationRequest.required, ["model"]);

  const webFetch = requestSchema("/api/v1/web/fetch", "post");
  assertRef(webFetch, "WebFetchRequest");
  assert.deepEqual(openapi.components.schemas.WebFetchRequest.required, ["url"]);
  assert.deepEqual(openapi.components.schemas.WebFetchRequest.properties?.provider?.enum, [
    "firecrawl",
    "jina-reader",
    "tavily-search",
    "tinyfish",
    "context7",
    "nimble-search",
    "anysearch-search",
  ]);
});

test("analytics and Video Bridge contracts include required runtime response fields", () => {
  const analytics = openapi.components.schemas.SearchAnalyticsResponse;
  assert.deepEqual(analytics.required, [
    "total",
    "today",
    "cached",
    "errors",
    "totalCostUsd",
    "byProvider",
    "cacheHitRate",
    "avgDurationMs",
    "last24h",
  ]);
  assert.equal(analytics.properties?.last24h?.maxItems, 0);

  const page = openapi.components.schemas.VideoBridgeDrilldownPage;
  assert.deepEqual(page.required, [
    "derivation",
    "durationSeconds",
    "frames",
    "hasMore",
    "page",
    "variant",
  ]);
  assert.deepEqual(page.properties?.variant?.enum, ["preview", "standard", "detail"]);
  const getOperation = openapi.paths["/api/v1/video-bridge/drilldown"]?.get;
  assert.ok(getOperation);
  assert.equal(
    getOperation.parameters?.find((parameter) => parameter.name === "handle")?.required,
    true
  );
  assert.ok(openapi.components.responses.RateLimited);
});
