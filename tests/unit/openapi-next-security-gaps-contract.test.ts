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
  ["delete", "/api/gamification/invite"],
  ["get", "/api/gamification/invite"],
  ["post", "/api/gamification/invite"],
  ["post", "/api/gamification/invite/redeem"],
  ["get", "/api/gamification/leaderboard"],
  ["get", "/api/gamification/level"],
  ["get", "/api/gamification/notifications"],
  ["post", "/api/gamification/rotate"],
  ["delete", "/api/gamification/servers"],
  ["get", "/api/gamification/servers"],
  ["post", "/api/gamification/servers"],
  ["get", "/api/gamification/stream"],
  ["get", "/api/gamification/transfer"],
  ["post", "/api/gamification/transfer"],
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

test("the audited batches declare all 29 effective OpenAPI operations", () => {
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

test("gamification routes use conditional management auth without public or locality overrides", () => {
  const priorBatch = new Set([
    "/api/gamification/anomalies",
    "/api/gamification/badges",
    "/api/gamification/badges/earned",
    "/api/gamification/federation/leaderboard",
    "/api/gamification/federation/score",
  ]);
  const gamification = operations.filter(
    ([, route]) => route.startsWith("/api/gamification/") && !priorBatch.has(route),
  );
  assert.equal(gamification.length, 14);
  for (const [method, route] of gamification) {
    const routeOperation = operation(method, route);
    assert.notDeepEqual(routeOperation.security, [], `${method.toUpperCase()} ${route} must not be explicitly public`);
    assert.equal(routeOperation["x-local-only"], undefined, `${method.toUpperCase()} ${route} is not LOCAL_ONLY`);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(hasScheme(routeOperation.security, "ManagementSessionAuth"));
    assert.match(routeOperation.description, /conditional management access/i);
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.match(routeOperation.description, /method-derived.*(?:read|write)/i);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }
});

test("gamification invite and account-linked data are marked sensitive and invite credentials are no-store", () => {
  const inviteGet = operation("get", "/api/gamification/invite");
  assert.equal(inviteGet.parameters.find((parameter: any) => parameter.name === "apiKeyId")["x-sensitive"], true);
  assert.equal(inviteGet.responses["200"]["x-sensitive"], true);

  const invitePost = operation("post", "/api/gamification/invite");
  assert.equal(invitePost.requestBody["x-sensitive"], true);
  assert.equal(invitePost.responses["201"]["x-sensitive"], true);
  assert.equal(invitePost.responses["201"].headers["Cache-Control"].schema.const, "no-store");

  const transferPost = operation("post", "/api/gamification/transfer");
  assert.equal(transferPost.requestBody["x-sensitive"], true);
  assert.equal(transferPost.responses["200"]["x-sensitive"], true);
  assert.equal(spec.components.schemas.GamificationTransferRequest.properties.fromApiKeyId["x-sensitive"], true);
  assert.equal(spec.components.schemas.GamificationTransferRequest.properties.toApiKeyId["x-sensitive"], true);
  assert.equal(spec.components.schemas.GamificationStreamLeaderboardEntry.properties.apiKeyId["x-sensitive"], true);
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
