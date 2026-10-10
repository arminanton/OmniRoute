import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const spec = yaml.load(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8"),
) as {
  paths: Record<string, Record<string, any>>;
  components: { securitySchemes: Record<string, unknown>; schemas: Record<string, any> };
};

const operations = [
  ["get", "/api/context/analytics/engine"],
  ["delete", "/api/discovery/results/{id}"],
  ["get", "/api/docs"],
  ["get", "/api/docs/codex-cli"],
  ["get", "/api/evals"],
  ["post", "/api/evals"],
  ["get", "/api/evals/{suiteId}"],
  ["get", "/api/free-models"],
  ["get", "/api/free-provider-rankings"],
  ["get", "/api/free-tier/summary"],
  ["get", "/api/gamification/anomalies"],
  ["get", "/api/gamification/badges"],
  ["get", "/api/gamification/badges/earned"],
  ["get", "/api/gamification/federation/leaderboard"],
  ["post", "/api/gamification/federation/score"],
] as const;

function operation(method: string, route: string) {
  const value = spec.paths[route]?.[method];
  assert.ok(value, `Missing OpenAPI operation ${method.toUpperCase()} ${route}`);
  return value;
}

function hasScheme(security: unknown[], name: string) {
  return security.some((alternative) =>
    alternative && typeof alternative === "object" && name in alternative,
  );
}

test("the next security batch declares all 15 effective OpenAPI operations", () => {
  for (const [method, route] of operations) {
    const routeOperation = operation(method, route);
    assert.ok(Array.isArray(routeOperation.security), `${method.toUpperCase()} ${route}`);
    for (const alternative of routeOperation.security) {
      for (const name of Object.keys(alternative)) {
        assert.ok(spec.components.securitySchemes[name], `undefined security scheme ${name} on ${route}`);
      }
    }
  }
});

test("conditional management routes keep an anonymous alternative scoped to unlocked setups", () => {
  for (const [method, route] of [
    ["get", "/api/context/analytics/engine"],
    ["get", "/api/evals"],
    ["post", "/api/evals"],
    ["get", "/api/free-models"],
    ["get", "/api/free-provider-rankings"],
    ["get", "/api/free-tier/summary"],
    ["get", "/api/gamification/anomalies"],
    ["get", "/api/gamification/badges"],
    ["get", "/api/gamification/badges/earned"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /requireLogin=false|unlocked|first-run/i);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
  }
});

test("discovery deletion preserves its locality gate and does not turn the docs handler comment into public auth", () => {
  const deletion = operation("delete", "/api/discovery/results/{id}");
  assert.equal(deletion["x-local-only"], true);
  assert.match(deletion.description, /trusted private-network|LOCAL_ONLY/i);
  assert.ok(deletion.security.some((alternative: object) => Object.keys(alternative).length === 0));

  for (const route of ["/api/docs", "/api/docs/codex-cli"]) {
    const docsOperation = operation("get", route);
    assert.notDeepEqual(docsOperation.security, []);
    assert.ok(hasScheme(docsOperation.security, "BearerAuth"));
    assert.match(docsOperation.description, /central.*MANAGEMENT|management gate/i);
  }

  for (const route of ["/api/gamification/badges", "/api/gamification/badges/earned"]) {
    assert.notEqual(operation("get", route)["x-local-only"], true);
  }
});

test("federation routes describe their distinct bearer token and central-auth branches", () => {
  assert.ok(spec.components.securitySchemes.GamificationFederationBearerAuth);
  for (const [method, route] of [
    ["get", "/api/gamification/federation/leaderboard"],
    ["post", "/api/gamification/federation/score"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.ok(hasScheme(routeOperation.security, "GamificationFederationBearerAuth"));
    assert.ok(!hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(hasScheme(routeOperation.security, "LocalCliTokenAuth"));
    assert.ok(hasScheme(routeOperation.security, "InternalServiceTokenAuth"));
    assert.match(routeOperation.description, /cannot share.*Authorization|cannot satisfy both/i);
    assert.equal(routeOperation["x-local-only"], undefined);
    assert.deepEqual(routeOperation["x-authentication-branches"].map((branch: any) => branch.when), [
      "Management authentication is disabled or unlocked",
      "Management authentication is required",
    ]);
  }

  const leaderboard = spec.components.schemas.GamificationFederationLeaderboardEntry;
  const scoreRequest = spec.components.schemas.GamificationFederationScoreRequest;
  const earned = operation("get", "/api/gamification/badges/earned");
  assert.equal(earned.parameters.find((parameter: any) => parameter.name === "apiKeyId")["x-sensitive"], true);
  assert.equal(leaderboard.properties.apiKeyId["x-sensitive"], true);
  assert.equal(scoreRequest["x-sensitive"], true);
  assert.equal(scoreRequest.properties.apiKeyId["x-sensitive"], true);
});

test("evaluation and aggregate ranking contracts flag sensitive data and provider-costing work", () => {
  assert.equal(operation("get", "/api/evals").responses["200"]["x-sensitive"], true);
  assert.equal(operation("post", "/api/evals").requestBody["x-sensitive"], true);
  assert.equal(operation("post", "/api/evals").responses["200"]["x-sensitive"], true);
  assert.equal(operation("get", "/api/evals/{suiteId}").responses["200"]["x-sensitive"], true);
  assert.equal(operation("get", "/api/free-provider-rankings").responses["200"]["x-sensitive"], true);
  assert.match(operation("post", "/api/evals").description, /provider|cost/i);
  assert.match(operation("get", "/api/free-tier/summary").description, /live.*anonymous|anonymous.*live/i);
});
