import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const specPath = path.join(process.cwd(), "docs", "openapi.yaml");
type OpenApiMedia = { schema: Record<string, unknown>; [key: string]: unknown };
type OpenApiResponse = { content?: Record<string, OpenApiMedia> };
type OpenApiOperation = {
  responses?: Record<string, OpenApiResponse>;
  parameters?: unknown[];
  requestBody?: { content?: Record<string, OpenApiMedia> };
  security?: Array<Record<string, unknown>>;
};
type OpenApiSpec = {
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
};
const spec = yaml.load(fs.readFileSync(specPath, "utf8")) as OpenApiSpec;

function operation(pathname: string, method: string): OpenApiOperation {
  const result = spec.paths?.[pathname]?.[method.toLowerCase()] as OpenApiOperation | undefined;
  assert.ok(result, `missing ${method.toUpperCase()} ${pathname}`);
  return result;
}

function successContent(op: OpenApiOperation, mediaType: string): OpenApiMedia {
  const response = Object.entries(op.responses ?? {}).find(([status]) =>
    String(status).startsWith("2")
  )?.[1];
  assert.ok(response, "operation has no success response");
  const content = response.content?.[mediaType];
  assert.ok(content, `success response is missing ${mediaType}`);
  return content;
}

function requestContent(op: OpenApiOperation, mediaType: string): OpenApiMedia {
  const content = op.requestBody?.content?.[mediaType];
  assert.ok(content, `request body is missing ${mediaType}`);
  return content;
}

test("primary inference operations describe their JSON and streaming wire formats", () => {
  assert.equal(
    successContent(operation("/api/v1/chat/completions", "post"), "application/json").schema
      .$ref,
    "#/components/schemas/ChatCompletionResponse"
  );
  assert.ok(
    successContent(operation("/api/v1/chat/completions", "post"), "text/event-stream")
  );
  assert.equal(
    successContent(
      operation("/api/v1/providers/{provider}/chat/completions", "post"),
      "application/json"
    ).schema.$ref,
    "#/components/schemas/ChatCompletionResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/messages", "post"), "application/json").schema.$ref,
    "#/components/schemas/MessagesResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/responses", "post"), "application/json").schema.$ref,
    "#/components/schemas/ResponsesResponse"
  );
  assert.equal(
    requestContent(operation("/api/v1/messages/count_tokens", "post"), "application/json").schema
      .$ref,
    "#/components/schemas/CountTokensRequest"
  );
  assert.equal(
    successContent(
      operation("/api/v1/messages/count_tokens", "post"),
      "application/json"
    ).schema.$ref,
    "#/components/schemas/CountTokensResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/embeddings", "post"), "application/json").schema.$ref,
    "#/components/schemas/EmbeddingResponse"
  );
  assert.ok(successContent(operation("/api/v1/audio/speech", "post"), "audio/*"));
  assert.equal(
    successContent(
      operation("/api/v1/audio/transcriptions", "post"),
      "application/json"
    ).schema.$ref,
    "#/components/schemas/AudioTranscriptionResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/audio/translations", "post"), "application/json").schema
      .$ref,
    "#/components/schemas/AudioTranscriptionResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/moderations", "post"), "application/json").schema.$ref,
    "#/components/schemas/ModerationResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/rerank", "post"), "application/json").schema.$ref,
    "#/components/schemas/RerankResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/ocr", "post"), "application/json").schema.$ref,
    "#/components/schemas/OcrResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/completions", "post"), "application/json").schema.$ref,
    "#/components/schemas/LegacyCompletionResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/images/edits", "post"), "application/json").schema.$ref,
    "#/components/schemas/ImageGenerationResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/images/upscale", "post"), "application/json").schema.$ref,
    "#/components/schemas/ImageGenerationResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/images/upscale", "get"), "application/json").schema.$ref,
    "#/components/schemas/ModelListResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/classify", "post"), "application/json").schema.$ref,
    "#/components/schemas/JinaClassifyResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/segment", "post"), "application/json").schema.$ref,
    "#/components/schemas/JinaSegmentResponse"
  );
  assert.equal(
    successContent(operation("/api/v1/responses/{path}", "post"), "application/json").schema
      .$ref,
    "#/components/schemas/ResponsesResponse"
  );
  assert.deepEqual(
    requestContent(operation("/api/v1/audio/speech", "post"), "application/json").schema.required,
    ["model", "input"]
  );
  assert.equal(
    requestContent(operation("/api/v1/images/generations", "post"), "application/json").schema
      .$ref,
    "#/components/schemas/ImageGenerationRequest"
  );
  assert.equal(
    successContent(operation("/api/v1/ws", "get"), "application/json").schema.$ref,
    "#/components/schemas/WebSocketHandshakeResponse"
  );
});

