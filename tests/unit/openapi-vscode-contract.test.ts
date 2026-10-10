import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean;
};

type Response = {
  description?: string;
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<string, Response>;
};

type PathItem = Record<string, Operation> & {
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
  }>;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, Schema> };
};

function operation(pathTemplate: string, method: string) {
  const value = spec.paths[pathTemplate]?.[method];
  assert.ok(value, `missing ${method.toUpperCase()} ${pathTemplate}`);
  return value;
}

function responseSchema(
  pathTemplate: string,
  method: string,
  status: string,
  mediaType = "application/json"
) {
  return operation(pathTemplate, method).responses?.[status]?.content?.[mediaType]?.schema;
}

function pathToken(pathTemplate: string, method: string) {
  const parameter = [
    ...(spec.paths[pathTemplate]?.parameters ?? []),
    ...(operation(pathTemplate, method).parameters ?? []),
  ].find((item) => item.name === "token" && item.in === "path");
  assert.ok(
    parameter?.required,
    `${method.toUpperCase()} ${pathTemplate} must require its token path segment`
  );
  return parameter;
}

test("VS Code grouped and raw model catalogs expose their concrete list shapes", () => {
  for (const pathTemplate of [
    "/api/v1/vscode/{token}",
    "/api/v1/vscode/{token}/models",
    "/api/v1/vscode/{token}/v1/models",
  ]) {
    pathToken(pathTemplate, "get");
    assert.equal(
      responseSchema(pathTemplate, "get", "200")?.$ref,
      "#/components/schemas/VscodeModelListResponse"
    );
    assert.ok(operation(pathTemplate, "get").security?.length);
  }
  for (const pathTemplate of [
    "/api/v1/vscode/raw/{token}",
    "/api/v1/vscode/raw/{token}/models",
    "/api/v1/vscode/raw/{token}/v1/models",
  ]) {
    pathToken(pathTemplate, "get");
    assert.equal(
      responseSchema(pathTemplate, "get", "200")?.$ref,
      "#/components/schemas/VscodeRawModelListResponse"
    );
    assert.ok(operation(pathTemplate, "get").security?.length);
  }
  assert.equal(spec.components.schemas.VscodeModelListResponse.properties?.object.const, "list");
  assert.equal(
    spec.components.schemas.VscodeModelListResponse.properties?.data.items?.$ref,
    "#/components/schemas/VscodeImportModel"
  );
  assert.equal(
    spec.components.schemas.VscodeRawModelListResponse.properties?.data.items?.$ref,
    "#/components/schemas/VscodeRawCatalogModel"
  );
});

