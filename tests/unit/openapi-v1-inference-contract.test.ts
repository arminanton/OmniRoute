import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";
import {
  v1ClassifySchema,
  v1ModerationSchema,
  v1OcrSchema,
  v1RerankSchema,
  v1SegmentSchema,
} from "../../src/shared/validation/schemas/apiV1.ts";

type Schema = {
  $ref?: string;
  type?: string | string[];
  format?: string;
  const?: unknown;
  enum?: unknown[];
  maxLength?: number;
  maxItems?: number;
  minItems?: number;
  minLength?: number;
  pattern?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  anyOf?: Schema[];
  additionalProperties?: boolean | Schema;
  oneOf?: Schema[];
};

type OperationResponse = {
  $ref?: string;
  description?: string;
  headers?: Record<string, { $ref?: string; schema?: Schema }>;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  responses?: Record<string, OperationResponse>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: Schema;
  }>;
};

type Contract = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    headers: Record<string, { schema?: Schema }>;
    schemas: Record<string, Schema>;
    responses: Record<string, OperationResponse>;
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

test("search OpenAPI documents caller cancellation with the standard error envelope", () => {
  assert.equal(
    responseSchema("/api/v1/search", "post", "499").$ref,
    "#/components/schemas/ApiErrorResponse"
  );
});

