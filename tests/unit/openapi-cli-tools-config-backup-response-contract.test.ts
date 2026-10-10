import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const publicSpec = yaml.load(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8"));

const contracts = [
  ["/api/cli-tools/apply", "post", "CliToolsApplyResponse"],
  ["/api/cli-tools/backups", "get", "CliToolBackupsListResponse"],
  ["/api/cli-tools/backups", "post", "CliToolBackupRestoreResponse"],
  ["/api/cli-tools/backups", "delete", "CliToolBackupDeleteResponse"],
  ["/api/cli-tools/config", "get", "CliToolsGeneratedConfigListResponse"],
  ["/api/cli-tools/config", "post", "CliToolsGeneratedConfigResponse"],
  ["/api/cli-tools/hermes-agent-settings", "get", "HermesAgentSettingsStatusResponse"],
  ["/api/cli-tools/hermes-agent-settings", "post", "HermesAgentSettingsApplyResponse"],
  ["/api/cli-tools/jcode-settings", "delete", "JcodeSettingsRemovedResponse"],
  ["/api/cli-tools/jcode-settings", "get", "CliToolTextSettingsStatusResponse"],
  ["/api/cli-tools/jcode-settings", "post", "JcodeSettingsAppliedResponse"],
  ["/api/cli-tools/kilo-settings", "delete", "KiloSettingsRemovedResponse"],
  ["/api/cli-tools/kilo-settings", "get", "KiloSettingsStatusResponse"],
  ["/api/cli-tools/kilo-settings", "post", "KiloSettingsAppliedResponse"],
  ["/api/cli-tools/openclaw/auto-order", "get", "OpenClawAutoOrderResponse"],
] as const;

function schema(name: string): any {
  const value = spec.components.schemas[name];
  assert.ok(value, `components.schemas.${name} must exist`);
  return value;
}

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function assertRequired(value: any, keys: string[], label: string): void {
  assert.deepEqual([...(value.required ?? [])].sort(), [...keys].sort(), `${label} required keys`);
}

test("CLI config, backup, and settings operations expose typed JSON 200 responses", () => {
  assert.equal(contracts.length, 15);
  for (const [route, method, component] of contracts) {
    const response = spec.paths[route]?.[method]?.responses?.["200"];
    assert.ok(response, `${method.toUpperCase()} ${route} declares 200`);
    assert.equal(
      response.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${component}`,
      `${method.toUpperCase()} ${route} response schema`
    );
    assert.equal(response.content?.["text/event-stream"], undefined);
  }
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact mirrors the canonical document");
});

test("apply, backup, and generated config schemas retain their actual response unions and sensitivity", () => {
  const apply = schema("CliToolsApplyResponse");
  assert.deepEqual(
    apply.oneOf.map((item: { $ref: string }) => item.$ref),
    [
      "#/components/schemas/CliToolsApplyDryRunResponse",
      "#/components/schemas/CliToolsApplyWrittenResponse",
    ]
  );
  assert.equal(schema("CliToolsApplyDryRunResponse").properties.dryRun.const, true);
  assert.equal(schema("CliToolsApplyDryRunResponse").properties.content["x-sensitive"], true);
  assert.deepEqual(schema("CliToolsApplyWrittenResponse").properties.backupPath.type, [
    "string",
    "null",
  ]);

  const backups = schema("CliToolBackupsListResponse");
  assert.deepEqual(
    backups.oneOf.map((item: { $ref: string }) => item.$ref),
    [
      "#/components/schemas/CliToolBackupsForOneToolResponse",
      "#/components/schemas/CliToolBackupsForAllToolsResponse",
    ]
  );
  assert.equal(schema("CliToolBackupEntry").properties.originalPath["x-sensitive"], true);
  assertRequired(
    schema("CliToolBackupRestoreResponse"),
    ["success", "message", "restored", "backupId", "originalPath"],
    "backup restore"
  );
  assert.equal(schema("CliToolBackupRestoreResponse").properties.originalPath["x-sensitive"], true);
  assertRequired(
    schema("CliToolBackupDeleteResponse"),
    ["success", "message", "deleted", "backupId"],
    "backup delete"
  );

  const generatedResult = schema("CliToolsGeneratedConfigResult");
  assert.deepEqual(generatedResult.oneOf.length, 2);
  assert.equal(schema("CliToolsGeneratedConfigSuccess").properties.content["x-sensitive"], true);
  assert.equal(schema("CliToolsGeneratedConfigSuccess").properties.configPath["x-sensitive"], true);
  assert.equal(schema("CliToolsGeneratedConfigFailure").properties.success.const, false);
  assert.equal(schema("CliToolsGeneratedConfigFailure").properties.error.type, "string");
  assert.equal(schema("CliToolsGeneratedConfigResponse").properties.content["x-sensitive"], true);
});

test("Hermes Agent, JCode, Kilo, and OpenClaw statuses model nullable and alternative results", () => {
  const hermesStatus = schema("HermesAgentSettingsStatusResponse");
  assertRequired(hermesStatus, ["success", "roles", "firstSetupAt"], "Hermes Agent status");
  assert.deepEqual(hermesStatus.properties.firstSetupAt.type, ["string", "null"]);
  assert.equal(
    schema("HermesAgentRoleSettings").additionalProperties.required.includes("model"),
    true
  );
  assert.deepEqual(schema("HermesAgentSettingsApplyResponse").oneOf.length, 2);
  assert.equal(schema("HermesAgentSettingsPreviewResponse").properties.yaml["x-sensitive"], true);
  assert.equal(
    schema("HermesAgentSettingsSavedResponse").properties.configPath["x-sensitive"],
    true
  );

  const jcodeStatus = schema("CliToolTextSettingsStatusResponse");
  assert.deepEqual(jcodeStatus.oneOf.length, 2);
  assert.deepEqual(schema("CliToolTextSettingsReadyResponse").properties.config.type, [
    "string",
    "null",
  ]);
  assert.equal(schema("CliToolTextSettingsReadyResponse").properties.config["x-sensitive"], true);
  assertRequired(
    schema("JcodeSettingsAppliedResponse"),
    ["success", "message", "configPath"],
    "JCode apply"
  );
  assert.deepEqual(schema("JcodeSettingsRemovedResponse").properties.message.enum, [
    "No config file to reset",
    "jcode OmniRoute settings removed",
  ]);

  assert.deepEqual(schema("KiloSettingsStatusResponse").oneOf.length, 2);
  assert.equal(schema("KiloSettingsUnavailableResponse").properties.settings.type, "null");
  assert.equal(
    schema("KiloSettingsReadyResponse").properties.settings.properties.extensionSettings[
      "x-sensitive"
    ],
    true
  );
  assert.equal(schema("KiloSettingsReadyResponse").properties.authPath["x-sensitive"], true);
  assert.deepEqual(schema("KiloSettingsRemovedResponse").properties.message.enum, [
    "No settings file to reset",
    "OmniRoute settings removed from Kilo Code",
  ]);

  assert.deepEqual(schema("OpenClawAutoOrderResponse").oneOf.length, 2);
  assert.equal(
    schema("OpenClawAutoOrderGeneratedResponse").properties.source.const,
    "omniroute-auto-combo"
  );
  assert.equal(
    schema("OpenClawAutoOrderFallbackResponse").properties.source.const,
    "omniroute-fallback"
  );
  assert.deepEqual(
    schema("OpenClawAutoOrderFallbackResponse").properties.provider.allOf[1].properties.order.const,
    ["anthropic", "google", "openai"]
  );
});

test("response and locality contracts are grounded in the CLI tool handlers", () => {
  assert.match(source("src/app/api/cli-tools/apply/route.ts"), /dryRun\s*\)/);
  assert.match(
    source("src/app/api/cli-tools/apply/route.ts"),
    /backupPath,\s*content: result\.content/
  );
  assert.match(
    source("src/app/api/cli-tools/config/route.ts"),
    /generateAllConfigs\(\{ baseUrl, apiKey \}\)/
  );
  assert.match(
    source("src/lib/cli-helper/config-generator/index.ts"),
    /export interface GenerateResult/
  );
  assert.match(source("src/shared/services/backupService.ts"), /originalPath: filePath/);
  assert.match(
    source("src/shared/services/backupService.ts"),
    /return \{\s*restored: true,\s*backupId,\s*originalPath: meta\.originalPath/s
  );
  assert.match(
    source("src/app/api/cli-tools/hermes-agent-settings/route.ts"),
    /yaml: result\.yaml/
  );
  assert.match(source("src/app/api/cli-tools/jcode-settings/route.ts"), /config,\s*hasOmniRoute/);
  assert.match(
    source("src/app/api/cli-tools/kilo-settings/route.ts"),
    /auth: auth \? Object\.keys\(auth\)/
  );
  assert.match(
    source("src/app/api/cli-tools/openclaw/auto-order/route.ts"),
    /source: "omniroute-fallback"/
  );

  const applyRequest = schema("CliToolsApplyRequest");
  assert.equal(applyRequest.properties.apiKey.writeOnly, true);
  assert.equal(applyRequest.properties.apiKey["x-sensitive"], true);
  const hermesRequest = schema("HermesAgentSettingsRequest");
  assert.equal(hermesRequest.properties.apiKey.writeOnly, true);
  assert.equal(hermesRequest.properties.apiKey["x-sensitive"], true);
  assert.equal(hermesRequest.properties.selections.items.additionalProperties, true);
  for (const route of ["/api/cli-tools/jcode-settings", "/api/cli-tools/kilo-settings"]) {
    const bodySchema = spec.paths[route].post.requestBody.content["application/json"].schema;
    assert.equal(bodySchema.$ref, "#/components/schemas/CliModelConfigRequest");
    assert.equal(schema("CliModelConfigRequest").properties.apiKey.writeOnly, true);
    assert.equal(schema("CliModelConfigRequest").properties.apiKey["x-sensitive"], true);
  }

  for (const method of ["get", "post", "delete"]) {
    assert.equal(spec.paths["/api/cli-tools/jcode-settings"][method]["x-local-only"], true);
  }
  for (const route of [
    "/api/cli-tools/backups",
    "/api/cli-tools/hermes-agent-settings",
    "/api/cli-tools/kilo-settings",
  ]) {
    for (const operation of Object.values(spec.paths[route])) {
      if (!operation || typeof operation !== "object" || !("responses" in operation)) continue;
      assert.equal((operation as Record<string, any>)["x-always-protected"], true, route);
      assert.equal(
        (operation as Record<string, any>).security?.some(
          (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
        ),
        false,
        `${route} remains always-protected`
      );
    }
  }
  const protectedOperations = [
    ["/api/cli-tools/apply", "post"],
    ["/api/cli-tools/backups", "get"],
    ["/api/cli-tools/backups", "post"],
    ["/api/cli-tools/backups", "delete"],
    ["/api/cli-tools/hermes-agent-settings", "get"],
    ["/api/cli-tools/hermes-agent-settings", "post"],
    ["/api/cli-tools/kilo-settings", "get"],
    ["/api/cli-tools/kilo-settings", "post"],
    ["/api/cli-tools/kilo-settings", "delete"],
  ];
  for (const [route, method] of protectedOperations) {
    const operation = spec.paths[route][method];
    assert.equal(operation["x-always-protected"], true, `${method.toUpperCase()} ${route}`);
    assert.equal(
      operation.security.some(
        (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
      ),
      false,
      `${method.toUpperCase()} ${route} does not allow anonymous access`
    );
  }
  for (const [route, method] of [
    ["/api/cli-tools/config", "get"],
    ["/api/cli-tools/config", "post"],
    ["/api/cli-tools/openclaw/auto-order", "get"],
  ]) {
    const operation = spec.paths[route][method];
    assert.ok(
      operation.security.some(
        (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
      ),
      `${method.toUpperCase()} ${route} keeps the helper's conditional anonymous alternative`
    );
  }
});
