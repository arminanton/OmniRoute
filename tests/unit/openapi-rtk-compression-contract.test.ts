import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { rtkConfigSchema } from "../../src/shared/validation/compressionConfigSchemas.ts";

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

type Operation = {
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Schema;
  }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { $ref?: string; content?: Record<string, { schema?: Schema }> }>;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function operation(pathTemplate: string, method: string): Operation {
  const result = spec.paths[pathTemplate]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathTemplate}`);
  return result;
}

function responseSchema(
  pathTemplate: string,
  method: string,
  status = "200",
  mediaType = "application/json"
): Schema {
  const schema = operation(pathTemplate, method).responses?.[status]?.content?.[mediaType]?.schema;
  assert.ok(
    schema,
    `missing ${status} ${mediaType} schema for ${method.toUpperCase()} ${pathTemplate}`
  );
  return schema;
}

function assertConditionalManagementAuth(op: Operation): void {
  const alternatives = op.security ?? [];
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "BearerAuth")));
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
  assert.ok(alternatives.some((entry) => Object.keys(entry).length === 0));
  assert.equal(
    op.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(op.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
  assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
}

const managementOperations: Array<[string, string]> = [
  ["/api/context/rtk/config", "get"],
  ["/api/context/rtk/config", "put"],
  ["/api/context/rtk/filters", "get"],
  ["/api/context/rtk/import", "post"],
  ["/api/context/rtk/test", "post"],
  ["/api/context/rtk/raw-output/{id}", "get"],
  ["/api/context/rtk/discover", "get"],
  ["/api/context/rtk/learn", "get"],
];

test("RTK management endpoints document conditional auth and successful response bodies", () => {
  for (const [pathTemplate, method] of managementOperations) {
    const op = operation(pathTemplate, method);
    assertConditionalManagementAuth(op);
    const expectedMediaType = pathTemplate.endsWith("raw-output/{id}") ? "text/plain" : undefined;
    const schema = responseSchema(pathTemplate, method, "200", expectedMediaType);
    assert.ok(
      schema.type || schema.$ref,
      `missing typed success schema for ${method.toUpperCase()} ${pathTemplate}`
    );
  }
  assert.equal(
    responseSchema("/api/context/rtk/config", "get").$ref,
    "#/components/schemas/RtkConfig"
  );
  assert.equal(
    responseSchema("/api/context/rtk/filters", "get").$ref,
    "#/components/schemas/RtkFilterCatalogResponse"
  );
  assert.equal(
    responseSchema("/api/context/rtk/import", "post").$ref,
    "#/components/schemas/RtkFilterImportResponse"
  );
  assert.equal(
    responseSchema("/api/context/rtk/test", "post").$ref,
    "#/components/schemas/RtkTextTestResponse"
  );
});

test("RTK configuration contracts match the partial Zod update schema and source bounds", () => {
  const update = spec.components.schemas.RtkConfigUpdate;
  assert.deepEqual(
    Object.keys(update.properties ?? {}).sort(),
    Object.keys(rtkConfigSchema.shape).sort()
  );
  assert.deepEqual(update.required, undefined);
  assert.equal(update.additionalProperties, false);
  assert.deepEqual(update.properties?.intensity.enum, ["minimal", "standard", "aggressive"]);
  assert.equal(update.properties?.maxLinesPerResult.minimum, 0);
  assert.equal(update.properties?.maxLinesPerResult.maximum, 100000);
  assert.equal(update.properties?.rawOutputMaxBytes.minimum, 1024);
  assert.equal(update.properties?.rawOutputMaxBytes.maximum, 10000000);
  assert.ok(rtkConfigSchema.safeParse({ maxLinesPerResult: 100000 }).success);
  assert.ok(!rtkConfigSchema.safeParse({ maxLinesPerResult: 100001 }).success);
  assert.ok(!rtkConfigSchema.safeParse({ unknownRtkSetting: true }).success);

  const put = operation("/api/context/rtk/config", "put");
  assert.equal(
    put.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RtkConfigUpdate"
  );
  assert.equal(
    put.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RtkConfig"
  );
});

test("RTK TOML, text-test, raw-output, discover, and learn contracts describe actual payloads", () => {
  const importRequest = operation("/api/context/rtk/import", "post").requestBody?.content?.[
    "application/json"
  ]?.schema;
  assert.equal(importRequest?.$ref, "#/components/schemas/RtkFilterImportRequest");
  assert.deepEqual(importRequest?.required, undefined);
  assert.deepEqual(spec.components.schemas.RtkFilterImportRequest.required, ["action", "content"]);
  assert.deepEqual(spec.components.schemas.RtkFilterImportRequest.properties?.action.enum, [
    "validate",
    "install",
  ]);
  assert.equal(
    spec.components.schemas.RtkFilterImportRequest.properties?.content.maxLength,
    1048576
  );

  const testRequest = operation("/api/context/rtk/test", "post").requestBody?.content?.[
    "application/json"
  ]?.schema;
  assert.equal(testRequest?.$ref, "#/components/schemas/RtkTextTestRequest");
  assert.deepEqual(spec.components.schemas.RtkTextTestRequest.required, ["text"]);
  assert.equal(spec.components.schemas.RtkTextTestRequest.additionalProperties, false);
  assert.deepEqual(spec.components.schemas.RtkFilterImportResponse.required, [
    "schemaVersion",
    "sha256",
    "passed",
    "filters",
    "outcomes",
    "filtersWithoutTests",
    "warnings",
  ]);

  const raw = operation("/api/context/rtk/raw-output/{id}", "get");
  assert.equal(
    responseSchema("/api/context/rtk/raw-output/{id}", "get", "200", "text/plain").type,
    "string"
  );
  assert.ok(
    raw.parameters?.some((parameter) => parameter.name === "id" && parameter.in === "path")
  );

  const discover = operation("/api/context/rtk/discover", "get");
  const learn = operation("/api/context/rtk/learn", "get");
  assert.ok(discover.parameters?.some((parameter) => parameter.name === "limit"));
  assert.deepEqual(
    learn.parameters?.filter((parameter) => parameter.required).map((parameter) => parameter.name),
    ["command"]
  );
  assert.match(
    learn.responses?.["400"]?.content?.["application/json"]?.schema?.$ref ?? "",
    /ApiErrorResponse/
  );
  assert.equal(
    responseSchema("/api/context/rtk/discover", "get").$ref,
    "#/components/schemas/RtkDiscoverResponse"
  );
  assert.equal(
    responseSchema("/api/context/rtk/learn", "get").$ref,
    "#/components/schemas/RtkLearnResponse"
  );
  assert.deepEqual(spec.components.schemas.RtkNoiseCandidate.required, ["pattern", "hits"]);
  assert.equal(spec.components.schemas.RtkSuggestedFilter.properties?.category.const, "generic");
});
