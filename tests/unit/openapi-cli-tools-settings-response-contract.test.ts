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

test("CLI config/apply operations document their source-backed errors and shared body cap", () => {
  const expectedSchemas: Array<[string, string, string, string]> = [
    ["/api/cli-tools/apply", "post", "400", "StringErrorResponse"],
    ["/api/cli-tools/apply", "post", "413", "ApiErrorResponse"],
    ["/api/cli-tools/apply", "post", "500", "StringErrorResponse"],
    ["/api/cli-tools/config", "get", "400", "StringErrorResponse"],
    ["/api/cli-tools/config", "get", "500", "StringErrorResponse"],
    ["/api/cli-tools/config", "post", "400", "StringErrorResponse"],
    ["/api/cli-tools/config", "post", "413", "ApiErrorResponse"],
    ["/api/cli-tools/config", "post", "500", "StringErrorResponse"],
  ];

  for (const [route, method, status, schemaName] of expectedSchemas) {
    assert.equal(
      spec.paths[route]?.[method]?.responses?.[status]?.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${schemaName}`,
      `${method.toUpperCase()} ${route} ${status} response schema`
    );
  }

  const getConfig = spec.paths["/api/cli-tools/config"].get;
  assert.equal(
    getConfig.parameters.find((parameter: any) => parameter.name === "apiKey")?.required,
    true,
    "GET /api/cli-tools/config requires the API key that its handler rejects when missing"
  );
});

test("provider discovery and CodeWhale operations describe auth and source error variants", () => {
  const providerModels = spec.paths["/api/providers/{id}/models"].get;
  for (const scheme of [
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementAnthropicApiKeyAuth",
  ]) {
    assert.ok(
      providerModels.security.some((alternative: Record<string, unknown>) => scheme in alternative),
      `provider model discovery must list ${scheme}`
    );
  }
  for (const status of ["502", "504"]) {
    assert.equal(
      providerModels.responses[status]?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/ProviderConnectionErrorResponse",
      `provider model discovery ${status} error schema`
    );
  }

  const codewhale = spec.paths["/api/cli-tools/codewhale-settings"];
  for (const method of ["get", "post", "delete"]) {
    const operation = codewhale[method];
    assert.ok(
      operation.responses["500"],
      `${method.toUpperCase()} CodeWhale documents its handler error`
    );
    assert.equal(
      operation.responses["403"]?.$ref,
      "#/components/responses/ManagementOrRuntimePolicyForbidden",
      `${method.toUpperCase()} CodeWhale includes its string write-guard denial envelope`
    );
  }
  for (const [method, status] of [
    ["post", "400"],
    ["post", "413"],
    ["delete", "413"],
  ]) {
    assert.ok(codewhale[method].responses[status], `${method.toUpperCase()} CodeWhale ${status}`);
  }
  assert.ok(
    spec.paths["/api/providers/bulk"].post.responses["413"],
    "provider bulk documents the shared body-size guard rejection"
  );
});

test("CLI settings error responses cover status codes returned by their source handlers", () => {
  const routes = [
    "crush-settings",
    "deepseek-tui-settings",
    "forge-settings",
    "grok-build-settings",
    "hermes-agent-settings",
    "jcode-settings",
    "kilo-settings",
    "letta-settings",
  ];

  for (const routeName of routes) {
    const route = `/api/cli-tools/${routeName}`;
    const relativeSource = `src/app/api/cli-tools/${routeName}/route.ts`;
    const handlerSource = source(relativeSource);
    const methodMatches = [
      ...handlerSource.matchAll(/export\s+async\s+function\s+(GET|POST|DELETE)\s*\(/g),
    ];

    for (let index = 0; index < methodMatches.length; index += 1) {
      const method = methodMatches[index][1].toLowerCase();
      const start = methodMatches[index].index;
      const end = methodMatches[index + 1]?.index ?? handlerSource.length;
      const methodSource = handlerSource.slice(start, end);
      const operation = spec.paths[route]?.[method];
      assert.ok(operation, `${method.toUpperCase()} ${route} must be documented`);

      const sourceStatuses = new Set(
        [...methodSource.matchAll(/status:\s*([45]\d\d)/g)].map((match) => match[1])
      );
      if (method !== "get") sourceStatuses.add("413");

      for (const status of sourceStatuses) {
        const response = operation.responses?.[status];
        assert.ok(response, `${method.toUpperCase()} ${route} source status ${status}`);
        if (status === "403") {
          assert.equal(
            response.$ref,
            "#/components/responses/ManagementOrRuntimePolicyForbidden",
            `${method.toUpperCase()} ${route} combines auth and local write-guard error envelopes`
          );
        }
      }
    }
  }
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
