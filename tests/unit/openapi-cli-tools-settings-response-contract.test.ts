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

const responseContracts = [
  ["/api/cli-tools/codewhale-settings", "get", "CliToolTextSettingsStatusResponse"],
  ["/api/cli-tools/codewhale-settings", "post", "CodeWhaleSettingsAppliedResponse"],
  ["/api/cli-tools/codewhale-settings", "delete", "CodeWhaleSettingsRemovedResponse"],
  ["/api/cli-tools/crush-settings", "get", "CliToolJsonSettingsStatusResponse"],
  ["/api/cli-tools/crush-settings", "post", "CrushSettingsAppliedResponse"],
  ["/api/cli-tools/crush-settings", "delete", "CrushSettingsRemovedResponse"],
  ["/api/cli-tools/deepseek-tui-settings", "get", "CliToolTextSettingsStatusResponse"],
  ["/api/cli-tools/deepseek-tui-settings", "post", "DeepseekTuiSettingsAppliedResponse"],
  ["/api/cli-tools/deepseek-tui-settings", "delete", "DeepseekTuiSettingsRemovedResponse"],
  ["/api/cli-tools/forge-settings", "get", "CliToolTextSettingsStatusResponse"],
  ["/api/cli-tools/forge-settings", "post", "ForgeSettingsAppliedResponse"],
  ["/api/cli-tools/forge-settings", "delete", "ForgeSettingsRemovedResponse"],
  ["/api/cli-tools/grok-build-settings", "get", "GrokBuildSettingsStatusResponse"],
  ["/api/cli-tools/grok-build-settings", "post", "GrokBuildSettingsAppliedResponse"],
  ["/api/cli-tools/grok-build-settings", "delete", "GrokBuildSettingsRemovedResponse"],
] as const;

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function schema(name: string): any {
  const value = spec.components.schemas[name];
  assert.ok(value, `components.schemas.${name} must exist`);
  return value;
}

function assertRequired(value: any, keys: string[], label: string): void {
  assert.deepEqual([...(value.required ?? [])].sort(), [...keys].sort(), `${label} required keys`);
}

