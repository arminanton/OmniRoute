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
const routes = [
  { file: "src/app/api/conductor/ask/route.ts", method: "post", path: "/api/conductor/ask" },
  { file: "src/app/api/conductor/fleet/route.ts", method: "get", path: "/api/conductor/fleet" },
  { file: "src/app/api/conductor/tasks/route.ts", method: "post", path: "/api/conductor/tasks" },
  {
    file: "src/app/api/conductor/tasks/[id]/route.ts",
    method: "get",
    path: "/api/conductor/tasks/{id}",
  },
  {
    file: "src/app/api/conductor/tasks/[id]/cancel/route.ts",
    method: "post",
    path: "/api/conductor/tasks/{id}/cancel",
  },
] as const;

function operation(route: (typeof routes)[number]) {
  const result = spec.paths?.[route.path]?.[route.method];
  assert.ok(result, `missing ${route.method.toUpperCase()} ${route.path}`);
  return result;
}

function sourceOperations() {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  const family = new Set(routes.map(({ file }) => file));
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (!family.has(relativeFile as (typeof routes)[number]["file"])) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

test("Conductor OpenAPI operations match their source routes and management auth policy", () => {
  const documented = new Set(routes.map(({ method, path }) => `${method} ${path}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());

  for (const route of routes) {
    const op = operation(route);
    assert.equal(classifyRoute(route.path, route.method.toUpperCase()).routeClass, "MANAGEMENT");
    for (const scheme of [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
    ]) {
      assert.ok(
        op.security?.some((entry: Record<string, unknown>) => scheme in entry),
        `${route.method.toUpperCase()} ${route.path} must document ${scheme}`
      );
    }
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${route.method.toUpperCase()} ${route.path} must document the requireLogin=false path`
    );
    assert.notEqual(op["x-always-protected"], true);
    assert.notEqual(op["x-loopback-only"], true);
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.match(op.description ?? "", /locked management requires authentication/i);
    assert.equal(
      op.responses?.["401"]?.$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(op.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
  }

  assert.match(operation(routes[0]).description, /write-scoped access token/i);
  assert.match(operation(routes[1]).description, /read-scoped access token/i);
  assert.match(operation(routes[2]).description, /write-scoped access token/i);
  assert.match(operation(routes[3]).description, /read-scoped access token/i);
  assert.match(operation(routes[4]).description, /write-scoped access token/i);
});

test("Conductor request and response schemas describe whitelisted and sensitive data", () => {
  const ask = operation(routes[0]);
  assert.equal(
    ask.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ConductorAskRequest"
  );
  assert.equal(
    ask.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ConductorAskResponse"
  );
  assert.equal(ask.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(ask.responses?.["400"]);
  assert.ok(ask.responses?.["503"]);

  const fleet = operation(routes[1]);
  assert.equal(
    fleet.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ConductorFleetSnapshot"
  );
  assert.equal(fleet.responses?.["200"]?.["x-sensitive"], true);

  const create = operation(routes[2]);
  assert.equal(create.requestBody?.["x-sensitive"], true);
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ConductorTaskCreatedResponse"
  );
  assert.ok(create.responses?.["400"]);
  assert.ok(create.responses?.["502"]);
  assert.ok(create.responses?.["503"]);
  assert.ok(create.responses?.default);
  assert.equal(
    spec.components.schemas.ConductorTaskCreateRequest.properties.prompt["x-sensitive"],
    true
  );

  const detail = operation(routes[3]);
  assert.equal(
    detail.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ConductorTaskDetail"
  );
  assert.equal(detail.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(detail.responses?.["404"]);
  assert.equal(spec.components.schemas.ConductorTaskDetail.properties.prompt["x-sensitive"], true);

  const cancel = operation(routes[4]);
  assert.equal(
    cancel.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ConductorTaskCancelResponse"
  );
  assert.ok(cancel.responses?.default, "hub refusal status is sanitized and forwarded");
});

test("Conductor contracts are mirrored to the public OpenAPI document", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
