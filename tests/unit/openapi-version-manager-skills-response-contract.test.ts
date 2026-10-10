import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const SPEC_PATH = path.join(process.cwd(), "docs/openapi.yaml");
const document = yaml.load(fs.readFileSync(SPEC_PATH, "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: {
    schemas: Record<string, any>;
    securitySchemes: Record<string, any>;
  };
};
const schemas = document.components.schemas;
const securitySchemes = document.components.securitySchemes;

const routeSchemas: Array<[string, string, string]> = [
  ["get", "/api/version-manager/check-update", "VersionManagerCheckUpdateResponse"],
  ["post", "/api/version-manager/install", "VersionManagerInstallResponse"],
  ["post", "/api/version-manager/restart", "VersionManagerProcessResponse"],
  ["post", "/api/version-manager/start", "VersionManagerProcessResponse"],
  ["get", "/api/version-manager/status", "VersionManagerStatusResponse"],
  ["post", "/api/version-manager/stop", "VersionManagerStopResponse"],
  ["get", "/api/skills", "SkillListResponse"],
  ["delete", "/api/skills/{id}", "SkillMutationResponse"],
  ["put", "/api/skills/{id}", "SkillUpdateResponse"],
  ["post", "/api/skills/collect/chaos", "SkillsChaosResponse"],
  ["get", "/api/skills/collect/detect", "SkillsCollectDetectResponse"],
  ["post", "/api/skills/collect/install", "SkillsCollectInstallResponse"],
  ["get", "/api/skills/executions", "SkillExecutionsListResponse"],
  ["post", "/api/skills/executions", "SkillExecutionCreateResponse"],
  ["post", "/api/skills/install", "SkillInstallResponse"],
  ["get", "/api/skills/marketplace", "SkillMarketplaceSearchResponse"],
  ["post", "/api/skills/marketplace/install", "SkillInstallResponse"],
  ["get", "/api/skills/skillssh", "SkillsShSearchResponse"],
  ["post", "/api/skills/skillssh/install", "SkillInstallResponse"],
];

function normalizeSecurity(security: any[]) {
  return security
    .map((alternative) => JSON.stringify(Object.fromEntries(Object.entries(alternative).sort())))
    .sort();
}