test("CLI tool settings operations expose their source-backed JSON 200 response schemas", () => {
  assert.equal(responseContracts.length, 15);

  for (const [route, method, component] of responseContracts) {
    const operation = spec.paths[route]?.[method];
    assert.ok(operation, `${method.toUpperCase()} ${route} must be documented`);
    assert.equal(
      operation.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${component}`,
      `${method.toUpperCase()} ${route} success response schema`
    );
  }

  for (const route of [
    "/api/cli-tools/codewhale-settings",
    "/api/cli-tools/crush-settings",
    "/api/cli-tools/deepseek-tui-settings",
  ]) {
    const operations = spec.paths[route];
    for (const method of ["get", "post", "delete"]) {
      const operation = operations[method];
      assert.equal(operation["x-always-protected"], true, `${method.toUpperCase()} ${route}`);
      assert.ok(
        operation.security?.some(
          (requirement: Record<string, unknown>) => "BearerAuth" in requirement
        )
      );
      assert.ok(
        operation.security?.some(
          (requirement: Record<string, unknown>) => "ManagementSessionAuth" in requirement
        )
      );
      assert.ok(
        operation.security?.some(
          (requirement: Record<string, unknown>) => "LocalCliTokenAuth" in requirement
        )
      );
      assert.ok(
        operation.security?.some(
          (requirement: Record<string, unknown>) => "InternalServiceTokenAuth" in requirement
        )
      );
      assert.equal(
        operation.security?.some(
          (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
        ),
        false,
        `${method.toUpperCase()} ${route} does not allow anonymous access`
      );
    }
  }

  for (const route of ["/api/cli-tools/forge-settings", "/api/cli-tools/grok-build-settings"]) {
    for (const method of ["get", "post", "delete"]) {
      const operation = spec.paths[route][method];
      assert.equal(operation["x-local-only"], true, `${method.toUpperCase()} ${route}`);
      for (const scheme of [
        "BearerAuth",
        "ManagementSessionAuth",
        "LocalCliTokenAuth",
        "InternalServiceTokenAuth",
        "ManagementGoogleApiKeyAuth",
        "ManagementAnthropicApiKeyAuth",
      ]) {
        assert.ok(
          operation.security?.some((requirement: Record<string, unknown>) => scheme in requirement),
          `${method.toUpperCase()} ${route} must preserve ${scheme}`
        );
      }
      assert.ok(
        operation.security?.some(
          (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
        ),
        `${method.toUpperCase()} ${route} retains its conditional anonymous alternative behind LOCAL_ONLY`
      );
    }
  }

  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror the canonical document");
});

test("settings GET contracts distinguish unavailable, raw text, raw JSON, and redacted Grok Build states", () => {
  const unavailable = schema("CliToolSettingsUnavailableResponse");
  assertRequired(
    unavailable,
    [
      "installed",
      "runnable",
      "command",
      "commandPath",
      "runtimeMode",
      "reason",
      "config",
      "message",
    ],
    "unavailable CLI settings"
  );
  assert.equal(unavailable.properties.runnable.const, false);
  assert.equal(unavailable.properties.config.type, "null");

  const textReady = schema("CliToolTextSettingsReadyResponse");
  assertRequired(
    textReady,
    [
      "installed",
      "runnable",
      "command",
      "commandPath",
      "runtimeMode",
      "reason",
      "config",
      "hasOmniRoute",
      "configPath",
    ],
    "ready TOML settings"
  );
  assert.deepEqual(textReady.properties.config.type, ["string", "null"]);
  assert.equal(textReady.properties.config["x-sensitive"], true);
  assert.equal(textReady.properties.configPath["x-sensitive"], true);
  assert.deepEqual(schema("CliToolTextSettingsStatusResponse").oneOf.length, 2);

  const jsonReady = schema("CliToolJsonSettingsReadyResponse");
  assert.deepEqual(jsonReady.properties.config.type, ["object", "null"]);
  assert.equal(jsonReady.properties.config["x-sensitive"], true);
  assert.equal(schema("CliToolJsonSettingsStatusResponse").oneOf.length, 2);

  const grok = schema("GrokBuildSettingsStatusResponse");
  assertRequired(
    grok,
    [
      "installed",
      "runnable",
      "command",
      "commandPath",
      "runtimeMode",
      "requiresBinary",
      "config",
      "settings",
      "hasOmniRoute",
      "apiKeyConfigured",
      "configPath",
    ],
    "Grok Build settings"
  );
  assert.equal(grok.properties.apiKeyConfigured.type, "boolean");
  assert.equal(grok.properties.config.$ref, "#/components/schemas/GrokBuildSettingsRedacted");
  assert.equal(grok.properties.settings.$ref, "#/components/schemas/GrokBuildSettingsRedacted");
  assert.equal(schema("GrokBuildSettingsRedactedModel").properties.api_key, undefined);

  assert.match(source("src/app/api/cli-tools/codewhale-settings/route.ts"), /api_key =/);
  assert.match(source("src/app/api/cli-tools/deepseek-tui-settings/route.ts"), /api_key =/);
  assert.match(source("src/app/api/cli-tools/forge-settings/route.ts"), /api_key =/);
  assert.match(source("src/app/api/cli-tools/crush-settings/route.ts"), /api_key:\s*apiKey/);
  const grokSource = source("src/app/api/cli-tools/grok-build-settings/route.ts");
  assert.match(grokSource, /omitApiKeys\(settings\)/);
  assert.match(grokSource, /apiKeyConfigured/);
});

test("settings mutation results model config paths, model slots, and reset outcomes", () => {
  for (const name of [
    "CodeWhaleSettingsAppliedResponse",
    "CrushSettingsAppliedResponse",
    "DeepseekTuiSettingsAppliedResponse",
    "ForgeSettingsAppliedResponse",
  ]) {
    const response = schema(name);
    assertRequired(response, ["success", "message", "configPath"], name);
    assert.equal(response.properties.success.const, true);
    assert.equal(response.properties.configPath["x-sensitive"], true);
  }

  const grokApplied = schema("GrokBuildSettingsAppliedResponse");
  assertRequired(
    grokApplied,
    ["success", "message", "configPath", "modelSlot"],
    "Grok Build apply"
  );
  assert.equal(grokApplied.properties.modelSlot.const, "omniroute");

  for (const name of [
    "CodeWhaleSettingsRemovedResponse",
    "CrushSettingsRemovedResponse",
    "DeepseekTuiSettingsRemovedResponse",
    "ForgeSettingsRemovedResponse",
    "GrokBuildSettingsRemovedResponse",
  ]) {
    const response = schema(name);
    assertRequired(response, ["success", "message"], name);
    assert.equal(response.properties.success.const, true);
  }
  assert.deepEqual(schema("CrushSettingsRemovedResponse").properties.message.enum, [
    "No config file to reset",
    "Crush OmniRoute settings removed",
  ]);
  assert.deepEqual(schema("GrokBuildSettingsRemovedResponse").properties.message.enum, [
    "No config file to reset",
    "OmniRoute model slots removed from Grok Build",
  ]);

  assert.match(
    source("src/app/api/cli-tools/crush-settings/route.ts"),
    /Crush settings applied successfully!/
  );
  assert.match(
    source("src/app/api/cli-tools/grok-build-settings/route.ts"),
    /modelSlot: "omniroute"/
  );
});
