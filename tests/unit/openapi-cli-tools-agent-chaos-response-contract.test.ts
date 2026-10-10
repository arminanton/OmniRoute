import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const canonicalPath = path.join(ROOT, "docs/openapi.yaml");
const publicPath = path.join(ROOT, "public/openapi.yaml");
const canonicalText = fs.readFileSync(canonicalPath, "utf8");
const publicText = fs.readFileSync(publicPath, "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const statusContracts = [
  ["/api/acp/agents", "get", ["200", "401", "403", "500"]],
  ["/api/acp/agents", "post", ["200", "400", "401", "403", "409", "500"]],
  ["/api/acp/agents", "delete", ["200", "400", "401", "403", "404", "500"]],
  ["/api/assess", "get", ["200", "401", "403", "503"]],
  ["/api/assess", "post", ["200", "400", "401", "403", "500", "503"]],
  ["/api/chaos/run", "post", ["200", "400", "401", "403", "500", "503"]],
  ["/api/cli-tools/guide-settings/{toolId}", "post", ["200", "400", "401", "403", "422", "500", "503"]],
  ["/api/cli-tools/letta-settings", "get", ["200", "401", "403", "500", "503"]],
  ["/api/cli-tools/letta-settings", "post", ["200", "400", "401", "403", "409", "500", "503"]],
  ["/api/cli-tools/letta-settings", "delete", ["200", "401", "403", "500", "503"]],
  ["/api/cli-tools/logs", "get", ["200", "401", "403", "500", "503"]],
  ["/api/cli-tools/omp-settings", "get", ["200", "401", "403", "500", "503"]],
  ["/api/cli-tools/omp-settings", "post", ["200", "400", "401", "403", "500", "503"]],
  ["/api/cli-tools/omp-settings", "delete", ["200", "401", "403", "500", "503"]],
  ["/api/cli-tools/openclaw-settings", "delete", ["200", "401", "403", "500", "503"]],
] as const;

const successContracts = [
  ["/api/acp/agents", "get", "200", "AcpAgentRegistryGetResponse"],
  ["/api/acp/agents", "post", "200", "AcpAgentRegistryPostResponse"],
  ["/api/acp/agents", "delete", "200", "AcpAgentRegistryDeleteResponse"],
  ["/api/assess", "get", "200", "AssessmentGetResponse"],
  ["/api/assess", "post", "200", "AssessmentRunResponse"],
  ["/api/chaos/run", "post", "200", "ChaosRunResponse"],
  ["/api/cli-tools/guide-settings/{toolId}", "post", "200", "GuideSettingsSavedResponse"],
  ["/api/cli-tools/letta-settings", "get", "200", "LettaSettingsGetResponse"],
  ["/api/cli-tools/letta-settings", "post", "200", "LettaSettingsApplyResponse"],
  ["/api/cli-tools/letta-settings", "delete", "200", "LettaSettingsDeleteResponse"],
  ["/api/cli-tools/logs", "get", "200", "CliToolsLogEntriesResponse"],
  ["/api/cli-tools/omp-settings", "get", "200", "OmpSettingsGetResponse"],
  ["/api/cli-tools/omp-settings", "post", "200", "OmpSettingsApplyResponse"],
  ["/api/cli-tools/omp-settings", "delete", "200", "OmpSettingsDeleteResponse"],
  ["/api/cli-tools/openclaw-settings", "delete", "200", "OpenClawSettingsDeleteResponse"],
] as const;

function operation(pathname: string, method: string): any {
  const value = spec.paths[pathname]?.[method];
  assert.ok(value, `${method.toUpperCase()} ${pathname} must exist`);
  return value;
}

function schema(name: string): any {
  const value = spec.components.schemas[name];
  assert.ok(value, `components.schemas.${name} must exist`);
  return value;
}

function assertSchemaRef(pathname: string, method: string, status: string, component: string): void {
  assert.equal(
    operation(pathname, method).responses[status].content?.["application/json"]?.schema?.$ref,
    `#/components/schemas/${component}`,
    `${method.toUpperCase()} ${pathname} ${status} response schema`
  );
}

