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
const ROUTE = "/api/cli-tools/droid-settings";
const ROUTE_FILE = "src/app/api/cli-tools/droid-settings/route.ts";
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
    if (relativeFile !== ROUTE_FILE) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const apiPath of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${apiPath}`);
      }
    }
  }
  return result;
}

test("Droid settings operations match the management route and conditional auth scopes", () => {
  const documented = new Set(METHODS.map((method) => `${method} ${ROUTE}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(documented.size, 3);

  for (const method of METHODS) {
    const upper = method.toUpperCase();
    const op = operation(method);
    assert.equal(classifyRoute(ROUTE, upper).routeClass, "MANAGEMENT");
    assert.equal(isAlwaysProtectedPath(ROUTE), false);
    assert.equal(isLocalOnlyPath(ROUTE, upper), false);
    assert.equal(inferRequiredScope(upper, ROUTE), method === "get" ? "read" : "write");
    for (const scheme of [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
    ]) {
      assert.ok(
        op.security?.some((entry: Record<string, unknown>) => scheme in entry),
        `${upper} must document ${scheme}`
      );
    }
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${upper} may be anonymous when requireLogin=false`
    );
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.ok(op.responses?.["401"] && op.responses?.["403"] && op.responses?.["503"]);
  }
});

test("Droid settings schemas reflect the exact status projection and API-key side effects", () => {
  const read = operation("get");
  assert.equal(
    read.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/DroidCliSettingsStatusResponse"
  );
  assert.equal(read.responses?.["200"]?.["x-sensitive"], true);
  const status = spec.components.schemas.DroidCliSettingsStatusResponse;
  assert.deepEqual(status.required, [
    "installed",
    "runnable",
    "command",
    "commandPath",
    "runtimeMode",
    "reason",
    "settings",
  ]);
  assert.equal(status.properties.requiresBinary, undefined);
  assert.equal(status.properties.version, undefined);
  assert.equal(status.properties.settings["x-sensitive"], true);
  assert.equal(status.additionalProperties, false);

  const source = fs.readFileSync(path.join(ROOT, ROUTE_FILE), "utf8");
  const getSource = source.slice(
    source.indexOf("export async function GET"),
    source.indexOf("// POST - Update OmniRoute customModels")
  );
  for (const field of [
    "installed",
    "runnable",
    "command",
    "commandPath",
    "runtimeMode",
    "reason",
  ]) {
    assert.ok(getSource.includes(`${field}: runtime.${field}`), `GET must project ${field}`);
  }
  assert.ok(getSource.includes("settings: null"));
  assert.ok(getSource.includes("hasOmniRoute: hasOmniRouteConfig(settings)"));
  assert.ok(getSource.includes("settingsPath: getDroidSettingsPath()"));
  assert.doesNotMatch(getSource, /\b(?:requiresBinary|version):/);

  const apply = operation("post");
  assert.equal(
    apply.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/DroidSettingsUpdateRequest"
  );
  assert.equal(apply.requestBody?.["x-sensitive"], true);
  assert.equal(
    apply.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/DroidSettingsUpdateResponse"
  );
  assert.ok(apply.responses?.["400"] && apply.responses?.["403"] && apply.responses?.["500"]);
  const request = spec.components.schemas.DroidSettingsUpdateRequest;
  assert.deepEqual(request.required, ["baseUrl", "model"]);
  assert.ok(request.properties.apiKey["x-sensitive"]);
  assert.ok(request.properties.keyId);
  assert.equal(request.properties.models.minItems, 1);
  assert.equal(request.properties.wireApi.enum.join(","), "chat,responses");
  assert.equal(request.properties.modelMappings.additionalProperties.type, "string");

  const reset = operation("delete");
  assert.equal(
    reset.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/DroidSettingsResetResponse"
  );
  assert.deepEqual(spec.components.schemas.DroidSettingsResetResponse.properties.message.enum, [
    "OmniRoute settings removed successfully",
    "No settings file to reset",
  ]);
});

test("Droid settings OpenAPI contracts mirror in the public artifact", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
