import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { antigravityToOpenAIRequest } from "../../open-sse/translator/request/antigravity-to-openai.ts";
import { openaiToAntigravityResponse } from "../../open-sse/translator/response/openai-to-antigravity.ts";

type Schema = {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, Schema> };
};

test("/api/v1/antigravity documents the authenticated Cloud Code request and JSON/SSE replies", () => {
  const operation = spec.paths["/api/v1/antigravity"]?.post;
  assert.ok(operation, "missing POST /api/v1/antigravity");
  assert.deepEqual(operation.security, [
    { BearerAuth: [] },
    { ClientApiKeyAuth: [] },
    { GoogleApiKeyAuth: [] },
    { ManagementSessionAuth: [] },
    {},
  ]);
  assert.equal(
    operation.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/AntigravityCloudCodeRequest"
  );
  assert.equal(
    operation.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/AntigravityCloudCodeResponse"
  );
  assert.equal(operation.responses["200"].content["text/event-stream"].schema.type, "string");
  assert.equal(operation.responses["503"].$ref, "#/components/responses/ServiceUnavailable");
  assert.equal(
    spec.components.schemas.AntigravityCloudCodeRequest.properties?.request?.$ref,
    "#/components/schemas/AntigravityCloudCodeGenerationRequest"
  );
  assert.equal(
    spec.components.schemas.AntigravityCloudCodeGenerationRequest.properties?.systemInstruction
      ?.$ref,
    "#/components/schemas/AntigravityCloudCodeSystemInstruction"
  );
  assert.deepEqual(
    spec.components.schemas.AntigravityCloudCodeSystemInstruction.oneOf?.map(
      (schema) => schema.type
    ),
    ["string", "object"]
  );
});

test("Antigravity route translators emit the documented Cloud Code envelope shapes", () => {
  const request = antigravityToOpenAIRequest(
    "antigravity/gemini-3.8-flash-high",
    {
      model: "antigravity/gemini-3.8-flash-high",
      request: {
        systemInstruction: "Be concise.",
        contents: [{ role: "user", parts: [{ text: "Hello" }] }],
        generationConfig: { maxOutputTokens: 128, thinkingConfig: { thinkingBudget: 4096 } },
      },
    },
    true
  );
  assert.equal(request.model, "antigravity/gemini-3.8-flash-high");
  assert.equal(request.stream, true);
  assert.deepEqual(request.messages, [
    { role: "system", content: "Be concise." },
    { role: "user", content: "Hello" },
  ]);

  const response = openaiToAntigravityResponse(
    {
      id: "chatcmpl-antigravity-contract",
      model: "gemini-3.8-flash-high",
      choices: [{ delta: { content: "Hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    },
    {}
  );
  assert.equal(response?.response.modelVersion, "gemini-3.8-flash-high");
  assert.equal(response?.response.responseId, "chatcmpl-antigravity-contract");
  assert.deepEqual(response?.response.candidates[0], {
    content: { role: "model", parts: [{ text: "Hello" }] },
    finishReason: "STOP",
  });
  assert.deepEqual(response?.response.usageMetadata, {
    promptTokenCount: 11,
    candidatesTokenCount: 3,
    totalTokenCount: 14,
  });
  assert.ok(
    spec.components.schemas.AntigravityCloudCodeResponsePayload.required?.includes("responseId")
  );
});