test("agent, assessment, chaos, and CLI settings response statuses match their handlers", () => {
  assert.equal(statusContracts.length, 15);
  assert.equal(successContracts.length, 15);

  for (const [pathname, method, expected] of statusContracts) {
    assert.deepEqual(
      Object.keys(operation(pathname, method).responses).sort(),
      [...expected].sort(),
      `${method.toUpperCase()} ${pathname} response statuses`
    );
  }
  for (const [pathname, method, status, component] of successContracts) {
    assertSchemaRef(pathname, method, status, component);
  }

  assert.deepEqual(
    schema("AcpAgentRegistryPostResponse").oneOf.map((entry: { $ref: string }) => entry.$ref),
    [
      "#/components/schemas/AcpAgentRegistryRefreshResponse",
      "#/components/schemas/AcpAgentRegistryAddResponse",
    ]
  );
  assert.deepEqual(
    schema("AssessmentGetResponse").oneOf.map((entry: { $ref: string }) => entry.$ref),
    [
      "#/components/schemas/AssessmentModelsResponse",
      "#/components/schemas/AssessmentComboHealthPlaceholderResponse",
      "#/components/schemas/AssessmentHelpResponse",
    ]
  );
  assert.deepEqual(
    schema("LettaSettingsGetResponse").oneOf.map((entry: { $ref: string }) => entry.$ref),
    [
      "#/components/schemas/LettaSettingsUninstalledResponse",
      "#/components/schemas/LettaSettingsInstalledResponse",
    ]
  );
  assert.deepEqual(
    schema("OmpSettingsGetResponse").oneOf.map((entry: { $ref: string }) => entry.$ref),
    [
      "#/components/schemas/OmpSettingsUninstalledResponse",
      "#/components/schemas/OmpSettingsInstalledResponse",
    ]
  );
  assert.deepEqual(schema("OpenClawSettingsDeleteResponse").properties.message.enum, [
    "No settings file to reset",
    "OmniRoute settings removed successfully",
  ]);
});

test("CLI logs preserve the conditional no-store header and raw log-array shape", () => {
  const logs = operation("/api/cli-tools/logs", "get").responses["200"];
  assert.equal(logs.content["application/json"].schema.$ref, "#/components/schemas/CliToolsLogEntriesResponse");
  assert.equal(
    logs.headers["Cache-Control"].schema.const,
    "no-store, no-cache, must-revalidate"
  );
  assert.match(logs.headers["Cache-Control"].description, /log file exists/i);
  assert.equal(schema("CliToolsLogEntriesResponse").type, "array");
  assert.equal(schema("CliToolsLogEntry")["x-sensitive"], true);
});

test("host-local credential and executable response values are explicitly sensitive", () => {
  assert.equal(operation("/api/acp/agents", "get")["x-local-only"], true);
  assert.equal(operation("/api/acp/agents", "post")["x-local-only"], true);
  assert.equal(operation("/api/acp/agents", "delete")["x-local-only"], true);
  assert.equal(schema("AcpAgentInfo").properties.binary["x-sensitive"], true);
  assert.equal(schema("AcpAgentInfo").properties.versionCommand["x-sensitive"], true);
  assert.equal(schema("AssessmentModel").properties.lastError["x-sensitive"], true);
  assert.equal(schema("ChaosRunResponse")["x-sensitive"], true);
  assert.equal(schema("ChaosModelResult").properties.content["x-sensitive"], true);
  assert.equal(schema("LettaSettingsInstalledResponse").properties.config["x-sensitive"], true);
  assert.equal(schema("OmpSettingsInstalledResponse").properties.config.properties.providers.properties.omniroute.properties.apiKey["x-sensitive"], true);
  assert.equal(schema("GuideSettingsSavedResponse").properties.configPath["x-sensitive"], true);
  assert.equal(operation("/api/cli-tools/letta-settings", "get")["x-local-only"], true);
  assert.equal(operation("/api/cli-tools/omp-settings", "get")["x-local-only"], true);
  assert.equal(operation("/api/cli-tools/logs", "get")["x-always-protected"], true);
  assert.equal(operation("/api/cli-tools/openclaw-settings", "delete")["x-always-protected"], true);
});

test("guide-settings and OpenClaw write guards preserve their distinct refusal variants", () => {
  const guide = operation("/api/cli-tools/guide-settings/{toolId}", "post").responses;
  assert.deepEqual(
    guide["403"].content["application/json"].schema.oneOf.map((entry: { $ref: string }) => entry.$ref),
    [
      "#/components/schemas/ApiErrorResponse",
      "#/components/schemas/CliConfigWriteRefusalResponse",
    ]
  );
  assert.equal(guide["422"].content["application/json"].schema.$ref,
    "#/components/schemas/CliConfigWriteRefusalResponse");
  const openclaw = operation("/api/cli-tools/openclaw-settings", "delete").responses;
  assert.equal(openclaw["403"].content["application/json"].schema.oneOf.length, 2);
  assertSchemaRef("/api/cli-tools/openclaw-settings", "delete", "500", "StringErrorResponse");
});

test("public OpenAPI mirror stays byte-identical to the canonical contract", () => {
  assert.equal(publicText, canonicalText);
});
