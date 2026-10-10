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
  { file: "src/app/api/a2a/tasks/route.ts", method: "get", path: "/api/a2a/tasks" },
  { file: "src/app/api/a2a/tasks/route.ts", method: "post", path: "/api/a2a/tasks" },
  { file: "src/app/api/a2a/tasks/[id]/route.ts", method: "get", path: "/api/a2a/tasks/{id}" },
  {
    file: "src/app/api/a2a/tasks/[id]/cancel/route.ts",
    method: "post",
    path: "/api/a2a/tasks/{id}/cancel",
  },
  {
    file: "src/app/api/a2a/tasks/history/route.ts",
    method: "get",
    path: "/api/a2a/tasks/history",
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
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

test("A2A task OpenAPI operations match the source routes and conditional auth posture", () => {
  const documented = new Set(routes.map(({ method, path }) => `${method} ${path}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(documented.size, 5);

  for (const route of routes.filter(
    (candidate) => !(candidate.path === "/api/a2a/tasks" && candidate.method === "post")
  )) {
    const method = route.method.toUpperCase();
    const op = operation(route);
    assert.equal(classifyRoute(route.path, method).routeClass, "MANAGEMENT");
    assert.equal(isLocalOnlyPath(route.path, method), false);
    assert.equal(isAlwaysProtectedPath(route.path), false);
    assert.equal(inferRequiredScope(method, route.path), method === "GET" ? "read" : "write");
    for (const scheme of [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
      "ManagementGoogleApiKeyAuth",
      "ManagementAnthropicApiKeyAuth",
    ]) {
      assert.ok(
        op.security?.some((entry: Record<string, unknown>) => scheme in entry),
        `${method} ${route.path} must document ${scheme}`
      );
    }
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${method} ${route.path} may be anonymous in the unlocked keyless profile`
    );
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.ok(op.responses?.["401"] && op.responses?.["403"] && op.responses?.["503"]);
  }

  const create = operation(routes[1]);
  assert.ok(
    create.security?.some((entry: Record<string, unknown>) => "BearerAuth" in entry),
    "POST must document its Authorization Bearer A2A key"
  );
  assert.equal(
    create.security?.some(
      (entry: Record<string, unknown>) =>
        "ManagementGoogleApiKeyAuth" in entry || "ManagementAnthropicApiKeyAuth" in entry
    ),
    false,
    "the route-local OMNIROUTE_API_KEY gate accepts only the exact Authorization Bearer value"
  );
  assert.match(create.description, /exact configured value as an Authorization Bearer token/i);
  assert.match(create.description, /does not satisfy the extra A2A gate/i);
  assert.match(
    fs.readFileSync(path.join(ROOT, "src/app/api/a2a/tasks/route.ts"), "utf8"),
    /authenticateA2A\(request\)/
  );

  assert.match(operation(routes[0]).description, /owner-scoped/i);
  assert.match(operation(routes[0]).description, /before owner filtering/i);
  assert.match(operation(routes[1]).description, /OMNIROUTE_API_KEY/);

  const history = operation(routes[4]);
  assert.match(history.description, /REQUIRE_API_KEY/);
  assert.match(history.description, /REQUIRE_API_KEY disabled/i);
  assert.match(history.description, /requireLogin=false/);
  assert.match(history.description, /local-first/i);
  assert.match(history.description, /owner-scoped/i);
});

test("A2A task contracts describe sensitive task payloads, owner fields, and delegation validation", () => {
  const list = operation(routes[0]);
  assert.equal(
    list.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/A2ATaskListResponse"
  );
  assert.equal(list.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(list.parameters?.some((parameter: any) => parameter.name === "state"));
  assert.ok(list.parameters?.some((parameter: any) => parameter.name === "skill"));

  const create = operation(routes[1]);
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/A2ATaskDelegationRequest"
  );
  assert.equal(create.requestBody?.["x-sensitive"], true);
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/A2ATaskDelegationResponse"
  );
  assert.ok(create.responses?.["400"] && create.responses?.default);

  const detail = operation(routes[2]);
  assert.equal(
    detail.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/A2ATaskDetailResponse"
  );
  assert.ok(detail.responses?.["404"]);
  assert.equal(spec.components.schemas.A2ATask.properties.owner["x-sensitive"], true);
  assert.equal(spec.components.schemas.A2ATask.properties.input["x-sensitive"], undefined);
  assert.equal(
    spec.components.schemas.A2ATaskInput.properties.messages.items.$ref,
    "#/components/schemas/A2ATaskMessage"
  );
  assert.equal(spec.components.schemas.A2ATaskMessage.properties.content["x-sensitive"], true);

  const cancel = operation(routes[3]);
  assert.equal(
    cancel.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/A2ATaskCancelResponse"
  );
  assert.ok(cancel.responses?.["400"] && cancel.responses?.["404"]);
});

test("A2A task OpenAPI changes are mirrored to the public artifact", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
