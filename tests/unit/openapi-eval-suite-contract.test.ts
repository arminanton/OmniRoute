import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";
import { isAlwaysProtectedPath, isLocalOnlyPath } from "../../src/server/authz/routeGuard.ts";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const routes = [
  { file: "src/app/api/evals/suites/route.ts", method: "post", path: "/api/evals/suites" },
  {
    file: "src/app/api/evals/suites/[suiteId]/route.ts",
    method: "get",
    path: "/api/evals/suites/{suiteId}",
  },
  {
    file: "src/app/api/evals/suites/[suiteId]/route.ts",
    method: "put",
    path: "/api/evals/suites/{suiteId}",
  },
  {
    file: "src/app/api/evals/suites/[suiteId]/route.ts",
    method: "delete",
    path: "/api/evals/suites/{suiteId}",
  },
] as const;

function operation(route: (typeof routes)[number]) {
  const result = spec.paths?.[route.path]?.[route.method];
  assert.ok(result, `missing ${route.method.toUpperCase()} ${route.path}`);
  return result;
}

function sourceOperations() {
  const root = apiRoot(ROOT);
  const files = new Set(routes.map(({ file }) => file));
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (!files.has(relativeFile as (typeof routes)[number]["file"])) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const apiPath of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${apiPath}`);
      }
    }
  }
  return result;
}

test("evaluation-suite operations match route source and management auth policy", () => {
  const documented = new Set(routes.map(({ method, path }) => `${method} ${path}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(documented.size, 4);

  for (const route of routes) {
    const method = route.method.toUpperCase();
    const op = operation(route);
    assert.equal(classifyRoute(route.path, method).routeClass, "MANAGEMENT");
    assert.equal(isAlwaysProtectedPath(route.path), false);
    assert.equal(isLocalOnlyPath(route.path, method), false);
    assert.equal(inferRequiredScope(method, route.path), method === "GET" ? "read" : "write");
    for (const scheme of [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
    ]) {
      assert.ok(
        op.security?.some((entry: Record<string, unknown>) => scheme in entry),
        `${method} ${route.path} must document ${scheme}`
      );
    }
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${method} ${route.path} may be anonymous when requireLogin=false`
    );
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.ok(op.responses?.["401"] && op.responses?.["403"] && op.responses?.["503"]);
  }
});

test("evaluation-suite contracts model sensitive cases, upsert behavior, and delete semantics", () => {
  const create = operation(routes[0]);
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/EvalSuiteSaveRequest"
  );
  assert.equal(create.requestBody?.["x-sensitive"], true);
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/EvalSuiteSaveResponse"
  );
  assert.ok(create.responses?.["400"] && create.responses?.["500"]);
  assert.match(create.description, /already exists.*replaces/i);

  const get = operation(routes[1]);
  assert.equal(
    get.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/EvalSuiteGetResponse"
  );
  assert.equal(get.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(get.responses?.["404"]);

  const update = operation(routes[2]);
  assert.equal(
    update.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/EvalSuiteSaveRequest"
  );
  assert.equal(
    update.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/EvalSuiteSaveResponse"
  );
  assert.ok(update.responses?.["404"]);
  assert.match(update.description, /path `suiteId` is authoritative/i);

  const remove = operation(routes[3]);
  assert.equal(
    remove.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/EvalSuiteDeleteResponse"
  );
  assert.ok(remove.responses?.["404"]);

  const saveRequest = spec.components.schemas.EvalSuiteSaveRequest;
  assert.equal(saveRequest.properties.cases.minItems, 1);
  assert.equal(saveRequest.properties.cases.maxItems, 200);
  assert.equal(
    spec.components.schemas.EvalCaseSaveRequest.properties.input.properties.messages.maxItems,
    32
  );
  assert.equal(spec.components.schemas.EvalMessageRecord.properties.content["x-sensitive"], true);
  assert.deepEqual(spec.components.schemas.EvalCaseExpectedRecord.properties.strategy.enum, [
    "contains",
    "exact",
    "regex",
    "custom",
  ]);
});

test("evaluation-suite OpenAPI contracts mirror in the public artifact", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
