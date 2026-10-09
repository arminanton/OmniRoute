import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const ROUTE = "/api/fallback/chains";
const METHODS = ["get", "post", "delete"] as const;

function operation(method: (typeof METHODS)[number]) {
  const result = spec.paths?.[ROUTE]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${ROUTE}`);
  return result;
}

function sourceOperations() {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (relativeFile !== "src/app/api/fallback/chains/route.ts") continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

test("fallback chain OpenAPI operations match route methods and central management policy", () => {
  const documented = new Set(METHODS.map((method) => `${method} ${ROUTE}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(classifyRoute(ROUTE, "GET").routeClass, "MANAGEMENT");

  for (const method of METHODS) {
    const op = operation(method);
    const alternatives = op.security ?? [];
    for (const scheme of ["BearerAuth", "ManagementSessionAuth", "LocalCliTokenAuth"]) {
      assert.ok(
        alternatives.some((entry: Record<string, unknown>) => scheme in entry),
        `${method.toUpperCase()} must document ${scheme}`
      );
    }
    assert.ok(
      alternatives.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${method.toUpperCase()} must document the standalone requireLogin=false anonymous path`
    );
    assert.notEqual(op["x-always-protected"], true);
    assert.notEqual(op["x-loopback-only"], true);
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.match(op.description ?? "", /locked management/i);

    assert.equal(
      op.responses?.["401"]?.$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(op.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
  }

  assert.match(operation("get").description, /`read` scope/i);
  assert.match(operation("post").description, /`write` scope/i);
  assert.match(operation("delete").description, /`write` scope/i);
});

test("fallback chain reads and mutations describe their actual JSON envelopes", () => {
  const list = operation("get");
  assert.equal(
    list.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/FallbackChainsResponse"
  );
  assert.equal(
    list.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  const chains = spec.components.schemas.FallbackChainsResponse;
  assert.equal(chains.type, "object");
  assert.equal(chains.additionalProperties.type, "array");
  assert.equal(chains.additionalProperties.items.$ref, "#/components/schemas/FallbackChainEntry");

  const create = operation("post");
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/FallbackChainRegistrationRequest"
  );
  assert.equal(
    create.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/FallbackChainRegistrationResponse"
  );
  assert.equal(
    create.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ValidationErrorResponse"
  );
  assert.equal(
    create.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  const createRequest = spec.components.schemas.FallbackChainRegistrationRequest;
  assert.deepEqual(createRequest.required, ["model", "chain"]);
  assert.equal(createRequest.properties.model.minLength, 1);
  assert.equal(createRequest.properties.model.maxLength, 200);
  assert.equal(createRequest.properties.chain.minItems, 1);
  const inputEntry = spec.components.schemas.FallbackChainEntryInput;
  assert.deepEqual(inputEntry.required, ["provider"]);
  assert.equal(inputEntry.properties.provider.minLength, 1);
  assert.equal(inputEntry.properties.priority.minimum, 1);
  assert.equal(inputEntry.properties.priority.maximum, 100);
  assert.equal(inputEntry.additionalProperties, true);
  assert.match(create.description, /best-effort/i);
  assert.match(create.description, /ascending priority/i);

  const deletion = operation("delete");
  assert.equal(
    deletion.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/FallbackChainRemovalRequest"
  );
  assert.equal(
    deletion.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/FallbackChainRemovalResponse"
  );
  assert.equal(
    deletion.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ValidationErrorResponse"
  );
  const removeResponse = spec.components.schemas.FallbackChainRemovalResponse;
  assert.equal(removeResponse.properties.success.const, true);
  assert.equal(removeResponse.properties.removed.type, "boolean");
  assert.match(deletion.description, /removed=false/i);
});

test("fallback chain changes mirror in the public OpenAPI document", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