test("Gemini-compatible model discovery and generation describe the native wire shape", () => {
  assert.equal(
    successContent(operation("/api/v1beta/models", "get"), "application/json").schema.$ref,
    "#/components/schemas/GeminiModelListResponse"
  );
  assert.equal(
    requestContent(operation("/api/v1beta/models/{path}", "post"), "application/json").schema
      .$ref,
    "#/components/schemas/GeminiGenerateContentRequest"
  );
  const generate = operation("/api/v1beta/models/{path}", "post");
  assert.equal(
    successContent(generate, "application/json").schema.$ref,
    "#/components/schemas/GeminiGenerateContentResponse"
  );
  assert.ok(successContent(generate, "text/event-stream"));
});

test("OpenAI model catalog responses document provider context and output limits", () => {
  assert.equal(
    successContent(operation("/api/v1/models/{model}", "get"), "application/json").schema.$ref,
    "#/components/schemas/Model"
  );
  const schemas = spec.components?.schemas as
    | Record<string, { properties?: Record<string, unknown> }>
    | undefined;
  const modelProperties = schemas?.Model?.properties;
  assert.ok(modelProperties?.context_length);
  assert.ok(modelProperties?.max_input_tokens);
  assert.ok(modelProperties?.max_output_tokens);
  assert.ok(modelProperties?.capabilities);
});

test("client inference auth reflects key, session, and configured anonymous access", () => {
  const guardedOperations = [
    ["/api/v1/chat/completions", "post"],
    ["/api/v1/providers/{provider}/chat/completions", "post"],
    ["/api/v1/messages", "post"],
    ["/api/v1/responses", "post"],
    ["/api/v1/embeddings", "post"],
    ["/api/v1/images/generations", "post"],
    ["/api/v1/audio/speech", "post"],
    ["/api/v1/audio/transcriptions", "post"],
    ["/api/v1/audio/translations", "post"],
    ["/api/v1/moderations", "post"],
    ["/api/v1/rerank", "post"],
    ["/api/v1/ocr", "post"],
    ["/api/v1/classify", "post"],
    ["/api/v1/segment", "post"],
    ["/api/v1/completions", "post"],
    ["/api/v1/images/edits", "post"],
    ["/api/v1/images/upscale", "post"],
  ] as const;
  for (const [pathname, method] of guardedOperations) {
    const requirements = operation(pathname, method).security ?? [];
    assert.ok(requirements.some((requirement: object) => Object.keys(requirement).length === 0));
    for (const scheme of [
      "BearerAuth",
      "ClientApiKeyAuth",
      "GoogleApiKeyAuth",
      "ManagementSessionAuth",
    ]) {
      assert.ok(
        requirements.some((requirement) => scheme in requirement),
        `${pathname}: ${scheme}`
      );
    }
  }
});

