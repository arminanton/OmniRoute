import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = yaml.load(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8"));

function schema(name: string): any {
  const value = spec.components.schemas[name];
  assert.ok(value, `components.schemas.${name} must exist`);
  return value;
}

test("POST /api/v1/search references the complete normalized search success contract", () => {
  const success =
    spec.paths["/api/v1/search"].post.responses["200"].content["application/json"].schema;
  assert.equal(success.$ref, "#/components/schemas/V1SearchResponse");

  const response = schema("V1SearchResponse");
  assert.deepEqual(response.required, [
    "id",
    "provider",
    "query",
    "results",
    "answer",
    "usage",
    "metrics",
    "errors",
    "cached",
  ]);
  assert.equal(response.properties.results.items.$ref, "#/components/schemas/V1SearchResult");
  assert.equal(response.properties.answer.oneOf[0].$ref, "#/components/schemas/V1SearchAnswer");
  assert.equal(response.properties.answer.oneOf[1].type, "null");
  assert.equal(response.properties.usage.$ref, "#/components/schemas/V1SearchUsage");
  assert.equal(response.properties.metrics.$ref, "#/components/schemas/V1SearchMetrics");
  assert.equal(response.properties.errors.items.$ref, "#/components/schemas/V1SearchError");
});

test("normalized search result contract includes nullable metadata and content fields", () => {
  const result = schema("V1SearchResult");
  assert.deepEqual(result.required, [
    "title",
    "url",
    "snippet",
    "position",
    "score",
    "published_at",
    "favicon_url",
    "content",
    "metadata",
    "citation",
    "provider_raw",
  ]);
  assert.equal(result.required.includes("display_url"), false);
  assert.equal(result.properties.content.oneOf[0].$ref, "#/components/schemas/V1SearchContent");
  assert.equal(result.properties.content.oneOf[1].type, "null");
  assert.equal(result.properties.metadata.$ref, "#/components/schemas/V1SearchMetadata");
  assert.equal(result.properties.citation.$ref, "#/components/schemas/V1SearchCitation");
  assert.equal(result.properties.provider_raw.type, "null");

  const metadata = schema("V1SearchMetadata");
  assert.deepEqual(metadata.required, ["author", "language", "source_type", "image_url"]);
  for (const field of metadata.required) {
    assert.deepEqual(metadata.properties[field].type, ["string", "null"]);
  }
  assert.deepEqual(schema("V1SearchAnswer").required, ["source", "text", "model"]);
  assert.deepEqual(schema("V1SearchAnswer").properties.text.type, ["string", "null"]);
  assert.deepEqual(schema("V1SearchAnswer").properties.model.type, ["string", "null"]);
});

test("public OpenAPI mirror matches the canonical search success contract", () => {
  assert.deepEqual(publicSpec, spec);
});
