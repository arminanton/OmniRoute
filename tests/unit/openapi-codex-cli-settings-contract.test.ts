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
const ROUTE = "/api/cli-tools/codex-settings";
const ROUTE_FILE = "src/app/api/cli-tools/codex-settings/route.ts";
const METHODS = ["get", "post", "delete"] as const;
const AUTH_SCHEMES = [
  "BearerAuth",
  "ManagementSessionAuth",
  "LocalCliTokenAuth",
  "InternalServiceTokenAuth",
];

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

test("Codex CLI settings operations match the conditionally authenticated source route", () => {
  const documented = new Set(METHODS.map((method) => `${method} ${ROUTE}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(documented.size, 3);
  assert.equal(classifyRoute(ROUTE, "GET").routeClass, "MANAGEMENT");
  assert.equal(isAlwaysProtectedPath(ROUTE), false);
  assert.equal(isLocalOnlyPath(ROUTE, "GET"), false);

  const expectedAccessTokenScope = { get: "read", post: "write", delete: "write" } as const;
  for (const method of METHODS) {
    const upper = method.toUpperCase();
    const op = operation(method);
    assert.equal(inferRequiredScope(upper, ROUTE), expectedAccessTokenScope[method]);
    assert.match(
      op.description ?? "",
      /requireLogin=false.*bypasses credentials regardless of peer address/s
    );
    assert.match(
      op.description ?? "",
      /fresh,? incomplete setup[\s\S]+anonymous loopback bootstrap access/
    );
    assert.match(op.description ?? "", /neither loopback-only nor always-protected/s);
    for (const scheme of AUTH_SCHEMES) {
      assert.ok(
        op.security?.some((alternative: Record<string, unknown>) => scheme in alternative),
        `${upper} must document ${scheme}`
      );
    }
    assert.ok(
      op.security?.some(
        (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
      ),
      `${upper} preserves anonymous access when requireLogin=false`
    );
    assert.ok(op.responses?.["401"] && op.responses?.["403"] && op.responses?.["503"]);
  }

  const authSource = fs.readFileSync(path.join(ROOT, "src/lib/api/requireCliToolsAuth.ts"), "utf8");
  assert.match(authSource, /return requireManagementAuth\(request\);/);
  assert.doesNotMatch(authSource, /alwaysRequireAuth:\s*true/);
  const managementAuthSource = fs.readFileSync(
    path.join(ROOT, "src/lib/api/requireManagementAuth.ts"),
    "utf8"
  );
  assert.match(
    managementAuthSource,
    /!lockedManagementAuth && !options\.alwaysRequireAuth && !\(await isAuthRequired\(request\)\)/
  );
  const authPolicySource = fs.readFileSync(path.join(ROOT, "src/shared/utils/apiAuth.ts"), "utf8");
  assert.match(authPolicySource, /if \(settings\.requireLogin === false\) return false/);
  assert.match(
    authPolicySource,
    /return settings\.setupComplete === true \|\| !isLoopbackRequest\(request\)/
  );
});

test("Codex settings schemas match the exact status projection, file writes, and reset behavior", () => {
  const get = operation("get");
  assert.equal(
    get.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexCliSettingsStatusResponse"
  );
  assert.equal(get.responses?.["200"]?.["x-sensitive"], true);
  assert.deepEqual(spec.components.schemas.CodexCliSettingsUnavailableStatusResponse.required, [
    "installed",
    "runnable",
    "command",
    "commandPath",
    "runtimeMode",
    "reason",
    "config",
    "message",
  ]);
  assert.equal(
    spec.components.schemas.CodexCliSettingsUnavailableStatusResponse.properties.config.type,
    "null"
  );
  assert.deepEqual(spec.components.schemas.CodexCliSettingsReadyStatusResponse.required, [
    "installed",
    "runnable",
    "command",
    "commandPath",
    "runtimeMode",
    "reason",
    "config",
    "hasOmniRoute",
    "configPath",
  ]);
  assert.deepEqual(
    spec.components.schemas.CodexCliSettingsReadyStatusResponse.properties.config.type,
    ["string", "null"]
  );
  assert.equal(
    spec.components.schemas.CodexCliSettingsReadyStatusResponse.properties.config["x-sensitive"],
    true
  );
  assert.ok(get.responses?.["500"] && get.responses?.["503"]);

  const post = operation("post");
  assert.equal(post.requestBody?.["x-sensitive"], true);
  assert.equal(
    post.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexSettingsUpdateRequest"
  );
  const input = spec.components.schemas.CodexSettingsUpdateRequest;
  assert.deepEqual(input.required, ["baseUrl", "apiKey", "model"]);
  assert.equal(input.properties.apiKey["x-sensitive"], true);
  assert.equal(input.properties.wireApi.default, "responses");
  assert.deepEqual(input.properties.reasoningEffort.enum, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
  ]);
  assert.equal(input.additionalProperties, true);
  assert.equal(
    post.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexSettingsUpdateResponse"
  );
  assert.equal(post.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(post.responses?.["400"] && post.responses?.["403"] && post.responses?.["500"]);

  const reset = operation("delete");
  assert.equal(
    reset.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CodexSettingsResetResponse"
  );
  assert.deepEqual(spec.components.schemas.CodexSettingsResetResponse.properties.message.enum, [
    "OmniRoute settings removed successfully",
    "No config file to reset",
  ]);

  const source = fs.readFileSync(path.join(ROOT, ROUTE_FILE), "utf8");
  assert.equal((source.match(/requireCliToolsAuth\(request\)/g) ?? []).length, 3);
  assert.ok(source.includes('getCliRuntimeStatus("codex")'));
  const getSource = source.slice(
    source.indexOf("export async function GET"),
    source.indexOf("// POST - Update OmniRoute settings")
  );
  assert.ok(getSource.includes("config: null"));
  assert.ok(getSource.includes("hasOmniRoute: hasOmniRouteConfig(config)"));
  assert.ok(getSource.includes("configPath: getCodexConfigPath()"));
  const runtimeSource = fs.readFileSync(
    path.join(ROOT, "src/shared/services/cliRuntime.ts"),
    "utf8"
  );
  assert.ok(runtimeSource.includes('for (const args of [["--version"], ["-v"]])'));

  const postSource = source.slice(
    source.indexOf("export async function POST"),
    source.indexOf("// DELETE - Remove OmniRoute settings only")
  );
  assert.ok(
    postSource.indexOf("const keyId =") < postSource.indexOf("validateBody(cliModelConfigSchema")
  );
  assert.ok(postSource.includes("if (!apiKey)"));
  assert.ok(postSource.includes('createMultiBackup("codex", [configPath, authPath])'));
  assert.ok(postSource.includes("authData.OPENAI_API_KEY = apiKey"));
  assert.match(postSource, /message:\s*"Codex settings applied successfully!"/);
  assert.doesNotMatch(postSource, /return NextResponse\.json\(\{\s*apiKey/);

  const deleteSource = source.slice(source.indexOf("export async function DELETE"));
  assert.ok(deleteSource.includes('createMultiBackup("codex", [configPath, getCodexAuthPath()])'));
  assert.ok(deleteSource.includes('delete parsed._sections["model_providers.omniroute"]'));
  assert.ok(deleteSource.includes("delete authData.OPENAI_API_KEY"));
  assert.ok(deleteSource.includes('message: "No config file to reset"'));
  assert.ok(
    deleteSource.indexOf('message: "No config file to reset"') <
      deleteSource.indexOf("delete authData.OPENAI_API_KEY"),
    "the missing-config early return occurs before auth.json is edited"
  );

  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