test("music and video generation OpenAPI document cancellation and account admission errors", () => {
  for (const pathTemplate of ["/api/v1/music/generations", "/api/v1/videos/generations"]) {
    assert.equal(
      responseSchema(pathTemplate, "post", "499").$ref,
      "#/components/schemas/ApiErrorResponse",
      `${pathTemplate} documents caller cancellation`
    );
    assert.equal(
      responseSchema(pathTemplate, "post", "503").$ref,
      "#/components/schemas/ApiErrorResponse",
      `${pathTemplate} documents unavailable account admission`
    );
  }
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
  assert.equal(
    openapi.components.schemas.VideoGenerationRequest.properties?.timeout_ms?.type,
    "integer"
  );
  assert.equal(
    openapi.components.schemas.VideoGenerationRequest.properties?.timeout_ms?.minimum,
    1
  );
  assert.equal(
    openapi.components.schemas.VideoGenerationRequest.properties?.poll_interval_ms?.type,
    "integer"
  );
  assert.equal(
    openapi.components.schemas.VideoGenerationRequest.properties?.poll_interval_ms?.minimum,
    1
  );
  for (const alias of ["max_wait_ms", "maxWaitMs"]) {
    assert.equal(
      openapi.components.schemas.VideoGenerationRequest.properties?.[alias]?.type,
      "integer",
      `${alias} is a documented Vertex Veo timeout alias`
    );
    assert.equal(openapi.components.schemas.VideoGenerationRequest.properties?.[alias]?.minimum, 1);
    assert.match(
      openapi.components.schemas.VideoGenerationRequest.properties?.[alias]?.description ?? "",
      /Vertex Veo.*alias for `timeout_ms`/i
    );
  }

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

test("OCR OpenAPI matches the transformed result, model constraints, auth, and status contract", () => {
  const ocr = openapi.paths["/api/v1/ocr"]?.post;
  assert.ok(ocr);
  assert.match(ocr.description || "", /`\/v1\/ocr` is a supported alias/i);
  const model = requestSchema("/api/v1/ocr", "post").properties?.model;
  assert.equal(model?.minLength, 1);
  assert.equal(model?.maxLength, 200);
  assert.match(model?.description || "", /trimmed/i);

  const response = openapi.components.schemas.OcrResponse;
  assert.deepEqual(response.required, ["pages", "model"]);
  assert.deepEqual(response.properties?.pages?.items?.required, ["index", "markdown"]);
  assert.equal(response.properties?.pages?.items?.properties?.index?.minimum, 0);
  assert.equal(response.properties?.pages?.items?.properties?.markdown?.type, "string");
  assert.equal(response.properties?.usage_info?.type, "object");
  assert.equal(response.properties?.text, undefined);
  assert.equal(response.properties?.usage, undefined);

  const security = ocr.security || [];
  for (const name of [
    "BearerAuth",
    "ClientApiKeyAuth",
    "GoogleApiKeyAuth",
    "ManagementSessionAuth",
  ]) {
    assert.ok(
      security.some((requirement) => name in requirement),
      `${name} is accepted`
    );
  }
  assert.ok(security.some((requirement) => Object.keys(requirement).length === 0));

  const telemetryNames = [
    "X-OmniRoute-Cache-Hit",
    "X-OmniRoute-Decision",
    "X-OmniRoute-Latency-Ms",
    "X-OmniRoute-Model",
    "X-OmniRoute-Provider",
    "X-OmniRoute-Request-Id",
    "X-OmniRoute-Response-Cost",
    "X-OmniRoute-Tokens-In",
    "X-OmniRoute-Tokens-Out",
    "X-OmniRoute-Version",
  ];
  for (const name of telemetryNames) {
    assert.ok(ocr.responses?.["200"]?.headers?.[name]?.$ref, `OCR documents ${name}`);
  }

  assert.equal(ocr.responses?.["401"]?.$ref, "#/components/responses/InferenceUnauthorized");
  const resolveResponseSchema = (status: string) => {
    const declared = ocr.responses?.[status];
    assert.ok(declared, `OCR documents HTTP ${status}`);
    const responseComponent = declared.$ref
      ? openapi.components.responses[declared.$ref.split("/").at(-1)!]
      : declared;
    return responseComponent.content?.["application/json"]?.schema?.$ref;
  };
  for (const status of [
    "400",
    "401",
    "402",
    "403",
    "429",
    "499",
    "500",
    "502",
    "503",
    "504",
    "default",
  ]) {
    assert.equal(
      resolveResponseSchema(status),
      "#/components/schemas/ApiErrorResponse",
      `OCR HTTP ${status} has the runtime JSON error schema`
    );
  }
  assert.equal(
    resolveResponseSchema("499"),
    "#/components/schemas/ApiErrorResponse",
    "OCR cancellation returns the documented JSON error schema"
  );
});

test("web-fetch OpenAPI documents route auth alternatives and provider URL constraints", () => {
  const webFetch = openapi.paths["/api/v1/web/fetch"]?.post;
  assert.ok(webFetch);
  assert.match(webFetch.description || "", /`\/v1\/web\/fetch` is a supported alias/i);
  assert.match(webFetch.description || "", /does not enforce an HTTP\/HTTPS scheme/i);
  const security = webFetch.security || [];
  for (const name of [
    "BearerAuth",
    "ClientApiKeyAuth",
    "GoogleApiKeyAuth",
    "ManagementSessionAuth",
  ]) {
    assert.ok(
      security.some((requirement) => name in requirement),
      `${name} is accepted`
    );
  }
  assert.ok(security.some((requirement) => Object.keys(requirement).length === 0));
  const url = openapi.components.schemas.WebFetchRequest.properties?.url;
  assert.equal(url?.format, "uri");
  assert.match(url?.description || "", /does not enforce HTTP\/HTTPS/i);
  assert.equal(webFetch.responses?.["429"]?.$ref, "#/components/responses/RateLimited");
  assert.equal(
    webFetch.responses?.["499"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  assert.equal(webFetch.responses?.["503"]?.$ref, "#/components/responses/ServiceUnavailable");
  assert.equal(
    webFetch.responses?.default?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
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

test("public inference contracts match route validation and auth error shapes", () => {
  const chat = openapi.paths["/api/v1/chat/completions"]?.post;
  const messages = openapi.paths["/api/v1/messages"]?.post;
  const responses = openapi.paths["/api/v1/responses"]?.post;
  assert.ok(chat && messages && responses);

  assert.deepEqual(openapi.components.schemas.ChatCompletionRequest.required, ["messages"]);
  assert.equal(openapi.components.schemas.ChatCompletionRequest.properties?.messages?.minItems, 1);
  assert.deepEqual(openapi.components.schemas.ChatCompletionRequest.properties?.model?.type, [
    "string",
    "null",
  ]);
  assert.equal(
    chat.parameters?.find((parameter) => parameter.name === "X-Route-Model")?.in,
    "header"
  );
  assert.match(
    chat.parameters?.find((parameter) => parameter.name === "X-Route-Model")?.description ?? "",
    /either this header or the request body/i
  );
  assert.equal(
    openapi.components.schemas.ChatCompletionRequest.properties?.model?.description?.includes(
      "X-Route-Model"
    ),
    true
  );

  assert.equal(openapi.components.schemas.MessagesRequest.properties?.messages?.minItems, 1);
  const responsesRequest = openapi.components.schemas.ResponsesRequest;
  assert.deepEqual(
    responsesRequest.anyOf?.map((alternative) => alternative.required),
    [["input"], ["messages"]]
  );
  assert.equal(responsesRequest.properties?.messages?.minItems, 1);

  for (const [name, operation] of [
    ["chat", chat],
    ["messages", messages],
    ["responses", responses],
  ] as const) {
    assert.ok(operation.responses?.["400"], `${name} documents HTTP 400`);
    assert.equal(
      operation.responses?.["401"]?.$ref,
      "#/components/responses/InferenceUnauthorized",
      `${name} uses the inference auth response`
    );
  }
  assert.ok(chat.responses?.["415"], "chat documents its JSON content-type rejection");
  assert.ok(messages.responses?.["415"], "messages documents its JSON content-type rejection");
  assert.ok(chat.responses?.["413"], "chat documents body/admission byte-limit rejection");
  assert.equal(
    chat.responses?.["502"]?.$ref,
    "#/components/responses/InferenceProviderError",
    "chat documents the JSON body returned for upstream failure"
  );
  assert.ok(
    responses.responses?.["413"],
    "responses documents body/admission byte-limit rejection"
  );
  assert.equal(
    responses.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse",
    "responses documents the prompt-injection guard's string error body"
  );
  for (const status of ["502", "504"]) {
    assert.equal(
      responses.responses?.[status]?.$ref,
      "#/components/responses/InferenceProviderError",
      `responses documents the shared chat handler's HTTP ${status} JSON error`
    );
  }
  const providerChat = openapi.paths["/api/v1/providers/{provider}/chat/completions"]?.post;
  assert.ok(
    providerChat?.responses?.["400"],
    "provider-scoped chat documents provider/model mismatch"
  );
  const providerRouteModel = providerChat?.parameters?.find(
    (parameter) => parameter.name === "X-Route-Model"
  );
  assert.equal(providerRouteModel?.in, "header");
  assert.match(providerRouteModel?.description ?? "", /provider named in the path/i);
  assert.equal(
    openapi.components.responses.InferenceUnauthorized?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  assert.equal(openapi.components.schemas.ApiErrorResponse.properties?.error?.type, "object");

  const readSource = (...parts: string[]) =>
    fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
  const chatHandler = readSource("src", "sse", "handlers", "chat.ts");
  const chatRoute = readSource("src", "app", "api", "v1", "chat", "completions", "route.ts");
  const responsesRoute = readSource("src", "app", "api", "v1", "responses", "route.ts");
  const messagesRoute = readSource("src", "app", "api", "v1", "messages", "route.ts");
  const jsonContentType = readSource("src", "shared", "middleware", "requireJsonContentType.ts");
  const routingModel = readSource("src", "sse", "handlers", "resolveRoutingModel.ts");
  const authzPipeline = readSource("src", "server", "authz", "pipeline.ts");
  assert.match(chatHandler, /msgBody\.messages\.length === 0/);
  assert.match(chatHandler, /!\("messages" in msgBody\) && !\("input" in msgBody\)/);
  assert.match(chatRoute, /status: 415/);
  assert.match(messagesRoute, /requireJsonContentType\(request\)/);
  assert.match(jsonContentType, /status: 415/);
  assert.match(responsesRoute, /Invalid JSON body/);
  assert.match(routingModel, /return headerModel \|\| body\.model/);
  assert.match(authzPipeline, /error:\s*\{\s*code: outcome\.code,\s*message: outcome\.message,/);
});

test("shared model-catalog routes document their auth and catalog-readiness outcomes", () => {
  const rootCatalog = openapi.paths["/api/v1"]?.get;
  assert.ok(rootCatalog);
  const rootSchemes = new Set(
    rootCatalog.security?.flatMap((requirement) => Object.keys(requirement))
  );
  assert.ok(rootSchemes.has("ClientApiKeyAuth"));
  assert.ok(rootSchemes.has("GoogleApiKeyAuth"));
  assert.equal(rootCatalog.responses?.["500"]?.$ref, "#/components/responses/InternalError");
  assert.equal(rootCatalog.responses?.["503"]?.$ref, "#/components/responses/ServiceUnavailable");

  const catalogPaths = [
    "/api/v1/models",
    "/api/v1/embeddings",
    "/api/v1/multimodal-embeddings",
    "/api/v1/images/generations",
    "/api/v1/music/generations",
    "/api/v1/videos/generations",
    "/api/v1/vscode/{token}/models",
  ];
  for (const pathTemplate of catalogPaths) {
    const operation = openapi.paths[pathTemplate]?.get;
    assert.ok(operation, `GET ${pathTemplate} exists`);
    assert.equal(
      operation.responses?.["500"]?.$ref,
      "#/components/responses/InternalError",
      `GET ${pathTemplate} documents unexpected catalog failures`
    );
    assert.equal(
      operation.responses?.["503"]?.$ref,
      "#/components/responses/ServiceUnavailable",
      `GET ${pathTemplate} documents catalog readiness timeouts`
    );
  }

  assert.equal(
    openapi.paths["/api/v1/models/{model}"]?.get?.responses?.["500"]?.$ref,
    "#/components/responses/InternalError"
  );
  assert.equal(
    openapi.paths["/api/v1/models/{model}"]?.get?.responses?.["503"]?.$ref,
    "#/components/responses/ServiceUnavailable"
  );
});

test("chat-admission routes document payload limits and shared provider failures", () => {
  const admissionPaths = [
    "/api/v1/messages",
    "/api/v1/completions",
    "/api/v1/api/chat",
    "/api/v1/providers/{provider}/chat/completions",
    "/api/v1/responses/{path}",
  ];
  for (const pathTemplate of admissionPaths) {
    const operation = openapi.paths[pathTemplate]?.post;
    assert.ok(operation, `POST ${pathTemplate} exists`);
    assert.equal(
      operation.responses?.["413"]?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/ApiErrorResponse",
      `POST ${pathTemplate} documents the shared chat body-limit rejection`
    );
  }

  const providerErrorPaths = [
    "/api/v1/providers/{provider}/chat/completions",
    "/api/v1/messages",
    "/api/v1/completions",
    "/api/v1/responses/{path}",
  ];
  for (const pathTemplate of providerErrorPaths) {
    const operation = openapi.paths[pathTemplate]?.post;
    for (const status of ["502", "504"]) {
      assert.equal(
        operation?.responses?.[status]?.$ref,
        "#/components/responses/InferenceProviderError",
        `POST ${pathTemplate} documents shared chat HTTP ${status}`
      );
    }
  }
  assert.equal(
    openapi.paths["/api/v1/chat/completions"]?.post?.responses?.["504"]?.$ref,
    "#/components/responses/InferenceProviderError"
  );
});

test("count-tokens documents both source error-envelope forms", () => {
  const schema =
    openapi.paths["/api/v1/messages/count_tokens"]?.post?.responses?.["400"]?.content?.[
      "application/json"
    ]?.schema;
  assert.deepEqual(
    schema?.oneOf?.map((alternative) => alternative.$ref),
    ["#/components/schemas/StringErrorResponse", "#/components/schemas/ValidationErrorResponse"]
  );
});

test("OCR, classify, and segment schemas reject blank text like their validators", () => {
  const ocr = requestSchema("/api/v1/ocr", "post");
  const document = ocr.properties?.document;
  const documentString = document?.oneOf?.find((branch) => branch.type === "string");
  const documentObject = document?.oneOf?.find((branch) => branch.type === "object");
  assert.equal(documentString?.pattern, "\\S");
  assert.equal(documentObject?.properties?.type?.pattern, "\\S");
  assert.equal(documentObject?.properties?.document_url?.pattern, "\\S");
  assert.equal(
    documentObject?.properties?.image_url?.oneOf?.find((branch) => branch.type === "string")
      ?.pattern,
    "\\S"
  );
  assert.equal(ocr.properties?.model?.pattern, "\\S");
  assert.equal(v1OcrSchema.safeParse({ document: "   " }).success, false);
  assert.equal(v1OcrSchema.safeParse({ document: { document_url: "   " } }).success, false);

  const classify = requestSchema("/api/v1/classify", "post");
  assert.equal(classify.properties?.model?.pattern, "\\S");
  assert.equal(classify.properties?.classifier_id?.pattern, "\\S");
  assert.equal(
    classify.properties?.input?.oneOf?.find((branch) => branch.type === "string")?.pattern,
    "\\S"
  );
  assert.equal(classify.properties?.labels?.items?.pattern, "\\S");
  assert.equal(v1ClassifySchema.safeParse({ input: "   " }).success, false);
  assert.equal(v1ClassifySchema.safeParse({ input: "text", labels: ["   "] }).success, false);

  const segment = requestSchema("/api/v1/segment", "post");
  assert.equal(segment.properties?.content?.pattern, "\\S");
  assert.equal(segment.properties?.tokenizer?.pattern, "\\S");
  assert.equal(v1SegmentSchema.safeParse({ content: "   " }).success, false);
  assert.equal(v1SegmentSchema.safeParse({ content: "text", tokenizer: "   " }).success, false);
});

test("provider-scoped model catalog documents supported credentials and catalog failures", () => {
  const operation = openapi.paths["/api/v1/providers/{provider}/models"]?.get;
  assert.ok(operation);
  const schemes = new Set(operation.security?.flatMap((requirement) => Object.keys(requirement)));
  assert.ok(schemes.has("ClientApiKeyAuth"), "x-api-key is accepted by the model catalog");
  assert.ok(schemes.has("GoogleApiKeyAuth"), "x-goog-api-key is accepted by the model catalog");
  assert.equal(operation.responses?.["500"]?.$ref, "#/components/responses/InternalError");
  assert.equal(operation.responses?.["503"]?.$ref, "#/components/responses/ServiceUnavailable");
});

test("moderation and rerank schemas match documented non-empty input constraints", () => {
  const moderationInput = requestSchema("/api/v1/moderations", "post").properties?.input;
  const moderationString = moderationInput?.oneOf?.find((branch) => branch.type === "string");
  const moderationArray = moderationInput?.oneOf?.find((branch) => branch.type === "array");
  assert.equal(moderationString?.minLength, 1);
  assert.equal(moderationString?.pattern, "\\S");
  assert.equal(moderationArray?.minItems, 1);

  assert.equal(v1ModerationSchema.safeParse({ input: "" }).success, false);
  assert.equal(v1ModerationSchema.safeParse({ input: "   " }).success, false);
  assert.equal(v1ModerationSchema.safeParse({ input: [] }).success, false);
  assert.equal(v1ModerationSchema.safeParse({ input: "hello" }).success, true);
  assert.equal(v1ModerationSchema.safeParse({ input: ["hello"] }).success, true);

  const rerankRequest = requestSchema("/api/v1/rerank", "post");
  assert.equal(rerankRequest.properties?.top_n?.minimum, 1);
  const validRerank = { model: "cohere/rerank-v3.5", query: "q", documents: ["d"] };
  assert.equal(v1RerankSchema.safeParse({ ...validRerank, top_n: 1 }).success, true);
  for (const topN of [0, -1, 1.5, "2"]) {
    assert.equal(v1RerankSchema.safeParse({ ...validRerank, top_n: topN }).success, false);
  }
});

test("embedding OpenAPI input includes the native Jina and Gemini forms accepted by validation", () => {
  const request = openapi.components.schemas.EmbeddingCreateRequest;
  assert.deepEqual(request.required, ["input", "model"]);
  assert.equal(request.properties?.input?.$ref, "#/components/schemas/EmbeddingInput");
  assert.equal(request.properties?.dimensions?.oneOf?.[0]?.minimum, 1);
  assert.equal(request.properties?.dimensions?.oneOf?.[1]?.type, "string");
  assert.deepEqual(request.properties?.encoding_format?.enum, ["float", "base64"]);

  const input = openapi.components.schemas.EmbeddingInput;
  assert.ok(
    input.anyOf?.some((branch) => branch.$ref === "#/components/schemas/JinaNativeEmbeddingItem"),
    "top-level native Jina items are described"
  );
  assert.ok(
    input.anyOf?.some((branch) => branch.$ref === "#/components/schemas/GeminiNativeEmbeddingItem"),
    "top-level native Gemini items are described"
  );
  assert.ok(
    input.anyOf?.some(
      (branch) =>
        branch.type === "array" &&
        branch.items?.anyOf?.some(
          (item) => item.$ref === "#/components/schemas/JinaNativeEmbeddingItem"
        ) &&
        branch.items?.anyOf?.some(
          (item) => item.$ref === "#/components/schemas/GeminiNativeEmbeddingItem"
        )
    ),
    "mixed native multimodal batches are described"
  );

  const jina = openapi.components.schemas.JinaNativeEmbeddingItem;
  assert.ok(
    jina.anyOf?.some(
      (branch) => branch.$ref === "#/components/schemas/JinaNativeEmbeddingDocument"
    ),
    "native Jina documents are described"
  );
  assert.ok(
    jina.anyOf?.some(
      (branch) => branch.$ref === "#/components/schemas/JinaNativeEmbeddingContentGroup"
    ),
    "Jina merged content groups are described"
  );
  assert.ok(
    openapi.components.schemas.JinaNativeEmbeddingDocument.oneOf?.some((branch) =>
      branch.required?.includes("image")
    ),
    "Jina image documents are described"
  );
  const gemini = openapi.components.schemas.GeminiNativeEmbeddingItem;
  assert.ok(
    gemini.anyOf?.some((branch) => branch.required?.includes("parts")) &&
      gemini.anyOf?.some((branch) => branch.required?.includes("content")),
    "Gemini Content/parts and EmbedContentRequest forms are described"
  );

  for (const pathname of ["/api/v1/embeddings", "/api/v1/multimodal-embeddings"]) {
    assert.equal(
      openapi.paths[pathname]?.post?.requestBody?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/EmbeddingCreateRequest",
      `${pathname} uses the full shared request contract`
    );
    assert.ok(openapi.paths[pathname]?.get?.responses?.["401"]);
    assert.ok(openapi.paths[pathname]?.get?.responses?.["503"]);
  }

  const validationSource = fs.readFileSync(
    path.join(process.cwd(), "src/shared/validation/schemas/apiV1.ts"),
    "utf8"
  );
  assert.match(
    validationSource,
    /jinaNativeDocSchema,[\s\S]*?jinaMergedContentGroupSchema,[\s\S]*?geminiNativeItemSchema/
  );
});

test("embedding POST auth alternatives and provider-specific request shape match handlers", () => {
  const base = openapi.paths["/api/v1/embeddings"]?.post;
  const alias = openapi.paths["/api/v1/multimodal-embeddings"]?.post;
  const provider = openapi.paths["/api/v1/providers/{provider}/embeddings"]?.post;
  assert.ok(base && alias && provider);

  for (const [pathname, operation] of [
    ["/api/v1/embeddings", base],
    ["/api/v1/multimodal-embeddings", alias],
  ] as const) {
    assert.ok(
      !operation.security?.some((alternative) => "ManagementSessionAuth" in alternative),
      `${pathname} must not advertise dashboard-session auth while the shared handler requires an API key when enabled`
    );
  }
  assert.equal(
    provider.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/EmbeddingCreateRequest"
  );

  const baseRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/v1/embeddings/route.ts"),
    "utf8"
  );
  const aliasRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/v1/multimodal-embeddings/route.ts"),
    "utf8"
  );
  const providerRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/v1/providers/[provider]/embeddings/route.ts"),
    "utf8"
  );
  assert.match(baseRoute, /if \(isRequireApiKeyEnabled\(\) && !apiKeyRaw\)/);
  assert.match(aliasRoute, /export \{ GET, POST, OPTIONS \} from "\.\.\/embeddings\/route"/);
  assert.match(providerRoute, /validateBody\(v1EmbeddingsSchema, rawBody\)/);
  assert.match(providerRoute, /JSON\.stringify\(\{ error: result\.error \}\)/);
  assert.ok(
    provider.security?.some((alternative) => "ManagementSessionAuth" in alternative),
    "provider-specific embeddings permits dashboard sessions through CLIENT_API middleware"
  );

  const routeClassifier = fs.readFileSync(
    path.join(process.cwd(), "src/server/authz/classify.ts"),
    "utf8"
  );
  const clientApiPolicy = fs.readFileSync(
    path.join(process.cwd(), "src/server/authz/policies/clientApi.ts"),
    "utf8"
  );
  const embeddingHandler = fs.readFileSync(
    path.join(process.cwd(), "open-sse/handlers/embeddings.ts"),
    "utf8"
  );
  assert.match(routeClassifier, /normalizedPath\.startsWith\("\/api\/v1\/"\)/);
  assert.match(
    clientApiPolicy,
    /isDashboardSessionAuthenticated\(ctx\.request\)[\s\S]*?allow\(\{ kind: "dashboard_session"/
  );
  assert.match(embeddingHandler, /interface EmbeddingFailure\s*\{[\s\S]*?error: string/);
});

test("specialty inference operations document route and upstream error responses", () => {
  const errorRoutes = [
    ["/api/v1/embeddings", ["400", "401", "402", "403", "429", "499", "500", "503", "default"]],
    [
      "/api/v1/multimodal-embeddings",
      ["400", "401", "402", "403", "429", "499", "500", "503", "default"],
    ],
    [
      "/api/v1/providers/{provider}/embeddings",
      ["400", "401", "402", "403", "429", "499", "500", "503", "default"],
    ],
    ["/api/v1/rerank", ["400", "401", "403", "429", "499", "500", "503", "default"]],
    [
      "/api/v1/providers/{provider}/images/generations",
      ["400", "401", "403", "410", "413", "429", "499", "500", "503", "default"],
    ],
    ["/api/v1/images/edits", ["400", "401", "403", "410", "413", "429", "500", "503", "default"]],
  ] as const;

  for (const [pathname, statuses] of errorRoutes) {
    const operation = openapi.paths[pathname]?.post;
    assert.ok(operation, `POST ${pathname} exists`);
    for (const status of statuses) {
      assert.ok(operation.responses?.[status], `POST ${pathname} documents ${status}`);
    }
  }
  for (const pathname of ["/api/v1/embeddings", "/api/v1/multimodal-embeddings"]) {
    assert.equal(
      openapi.paths[pathname]?.post?.responses?.["429"]?.$ref,
      "#/components/responses/RateLimited"
    );
  }
  assert.equal(
    openapi.components.responses.InferenceProviderError?.content?.["application/json"]?.schema
      ?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  assert.equal(
    openapi.components.responses.InferenceForbidden?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  const providerEmbeddingOperation = openapi.paths["/api/v1/providers/{provider}/embeddings"]?.post;
  assert.ok(providerEmbeddingOperation);
  for (const status of ["400", "401", "403", "429", "499", "500", "503", "default"]) {
    assert.equal(
      providerEmbeddingOperation.responses?.[status]?.$ref,
      "#/components/responses/ProviderEmbeddingError",
      `provider-specific embedding HTTP ${status} documents both runtime error forms`
    );
  }
  assert.equal(
    providerEmbeddingOperation.responses?.["402"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderEmbeddingErrorBody"
  );
  const providerEmbeddingErrorSchema = openapi.components.schemas.ProviderEmbeddingErrorBody.oneOf;
  assert.ok(
    providerEmbeddingErrorSchema?.some(
      (branch) => branch.$ref === "#/components/schemas/ApiErrorResponse"
    )
  );
  assert.ok(
    providerEmbeddingErrorSchema?.some((branch) => branch.properties?.error?.type === "string"),
    "the provider route's `{ error: string }` response is represented"
  );

  const rerankRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/v1/rerank/route.ts"),
    "utf8"
  );
  const imageEditRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/v1/images/edits/route.ts"),
    "utf8"
  );
  const embeddingService = fs.readFileSync(
    path.join(process.cwd(), "src/lib/embeddings/service.ts"),
    "utf8"
  );
  assert.match(rerankRoute, /HTTP_STATUS\.BAD_REQUEST/);
  assert.match(rerankRoute, /rateLimitedProviderResponse\(/);
  assert.match(rerankRoute, /return errorResponse\(500/);
  assert.match(imageEditRoute, /return errorResponse\([\s\S]*?\n\s*413,/);
  assert.match(imageEditRoute, /HTTP_STATUS\.GONE/);
  assert.match(imageEditRoute, /HTTP_STATUS\.RATE_LIMITED/);
  assert.match(embeddingService, /HTTP_STATUS\.PAYMENT_REQUIRED/);
  assert.match(embeddingService, /HTTP_STATUS\.RATE_LIMITED/);
});

test("shared OpenAI-compatible model rows declare their Unix creation timestamp", () => {
  const created = openapi.components.schemas.Model.properties?.created;
  assert.equal(created?.type, "integer");
  assert.equal(created?.format, "int64");
});

test("remaining media contracts describe inputs, auth, failures, catalog fields, and telemetry", () => {
  const imageRequest = openapi.components.schemas.ImageGenerationRequest;
  for (const property of ["image", "image_url", "imageUrls", "image_urls"]) {
    assert.ok(imageRequest.properties?.[property], `image generation describes ${property}`);
  }

  const upscaleCatalog = openapi.paths["/api/v1/images/upscale"]?.get;
  assert.ok(upscaleCatalog);
  assert.equal(
    responseSchema("/api/v1/images/upscale", "get").$ref,
    "#/components/schemas/ImageUpscaleModelListResponse"
  );
  const upscaleModel = openapi.components.schemas.ImageUpscaleModel;
  for (const property of ["factors", "supports_creativity", "supports_prompt", "prompt_required"]) {
    assert.ok(upscaleModel.properties?.[property], `upscale catalog describes ${property}`);
  }

  const catalogRoutes = [
    "/api/v1/images/generations",
    "/api/v1/images/upscale",
    "/api/v1/music/generations",
    "/api/v1/videos/generations",
  ];
  for (const pathname of catalogRoutes) {
    const get = openapi.paths[pathname]?.get;
    assert.ok(get, `GET ${pathname} exists`);
    assert.ok(
      get.security?.some((alternative) => "ClientApiKeyAuth" in alternative),
      `${pathname} documents x-api-key auth`
    );
    assert.ok(
      get.security?.some((alternative) => "GoogleApiKeyAuth" in alternative),
      `${pathname} documents x-goog-api-key auth`
    );
    assert.ok(get.responses?.["401"], `${pathname} documents auth rejection`);
    assert.ok(get.responses?.["503"], `${pathname} documents unavailability`);
  }

  const mediaErrorStatuses = [
    ["/api/v1/images/generations", ["400", "401", "403", "410", "429", "503", "default"]],
    ["/api/v1/images/upscale", ["400", "401", "403", "429", "503", "default"]],
    ["/api/v1/audio/speech", ["400", "401", "403", "429", "500", "503", "default"]],
    [
      "/api/v1/audio/transcriptions",
      ["400", "401", "403", "413", "429", "499", "500", "503", "default"],
    ],
    ["/api/v1/audio/translations", ["400", "401", "403", "413", "429", "500", "503", "default"]],
  ] as const;
  for (const [pathname, statuses] of mediaErrorStatuses) {
    const post = openapi.paths[pathname]?.post;
    assert.ok(post, `POST ${pathname} exists`);
    for (const status of statuses) {
      assert.ok(post.responses?.[status], `POST ${pathname} documents ${status}`);
    }
  }
  assert.match(
    openapi.paths["/api/v1/audio/transcriptions"]?.post?.responses?.["413"]?.description ?? "",
    /fixed 100 MiB actual-body limit/i
  );
  assert.match(
    openapi.paths["/api/v1/images/edits"]?.post?.responses?.["413"]?.description ?? "",
    /does not impose an image-edit request-body size cap/i
  );

  const telemetryNames = [
    "X-OmniRoute-Cache-Hit",
    "X-OmniRoute-Decision",
    "X-OmniRoute-Latency-Ms",
    "X-OmniRoute-Model",
    "X-OmniRoute-Provider",
    "X-OmniRoute-Request-Id",
    "X-OmniRoute-Response-Cost",
    "X-OmniRoute-Tokens-In",
    "X-OmniRoute-Tokens-Out",
    "X-OmniRoute-Version",
  ];
  const mediaOperations = [
    ["/api/v1/images/generations", "post"],
    ["/api/v1/images/upscale", "post"],
    ["/api/v1/audio/speech", "post"],
    ["/api/v1/audio/transcriptions", "post"],
    ["/api/v1/audio/translations", "post"],
    ["/api/v1/ocr", "post"],
    ["/api/v1/music/generations", "post"],
    ["/api/v1/videos/generations", "post"],
  ] as const;
  for (const [pathname, method] of mediaOperations) {
    const headers = openapi.paths[pathname]?.[method]?.responses?.["200"]?.headers;
    assert.ok(headers, `${method.toUpperCase()} ${pathname} documents telemetry headers`);
    for (const name of telemetryNames) {
      assert.ok(headers[name]?.$ref, `${pathname} documents ${name}`);
    }
  }
  for (const pathname of [
    "/api/v1/images/generations",
    "/api/v1/audio/speech",
    "/api/v1/videos/generations",
  ]) {
    assert.ok(
      openapi.paths[pathname]?.post?.responses?.["200"]?.headers?.["X-OmniRoute-Fallback-Attempts"]
        ?.$ref,
      `${pathname} combo responses can report fallback attempts`
    );
  }

  const translationRequest =
    openapi.paths["/api/v1/audio/translations"]?.post?.requestBody?.content?.["multipart/form-data"]
      ?.schema;
  assert.ok(translationRequest?.properties?.response_format?.enum?.includes("verbose_json"));

  const read = (...parts: string[]) => fs.readFileSync(path.join(process.cwd(), ...parts), "utf8");
  const imageRoute = read("src/app/api/v1/images/generations/route.ts");
  const upscaleRoute = read("src/app/api/v1/images/upscale/route.ts");
  const speechRoute = read("src/app/api/v1/audio/speech/route.ts");
  const transcriptionRoute = read("src/app/api/v1/audio/transcriptions/route.ts");
  const translationRoute = read("src/app/api/v1/audio/translations/route.ts");
  const translationHandler = read("open-sse/handlers/audioTranslation.ts");
  const mediaRouteHelper = read("src/app/api/v1/_shared/mediaGenerationRoute.ts");
  assert.match(imageRoute, /body\.image_url|body\.imageUrls|body\.image_urls/);
  assert.match(upscaleRoute, /supports_creativity|prompt_required/);
  for (const [source, name] of [
    [imageRoute, "image generation"],
    [upscaleRoute, "upscale"],
    [speechRoute, "speech"],
    [transcriptionRoute, "transcription"],
    [translationRoute, "translation"],
    [mediaRouteHelper, "music/video"],
  ] as const) {
    assert.ok(source.includes("attachOmniRouteMeta"), `${name} attaches metadata headers`);
  }
  assert.match(translationRoute, /policy\.rejection/);
  assert.match(translationHandler, /\["prompt", "response_format", "temperature"\]/);
});