test("version-manager and skills success responses are typed as source-backed JSON contracts", () => {
  assert.equal(routeSchemas.length, 19);
  for (const [method, route, component] of routeSchemas) {
    const response = document.paths[route][method].responses["200"];
    assert.ok(response, `${method.toUpperCase()} ${route} declares 200`);
    assert.equal(
      response.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${component}`,
      `${method.toUpperCase()} ${route} references ${component}`
    );
    assert.equal(response.content?.["text/event-stream"], undefined, `${route} is JSON, not SSE`);
  }
});

test("version-manager status documents the safe no-store projection and host-path sensitivity", () => {
  const response = document.paths["/api/version-manager/status"].get.responses["200"];
  assert.equal(response.headers["Cache-Control"].schema.const, "no-store");
  const row = schemas.VersionManagerStatusRow;
  assert.ok(row.required.includes("binaryPath"));
  assert.ok(row.required.includes("logsBufferPath"));
  assert.equal(row.properties.binaryPath["x-sensitive"], true);
  assert.equal(row.properties.logsBufferPath["x-sensitive"], true);
  for (const omitted of ["apiKey", "managementKey", "configOverrides"]) {
    assert.equal(
      row.properties[omitted],
      undefined,
      `${omitted} must stay out of the HTTP projection`
    );
  }

  const install = schemas.VersionManagerInstallResponse;
  assert.deepEqual(install.required, ["success", "installedVersion", "installPath", "durationMs"]);
  assert.equal(install.properties.installPath["x-sensitive"], true);
  assert.deepEqual(schemas.VersionManagerProcessResponse.properties.pid.type, ["integer", "null"]);
  assert.deepEqual(schemas.VersionManagerCheckUpdateResponse.required, [
    "current",
    "latest",
    "updateAvailable",
  ]);
});

test("skills contracts preserve sensitive payloads, result unions, and route tiers", () => {
  assert.equal(schemas.SkillRecord.properties.handler["x-sensitive"], true);
  assert.equal(schemas.SkillRecord.properties.apiKeyId["x-sensitive"], true);
  assert.equal(schemas.SkillExecutionRecord.properties.input["x-sensitive"], true);
  assert.equal(schemas.SkillExecutionRecord.properties.output["x-sensitive"], true);
  assert.deepEqual(schemas.SkillExecutionRecord.properties.status.enum, [
    "pending",
    "running",
    "success",
    "error",
    "timeout",
  ]);

  assert.equal(schemas.SkillsChaosResponse.properties.task["x-sensitive"], true);
  assert.deepEqual(schemas.SkillsChaosResponse.properties.mode.enum, ["parallel", "collaborative"]);
  assert.deepEqual(schemas.SkillsChaosModelResult.properties.status.enum, [
    "success",
    "error",
    "skipped",
  ]);
  assert.equal(schemas.SkillsChaosModelResult.properties.content["x-sensitive"], true);

  const installItems = schemas.SkillsCollectInstallResponse.properties.results.items.oneOf;
  assert.deepEqual(
    installItems.map((item: { $ref: string }) => item.$ref),
    [
      "#/components/schemas/SkillsCollectInstallPlannedResult",
      "#/components/schemas/SkillsCollectInstallErrorResult",
    ]
  );
  assert.equal(schemas.SkillsCollectInstallPlannedResult.properties.destDir["x-sensitive"], true);
  assert.deepEqual(
    schemas.SkillMarketplaceSearchResponse.anyOf.map((item: { $ref: string }) => item.$ref),
    [
      "#/components/schemas/SkillMarketplacePopularResponse",
      "#/components/schemas/SkillMarketplaceProviderResponse",
    ]
  );
  assert.equal(schemas.SkillMarketplaceProviderResponse.properties.skills["x-sensitive"], true);

  for (const [route, method] of [
    ["/api/skills/collect/chaos", "post"],
    ["/api/skills/collect/detect", "get"],
    ["/api/skills/collect/install", "post"],
  ]) {
    assert.equal(document.paths[route][method]["x-local-only"], true);
  }
  assert.equal(document.paths["/api/skills"].get["x-local-only"], undefined);
  assert.equal(document.paths["/api/skills/executions"].get["x-local-only"], undefined);
});

test("Version Manager and Skills security alternatives match each handler auth gate", () => {
  const managementSchemes = [
    "BearerAuth",
    "ManagementAnthropicApiKeyAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
  ];
  const isAuthenticatedSchemes = [
    "ManagementApiKeyBearerAuth",
    "ManagementAnthropicApiKeyAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementSessionAuth",
  ];

  function assertAlternatives(
    method: string,
    route: string,
    schemeNames: string[],
    anonymous: boolean
  ) {
    const actual = document.paths[route][method].security;
    assert.ok(Array.isArray(actual), `${method.toUpperCase()} ${route} declares security`);
    const expected = [
      ...schemeNames.map((name) => JSON.stringify({ [name]: [] })),
      ...(anonymous ? ["{}"] : []),
    ].sort();
    assert.deepEqual(
      normalizeSecurity(actual),
      expected,
      `${method.toUpperCase()} ${route} security matches its source auth helper`
    );
  }

  const requireManagementAuthRoutes = [
    ["get", "/api/skills"],
    ["delete", "/api/skills/{id}"],
    ["put", "/api/skills/{id}"],
    ["get", "/api/skills/collect/detect"],
    ["post", "/api/skills/collect/install"],
    ["post", "/api/skills/install"],
    ["get", "/api/version-manager/check-update"],
    ["post", "/api/version-manager/install"],
    ["post", "/api/version-manager/restart"],
    ["post", "/api/version-manager/start"],
    ["get", "/api/version-manager/status"],
    ["post", "/api/version-manager/stop"],
  ];
  for (const [method, route] of requireManagementAuthRoutes) {
    assertAlternatives(method, route, managementSchemes, true);
  }

  const legacyIsAuthenticatedRoutes = [
    ["get", "/api/skills/executions"],
    ["post", "/api/skills/executions"],
    ["get", "/api/skills/marketplace"],
    ["post", "/api/skills/marketplace/install"],
    ["get", "/api/skills/skillssh"],
    ["post", "/api/skills/skillssh/install"],
  ];
  for (const [method, route] of legacyIsAuthenticatedRoutes) {
    assertAlternatives(method, route, isAuthenticatedSchemes, true);
  }

  assertAlternatives("post", "/api/skills/collect/chaos", ["ChaosModeApiKeyBearerAuth"], false);
  assert.match(document.paths["/api/skills/collect/chaos"].post.description, /Chaos Mode enabled/);
  assert.match(document.paths["/api/skills/collect/chaos"].post.description, /local-only/);
  assert.match(securitySchemes.ChaosModeApiKeyBearerAuth.description, /Chaos Mode enabled/);
});