test("Ollama-compatible VS Code routes document their helper schemas and centralized path-token API auth", () => {
  const showPath = "/api/v1/vscode/{token}/api/show";
  const show = operation(showPath, "post");
  pathToken(showPath, "post");
  assert.equal(show.requestBody?.required, false);
  assert.equal(
    show.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/VscodeOllamaShowRequest"
  );
  assert.equal(
    responseSchema(showPath, "post", "200")?.$ref,
    "#/components/schemas/VscodeOllamaShowResponse"
  );
  assert.equal(
    responseSchema(showPath, "post", "400")?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.equal(
    responseSchema(showPath, "post", "404")?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.ok(show.security?.length);

  for (const pathTemplate of [
    "/api/v1/vscode/{token}/api/tags",
    "/api/v1/vscode/raw/{token}/api/tags",
  ]) {
    pathToken(pathTemplate, "get");
    assert.equal(
      responseSchema(pathTemplate, "get", "200")?.$ref,
      "#/components/schemas/VscodeOllamaTagsResponse"
    );
    assert.ok(operation(pathTemplate, "get").security?.length);
  }

  for (const pathTemplate of [
    "/api/v1/vscode/{token}/api/version",
    "/api/v1/vscode/raw/{token}/api/version",
  ]) {
    pathToken(pathTemplate, "get");
    assert.equal(
      responseSchema(pathTemplate, "get", "200")?.$ref,
      "#/components/schemas/VscodeOllamaVersionResponse"
    );
    assert.deepEqual(
      operation(pathTemplate, "get").security,
      spec.paths["/api/v1/models"]?.get?.security,
      "version handlers ignore the path token but follow the central CLIENT_API auth policy"
    );
  }

  for (const pathTemplate of [
    "/api/v1/vscode/{token}/combos",
    "/api/v1/vscode/raw/{token}/combos",
  ]) {
    pathToken(pathTemplate, "get");
    assert.equal(
      responseSchema(pathTemplate, "get", "200")?.$ref,
      "#/components/schemas/VscodeCliComboListResponse"
    );
    assert.equal(
      responseSchema(pathTemplate, "get", "500")?.$ref,
      "#/components/schemas/StringErrorResponse"
    );
    assert.deepEqual(
      operation(pathTemplate, "get").security,
      spec.paths["/api/v1/models"]?.get?.security,
      "combo list reads the combo store directly but follows the central CLIENT_API auth policy"
    );
  }
  assert.equal(
    spec.components.schemas.VscodeOllamaTagsResponse.properties?.models.items?.$ref,
    "#/components/schemas/VscodeOllamaTagModel"
  );
});

test("VS Code chat and Responses aliases document JSON requests and negotiated streaming media", () => {
  for (const pathTemplate of [
    "/api/v1/vscode/{token}/chat/completions",
    "/api/v1/vscode/{token}/v1/chat/completions",
    "/api/v1/vscode/raw/{token}/chat/completions",
    "/api/v1/vscode/raw/{token}/v1/chat/completions",
  ]) {
    const route = operation(pathTemplate, "post");
    pathToken(pathTemplate, "post");
    assert.equal(route.requestBody?.required, true);
    assert.equal(
      route.requestBody?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/ChatCompletionRequest"
    );
    assert.equal(
      responseSchema(pathTemplate, "post", "200")?.$ref,
      "#/components/schemas/ChatCompletionResponse"
    );
    assert.equal(route.responses?.["200"]?.content?.["text/event-stream"]?.schema?.type, "string");
    for (const status of ["400", "401", "413", "415", "429", "502", "503"]) {
      assert.ok(route.responses?.[status], `${pathTemplate} should describe ${status}`);
    }
    assert.ok(route.security?.length);
  }

  for (const pathTemplate of [
    "/api/v1/vscode/{token}/responses",
    "/api/v1/vscode/raw/{token}/responses",
  ]) {
    const route = operation(pathTemplate, "post");
    pathToken(pathTemplate, "post");
    assert.equal(
      route.requestBody?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/ResponsesRequest"
    );
    assert.equal(
      responseSchema(pathTemplate, "post", "200")?.$ref,
      "#/components/schemas/ResponsesResponse"
    );
    assert.equal(route.responses?.["200"]?.content?.["text/event-stream"]?.schema?.type, "string");
    assert.ok(
      route.responses?.["400"] &&
        route.responses?.["401"] &&
        route.responses?.["413"] &&
        route.responses?.["429"] &&
        route.responses?.["503"]
    );
    assert.ok(route.security?.length);
  }

  for (const pathTemplate of [
    "/api/v1/vscode/{token}/api/chat",
    "/api/v1/vscode/raw/{token}/api/chat",
  ]) {
    const route = operation(pathTemplate, "post");
    pathToken(pathTemplate, "post");
    assert.equal(
      route.requestBody?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/VscodeOllamaChatRequest"
    );
    assert.equal(
      route.responses?.["200"]?.content?.["application/x-ndjson"]?.schema?.$ref,
      "#/components/schemas/OllamaChatResponse"
    );
    assert.ok(route.responses?.["413"], `${pathTemplate} should describe request-size rejection`);
    assert.ok(route.security?.length);
  }
});
