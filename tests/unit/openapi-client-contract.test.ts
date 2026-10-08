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