test("chat routes document local pressure errors, retry timing, and correlation", () => {
  const pressureRoutes = [
    ["/api/v1/chat/completions", "post"],
    ["/api/v1/providers/{provider}/chat/completions", "post"],
    ["/api/v1/api/chat", "post"],
    ["/api/v1/messages", "post"],
    ["/api/v1/responses", "post"],
    ["/api/v1/completions", "post"],
    ["/api/v1/responses/{path}", "post"],
  ] as const;
  for (const [pathname, method] of pressureRoutes) {
    assert.equal(
      operation(pathname, method).responses?.["503"]?.$ref,
      "#/components/responses/ServiceUnavailable",
      `${pathname} documents local admission/resource-pressure rejection`
    );
  }

  const responses = spec.components?.responses as
    | Record<
        string,
        {
          headers?: Record<string, unknown>;
          content?: Record<string, { schema?: Record<string, unknown> }>;
        }
      >
    | undefined;
  const pressure = responses?.ServiceUnavailable;
  assert.ok(pressure);
  assert.ok(pressure.headers?.["Retry-After"]);
  assert.ok(pressure.headers?.["x-request-id"]);
  assert.equal(
    pressure.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  const schemas = spec.components?.schemas as
    | Record<string, { properties?: Record<string, unknown> }>
    | undefined;
  const errorShape = schemas?.ApiErrorResponse?.properties?.error as
    | { properties?: Record<string, unknown> }
    | undefined;
  assert.ok(errorShape?.properties?.code);
  assert.ok(errorShape.properties?.reason);
});

test("model, provider, key, and combo management responses match their route payloads", () => {
  const responseRefs = [
    ["/api/v1", "get", "ModelListResponse"],
    ["/api/models", "get", "ManagementModelListResponse"],
    ["/api/models/alias", "get", "ModelAliasLookupResponse"],
    ["/api/models/catalog", "get", "GroupedModelCatalogResponse"],
    ["/api/providers", "get", "ProviderConnectionListResponse"],
    ["/api/providers", "post", "ProviderConnectionEnvelope"],
    ["/api/providers/{id}", "get", "ProviderConnectionEnvelope"],
    ["/api/providers/{id}", "patch", "ProviderConnectionEnvelope"],
    ["/api/providers/{id}", "put", "ProviderConnectionEnvelope"],
    ["/api/providers/{id}", "delete", "ProviderConnectionDeleteResponse"],
    ["/api/keys", "get", "ApiKeyListResponse"],
    ["/api/keys", "post", "ApiKeyCreateResponse"],
    ["/api/combos", "get", "ComboListResponse"],
    ["/api/usage/analytics", "get", "UsageAnalyticsResponse"],
    ["/api/usage/history", "get", "UsageStatsResponse"],
    ["/api/usage/budget", "get", "UsageBudgetStatusResponse"],
    ["/api/usage/budget", "post", "UsageBudgetMutationResponse"],
    ["/api/v1/providers/suggested-models", "get", "SuggestedModelsResponse"],
    ["/api/v1/provider-plugin-manifest", "get", "ProviderPluginManifest"],
    ["/api/v1/quotas/check", "get", "RegisteredKeyQuotaCheckResponse"],
    ["/api/usage/call-logs", "get", "CallLogListResponse"],
    ["/api/usage/call-logs/{id}", "get", "CallLogDetailResponse"],
  ] as const;
  for (const [pathname, method, schema] of responseRefs) {
    const status =
      (method === "post" && pathname === "/api/providers") ||
      (method === "post" && pathname === "/api/keys")
        ? "201"
        : "200";
    const response = operation(pathname, method).responses?.[status] as
      | { content?: Record<string, { schema?: Record<string, unknown> }> }
      | undefined;
    assert.equal(
      response?.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${schema}`,
      `${method.toUpperCase()} ${pathname}`
    );
  }

  const createKeyRequest = requestContent(operation("/api/keys", "post"), "application/json")
    .schema;
  assert.deepEqual(createKeyRequest.required, ["name"]);
  const createKeyProperties = createKeyRequest.properties as Record<string, unknown>;
  assert.ok("allowedModels" in createKeyProperties);
  assert.equal("label" in createKeyProperties, false);

  const schemas = spec.components?.schemas as
    | Record<
        string,
        { required?: string[]; minProperties?: number; properties?: Record<string, unknown> }
      >
    | undefined;
  assert.ok(schemas?.ProviderConnectionListResponse?.required?.includes("total"));
  const providerUpdate = schemas?.ProviderConnectionUpdate;
  assert.equal(providerUpdate?.minProperties, 1);
  const providerUpdateProperties = providerUpdate?.properties;
  assert.ok(providerUpdateProperties?.name);
  assert.ok(providerUpdateProperties?.providerSpecificData);
  assert.equal("provider" in (providerUpdateProperties ?? {}), false);
  for (const method of ["patch", "put"] as const) {
    assert.equal(
      requestContent(operation("/api/providers/{id}", method), "application/json").schema.$ref,
      "#/components/schemas/ProviderConnectionUpdate"
    );
  }
  for (const method of ["get", "patch", "put", "delete"] as const) {
    const providerOperation = operation("/api/providers/{id}", method);
    const security = providerOperation.security ?? [];
    assert.ok(security.some((requirement) => "BearerAuth" in requirement));
    assert.ok(security.some((requirement) => "ManagementSessionAuth" in requirement));
    assert.ok(security.some((requirement) => Object.keys(requirement).length === 0));
    assert.ok(providerOperation.responses?.["401"]);
    assert.ok(providerOperation.responses?.["403"]);
    assert.ok(providerOperation.responses?.["503"]);
  }
  assert.equal(
    operation("/api/providers/{id}", "delete").responses?.["404"]?.content?.["application/json"]
      ?.schema?.$ref,
    "#/components/schemas/ProviderConnectionErrorResponse"
  );
  assert.ok(schemas?.ApiKeyListResponse?.required?.includes("allowKeyReveal"));
  assert.ok(schemas?.ApiKeyCreateResponse?.required?.includes("key"));
  assert.equal(
    (schemas?.UsageAnalyticsResponse?.properties?.errorBreakdown as { type?: unknown })?.type,
    "array"
  );
  assert.ok(schemas?.UsageStatsResponse?.required?.includes("activeRequests"));
  assert.ok(schemas?.UsageBudgetStatusResponse?.required?.includes("budgetCheck"));
  assert.ok(operation("/api/v1/provider-plugin-manifest", "get").responses?.["304"]);
  const analyticsParameters = operation("/api/usage/analytics", "get").parameters ?? [];
  assert.ok(
    analyticsParameters.some(
      (parameter) =>
        parameter &&
        typeof parameter === "object" &&
        "name" in parameter &&
        parameter.name === "range"
    )
  );
  assert.equal(
    analyticsParameters.some(
      (parameter) =>
        parameter &&
        typeof parameter === "object" &&
        "name" in parameter &&
        parameter.name === "period"
    ),
    false
  );
  const budgetGet = operation("/api/usage/budget", "get");
  assert.ok(
    budgetGet.parameters?.some(
      (parameter) =>
        parameter &&
        typeof parameter === "object" &&
        "name" in parameter &&
        parameter.name === "apiKeyId" &&
        "required" in parameter &&
        parameter.required === true
    )
  );
  const budgetRequest = requestContent(operation("/api/usage/budget", "post"), "application/json")
    .schema;
  assert.equal(budgetRequest.$ref, "#/components/schemas/SetUsageBudgetRequest");
  assert.deepEqual(schemas?.SetUsageBudgetRequest?.required, ["apiKeyId"]);
  const callLogList = operation("/api/usage/call-logs", "get");
  const callLogLimit = callLogList.parameters?.find(
    (parameter: unknown) =>
      parameter && typeof parameter === "object" && "name" in parameter && parameter.name === "limit"
  ) as { schema?: { default?: unknown } } | undefined;
  assert.equal(callLogLimit?.schema?.default, 200);
  const callLogDetail = operation("/api/usage/call-logs/{id}", "get");
  const notFound = callLogDetail.responses?.["404"] as
    | { content?: Record<string, { schema?: Record<string, unknown> }> }
    | undefined;
  assert.equal(
    notFound?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
});

test("all local OpenAPI references resolve", () => {
  const refs: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === "string") refs.push(record.$ref);
      Object.values(record).forEach(walk);
    }
  };
  walk(spec);

  const missing: string[] = [];
  for (const ref of refs) {
    if (!ref.startsWith("#/")) continue;
    let target: unknown = spec;
    try {
      for (const part of ref.slice(2).split("/")) {
        if (!target || typeof target !== "object" || Array.isArray(target)) {
          target = undefined;
          break;
        }
        target = (target as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
      }
    } catch {
      target = undefined;
    }
    if (target === undefined) missing.push(ref);
  }
  assert.deepEqual([...new Set(missing)], []);
});
