import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const canonicalText = fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const publicSpec = yaml.load(publicText) as { paths: Record<string, Record<string, any>> };

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function operation(pathname: string, method: string): Record<string, any> {
  const result = spec.paths[pathname]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathname}`);
  return result;
}

function schema(name: string): any {
  const result = spec.components.schemas[name];
  assert.ok(result, `missing components.schemas.${name}`);
  return result;
}

const SUCCESS_CONTRACTS = [
  ["/api/plugins", "get", "200", "PluginListResponse"],
  ["/api/plugins", "post", "201", "PluginInstallResponse"],
  ["/api/plugins/{name}", "delete", "200", "PluginLifecycleResponse"],
  ["/api/plugins/{name}", "get", "200", "PluginDetailsResponse"],
  ["/api/plugins/{name}/activate", "post", "200", "PluginLifecycleResponse"],
  ["/api/plugins/{name}/config", "get", "200", "PluginConfigResponse"],
  ["/api/plugins/{name}/config", "put", "200", "PluginConfigUpdateResponse"],
  ["/api/plugins/{name}/deactivate", "post", "200", "PluginLifecycleResponse"],
  ["/api/plugins/marketplace", "get", "200", "PluginMarketplaceListResponse"],
  ["/api/plugins/marketplace/install", "post", "201", "PluginMarketplaceInstallResponse"],
  ["/api/plugins/scan", "post", "200", "PluginScanResponse"],
] as const;

const MANAGEMENT_SCHEMES = [
  "BearerAuth",
  "ManagementGoogleApiKeyAuth",
  "ManagementAnthropicApiKeyAuth",
  "ManagementSessionAuth",
  "LocalCliTokenAuth",
  "InternalServiceTokenAuth",
];

function assertManagementLocalSecurity(op: Record<string, any>): void {
  assert.equal(op["x-local-only"], true, `${op.operationId} must remain LOCAL_ONLY`);
  for (const scheme of MANAGEMENT_SCHEMES) {
    assert.ok(
      op.security?.some((alternative: Record<string, unknown>) =>
        Object.hasOwn(alternative, scheme)
      ),
      `${op.operationId} must declare ${scheme}`
    );
  }
  assert.ok(
    op.security?.some(
      (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
    ),
    `${op.operationId} must preserve the local-open conditional-auth alternative`
  );
}

test("plugin response statuses, JSON media, and management/local-only security match handlers", () => {
  for (const [pathname, method, status, schemaName] of SUCCESS_CONTRACTS) {
    const op = operation(pathname, method);
    assertManagementLocalSecurity(op);
    assert.deepEqual(
      Object.keys(op.responses).filter((code) => /^2\d\d$/.test(code)),
      [status],
      `${method.toUpperCase()} ${pathname} success status`
    );
    assert.equal(
      op.responses[status]?.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${schemaName}`,
      `${method.toUpperCase()} ${pathname} success schema`
    );
  }

  assert.equal(
    operation("/api/plugins", "get").parameters[0].schema.enum.join(","),
    "installed,active,inactive,error"
  );
  assert.equal(operation("/api/plugins", "post").requestBody["x-sensitive"], true);
  assert.equal(
    operation("/api/plugins", "post").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/PluginLocalInstallRequest"
  );
  assert.equal(operation("/api/plugins/{name}/config", "put").requestBody["x-sensitive"], true);
  assert.equal(
    operation("/api/plugins/marketplace/install", "post").requestBody.content["application/json"]
      .schema.$ref,
    "#/components/schemas/PluginMarketplaceInstallRequest"
  );

  const installSource = source("src/app/api/plugins/route.ts");
  assert.match(installSource, /status: 201, headers: CORS_HEADERS/);
  assert.match(installSource, /formatPlugin\(plugin\)/);
  assert.match(
    source("src/app/api/plugins/marketplace/install/route.ts"),
    /NextResponse\.json\(result, \{ status: 201, headers: CORS_HEADERS \}\)/
  );
});

test("plugin details/config and scan schemas identify sensitive config and path diagnostics", () => {
  for (const [pathname, method] of [
    ["/api/plugins/{name}", "get"],
    ["/api/plugins/{name}/config", "get"],
    ["/api/plugins/{name}/config", "put"],
    ["/api/plugins/scan", "post"],
  ]) {
    assert.equal(
      operation(pathname, method).responses["200"]["x-sensitive"],
      true,
      `${method.toUpperCase()} ${pathname} response must be marked sensitive`
    );
  }

  const summary = schema("PluginSummary");
  for (const field of ["config", "configSchema", "pluginDir", "manifest", "errorMessage"]) {
    assert.equal(field in summary.properties, false, `safe list projection must omit ${field}`);
  }
  assert.deepEqual([...(summary.required ?? [])].includes("pluginDir"), false);

  const details = schema("PluginDetails");
  assert.equal(details.properties.config["x-sensitive"], true);
  assert.equal(details.properties.pluginDir["x-sensitive"], true);
  assert.equal(details.properties.errorMessage["x-sensitive"], true);
  assert.equal(
    "manifest" in details.properties,
    false,
    "details route does not return raw manifest"
  );

  const localInstall = schema("PluginLocalInstallRequest");
  assert.equal(localInstall.properties.path["x-sensitive"], true);
  assert.match(localInstall.properties.path.pattern, /^\^\//);

  const pluginRequest = source("src/app/api/plugins/route.ts");
  assert.match(pluginRequest, /Path must not contain traversal patterns or null bytes/);
  const scanSource = source("src/lib/plugins/scanner.ts");
  assert.match(scanSource, /error: `failed to read manifest: \$\{err\.message\}`/);
  assert.equal(schema("PluginScanError").properties.error["x-sensitive"], true);
});

test("plugin config, marketplace, and lifecycle schemas match route-owned projections", () => {
  const config = schema("PluginConfigResponse");
  assert.deepEqual([...(config.required ?? [])].sort(), ["config", "configSchema"]);
  assert.equal(config.properties.config["x-sensitive"], true);
  const configUpdate = schema("PluginConfigUpdateResponse");
  assert.equal(configUpdate.properties.config["x-sensitive"], true);

  const installRequest = schema("PluginMarketplaceInstallRequest");
  assert.deepEqual(installRequest.required, ["name"]);
  assert.equal(installRequest.properties.name.minLength, 1);
  const marketplaceEntry = schema("PluginMarketplaceEntry");
  assert.deepEqual(marketplaceEntry.required, ["name"]);
  assert.equal(marketplaceEntry.additionalProperties, true);
  assert.match(
    source("src/lib/plugins/marketplace.ts"),
    /typeof \(entry as Record<string, unknown>\)\.name === "string"/
  );

  const lifecycle = schema("PluginLifecycleResponse");
  assert.deepEqual([...(lifecycle.required ?? [])].sort(), ["message", "success"]);
  assert.equal(lifecycle.properties.success.const, true);
  assert.match(
    source("src/lib/plugins/marketplace.ts"),
    /return \{ name: result\.name, version: result\.version \}/
  );
});

test("all plugin operations retain the public OpenAPI mirror", () => {
  assert.equal(publicText, canonicalText);
  for (const [pathname] of SUCCESS_CONTRACTS) {
    assert.deepEqual(publicSpec.paths[pathname], spec.paths[pathname], `${pathname} mirror`);
  }
});
