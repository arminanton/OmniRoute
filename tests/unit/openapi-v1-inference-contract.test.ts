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

test("public inference contracts match route validation and auth error shapes", () => {
  const chat = openapi.paths["/api/v1/chat/completions"]?.post;
  const messages = openapi.paths["/api/v1/messages"]?.post;
  const responses = openapi.paths["/api/v1/responses"]?.post;
  assert.ok(chat && messages && responses);

  assert.deepEqual(openapi.components.schemas.ChatCompletionRequest.required, ["messages"]);
  assert.equal(openapi.components.schemas.ChatCompletionRequest.properties?.messages?.minItems, 1);
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
    ["/api/v1/embeddings", ["400", "401", "402", "403", "429", "500", "503", "default"]],
    ["/api/v1/multimodal-embeddings", ["400", "401", "402", "403", "429", "500", "503", "default"]],
    [
      "/api/v1/providers/{provider}/embeddings",
      ["400", "401", "402", "403", "429", "500", "503", "default"],
    ],
    ["/api/v1/rerank", ["400", "401", "403", "429", "500", "503", "default"]],
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
  for (const status of ["400", "401", "403", "429", "500", "503", "default"]) {
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
