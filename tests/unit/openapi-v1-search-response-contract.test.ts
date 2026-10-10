import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { SEARCH_PROVIDER_ALIASES } from "../../open-sse/config/searchRegistry.ts";
import { v1SearchSchema } from "../../src/shared/validation/schemas/apiV1.ts";

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

test("POST /api/v1/search documents runtime auth, provider aliases, coercions, and errors", () => {
  const operation = spec.paths["/api/v1/search"].post;
  const description = operation.description as string;
  const security = operation.security as Array<Record<string, unknown>>;
  for (const name of [
    "BearerAuth",
    "ClientApiKeyAuth",
    "GoogleApiKeyAuth",
    "ManagementSessionAuth",
  ]) {
    assert.ok(
      security.some((requirement) => name in requirement),
      `${name} is an accepted auth`
    );
  }
  assert.ok(security.some((requirement) => Object.keys(requirement).length === 0));
  assert.match(description, /REQUIRE_API_KEY/);
  assert.match(description, /`\/v1\/search`/);
  for (const alias of Object.keys(SEARCH_PROVIDER_ALIASES)) {
    assert.ok(description.includes(`\`${alias}\``), `provider alias ${alias} is documented`);
  }

  const request = operation.requestBody.content["application/json"].schema;
  assert.ok(request.properties.max_results.oneOf.some((variant: any) => variant.type === "string"));
  assert.ok(request.properties.offset.oneOf.some((variant: any) => variant.type === "string"));
  assert.ok(
    request.properties.content.properties.max_characters.oneOf.some(
      (variant: any) => variant.type === "string"
    )
  );
  assert.match(request.properties.synthesis.description, /currently accepted but ignored/i);
  assert.ok(request.properties.synthesis.properties.max_tokens.oneOf);

  // These representative coercions are part of the runtime schema contract.
  const parsed = v1SearchSchema.safeParse({
    query: "search contract",
    max_results: "5",
    offset: "2",
    content: { max_characters: "120" },
    synthesis: { strategy: "none", max_tokens: "12" },
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.max_results, 5);
    assert.equal(parsed.data.offset, 2);
    assert.equal(parsed.data.content?.max_characters, 120);
    assert.equal(parsed.data.synthesis?.max_tokens, 12);
  }

  const responses = operation.responses;
  assert.equal(responses["401"].$ref, "#/components/responses/InferenceUnauthorized");
  for (const status of ["400", "402", "403", "404", "422", "429", "502", "504", "default"]) {
    const response = responses[status];
    assert.ok(response, `search documents HTTP ${status}`);
    const schemaRef = response.$ref
      ? spec.components.responses[response.$ref.split("/").at(-1)!].content["application/json"]
          .schema.$ref
      : response.content?.["application/json"]?.schema?.$ref;
    assert.equal(
      schemaRef,
      "#/components/schemas/ApiErrorResponse",
      `HTTP ${status} has JSON error schema`
    );
  }
  assert.equal(responses["503"].$ref, "#/components/responses/ServiceUnavailable");

  const routeSource = fs.readFileSync(path.join(ROOT, "src/app/api/v1/search/route.ts"), "utf8");
  assert.doesNotMatch(
    routeSource,
    /body\.synthesis/,
    "the documented synthesis field remains a no-op"
  );
});

test("public OpenAPI mirror matches the canonical search success contract", () => {
  assert.deepEqual(publicSpec, spec);
});
