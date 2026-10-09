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
const ROUTE = "/api/cli-tools/claude-settings";
const ROUTE_FILE = "src/app/api/cli-tools/claude-settings/route.ts";
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

test("Claude settings operations match the management route and conditional auth scope", () => {
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

test("Claude settings schemas document raw settings exposure, key resolution, and reset behavior", () => {
  const read = operation("get");
  assert.equal(
    read.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ClaudeCliSettingsStatusResponse"
  );
  assert.equal(read.responses?.["200"]?.["x-sensitive"], true);
  assert.equal(
    spec.components.schemas.ClaudeCliSettingsStatusResponse.properties.settings["x-sensitive"],
    true
  );
  const responseSchema = spec.components.schemas.ClaudeCliSettingsStatusResponse;
  assert.deepEqual(responseSchema.required, [
    "installed",
    "runnable",
    "command",
    "commandPath",
    "runtimeMode",
    "reason",
    "settings",
  ]);
  assert.equal(responseSchema.properties.requiresBinary, undefined);
  assert.equal(responseSchema.properties.version, undefined);
  assert.deepEqual(responseSchema.properties.settingsPath.type, ["string", "null"]);
  assert.equal(responseSchema.additionalProperties, false);

  const routeSource = fs.readFileSync(path.join(ROOT, ROUTE_FILE), "utf8");
  const getSource = routeSource.slice(
    routeSource.indexOf("export async function GET"),
    routeSource.indexOf("// POST - Backup old fields")
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
  assert.ok(getSource.includes("settings: settings"));
  assert.ok(getSource.includes("hasOmniRoute: hasOmniRoute"));
  assert.ok(getSource.includes("settingsPath: getClaudeSettingsPath()"));
  assert.doesNotMatch(getSource, /\b(?:requiresBinary|version):/);
  assert.match(read.description, /not marked LOCAL_ONLY or ALWAYS_PROTECTED/i);

  const write = operation("post");
  assert.equal(
    write.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ClaudeSettingsUpdateRequest"
  );
  assert.equal(write.requestBody?.["x-sensitive"], true);
  assert.equal(
    write.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ClaudeSettingsUpdateResponse"
  );
  assert.ok(write.responses?.["400"] && write.responses?.["403"] && write.responses?.["500"]);
  assert.ok(
    spec.components.schemas.ClaudeSettingsUpdateRequest.properties.keyId,
    "keyId is consumed before Zod strips unknown properties"
  );
  assert.equal(spec.components.schemas.ClaudeSettingsUpdateRequest.properties.env.minProperties, 1);
  assert.equal(
    spec.components.schemas.ClaudeSettingsUpdateRequest.properties.env.propertyNames.pattern,
    "^[A-Z_][A-Z0-9_]*$"
  );

  const reset = operation("delete");
  assert.equal(
    reset.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ClaudeSettingsResetResponse"
  );
  assert.deepEqual(spec.components.schemas.ClaudeSettingsResetResponse.properties.message.enum, [
    "Settings reset successfully",
    "No settings file to reset",
  ]);
});

test("Claude settings OpenAPI contracts mirror in the public artifact", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
