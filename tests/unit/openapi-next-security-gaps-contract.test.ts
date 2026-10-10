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
  ["get", "/api/github-skills"],
  ["post", "/api/github-skills"],
  ["get", "/api/guardrails"],
  ["post", "/api/guardrails/test"],
  ["post", "/api/headroom/start"],
  ["get", "/api/headroom/status"],
  ["post", "/api/headroom/stop"],
  ["get", "/api/health/degradation"],
  ["get", "/api/health/ping"],
  ["get", "/api/init"],
  ["delete", "/api/intelligence/sync"],
  ["get", "/api/intelligence/sync"],
  ["post", "/api/intelligence/sync"],
  ["get", "/api/issue-agent/runs"],
  ["post", "/api/issue-agent/runs"],
  ["get", "/api/jobs"],
  ["post", "/api/jobs/{id}/disable"],
  ["post", "/api/jobs/{id}/enable"],
  ["post", "/api/jobs/{id}/run-now"],
  ["get", "/api/jobs/{id}/runs"],
  ["post", "/api/local/redis/start"],
  ["get", "/api/local/redis/status"],
  ["post", "/api/local/redis/stop"],
  ["get", "/api/mcp/sse"],
  ["post", "/api/mcp/sse"],
  ["delete", "/api/mcp/stream"],
  ["get", "/api/mcp/stream"],
  ["post", "/api/mcp/stream"],
  ["get", "/api/memory/rerank-providers"],
  ["delete", "/api/middleware/hooks/{name}"],
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

test("the audited batches declare all 59 effective OpenAPI operations", () => {
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

test("jobs, local Redis, and middleware remain local-only with their distinct remote bypass rules", () => {
  const jobs = [
    ["get", "/api/jobs"],
    ["post", "/api/jobs/{id}/disable"],
    ["post", "/api/jobs/{id}/enable"],
    ["post", "/api/jobs/{id}/run-now"],
    ["get", "/api/jobs/{id}/runs"],
  ] as const;
  for (const [method, route] of jobs) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-local-only"], true);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /remote peers are rejected by default/i);
    assert.match(routeOperation.description, /path-specific manage-scope bypass/i);
    assert.match(routeOperation.description, /default bypass list.*\/api\/mcp\//i);
  }

  for (const [method, route] of [
    ["post", "/api/local/redis/start"],
    ["get", "/api/local/redis/status"],
    ["post", "/api/local/redis/stop"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-local-only"], true);
    assert.match(routeOperation.description, /spawn-capable/i);
    assert.match(routeOperation.description, /cannot be bypassed with a manage key/i);
    assert.match(routeOperation.description, /OMNIROUTE_LOCAL_ENDPOINTS_ENABLED=1/);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
  }

  const middlewareDelete = operation("delete", "/api/middleware/hooks/{name}");
  assert.equal(middlewareDelete["x-local-only"], true);
  assert.match(middlewareDelete.description, /middleware code.*executed on the request path/i);
  assert.match(middlewareDelete.description, /explicitly add this eligible prefix/i);
  assert.match(middlewareDelete.description, /default bypass list.*\/api\/mcp\//i);
});

test("MCP security contracts distinguish local auth, remote mcp:connect bypass, and oma admin scope", () => {
  assert.ok(spec.components.securitySchemes.McpConnectApiKeyBearerAuth);
  assert.ok(spec.components.securitySchemes.McpConnectGoogleApiKeyAuth);
  assert.ok(spec.components.securitySchemes.McpConnectAnthropicApiKeyAuth);
  for (const [method, route] of [
    ["get", "/api/mcp/sse"],
    ["post", "/api/mcp/sse"],
    ["delete", "/api/mcp/stream"],
    ["get", "/api/mcp/stream"],
    ["post", "/api/mcp/stream"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-local-only"], true);
    assert.ok(hasScheme(routeOperation.security, "McpConnectApiKeyBearerAuth"));
    assert.ok(hasScheme(routeOperation.security, "McpConnectGoogleApiKeyAuth"));
    assert.ok(hasScheme(routeOperation.security, "McpConnectAnthropicApiKeyAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /default remote manage-scope bypass/i);
    assert.match(routeOperation.description, /mcp:connect.*manage.*admin/i);
    assert.match(routeOperation.description, /`oma_`.*admin/i);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.deepEqual(routeOperation["x-authentication-branches"].map((branch: any) => branch.when), [
      "Local peer or trusted private-LAN peer with management auth unlocked",
      "Local peer or trusted private-LAN peer with management auth locked",
      "Remote peer with the default MCP manage-scope bypass",
    ]);
  }
  assert.equal(operation("post", "/api/mcp/sse").requestBody["x-sensitive"], true);
  assert.equal(operation("post", "/api/mcp/stream").requestBody["x-sensitive"], true);
});

test("rerank-provider auth documents the central/handler intersection", () => {
  const rerank = operation("get", "/api/memory/rerank-providers");
  assert.equal(rerank["x-local-only"], undefined);
  assert.ok(hasScheme(rerank.security, "ManagementApiKeyBearerAuth"));
  assert.ok(hasScheme(rerank.security, "ManagementSessionAuth"));
  assert.ok(!hasScheme(rerank.security, "BearerAuth"));
  assert.ok(!hasScheme(rerank.security, "LocalCliTokenAuth"));
  assert.ok(!hasScheme(rerank.security, "InternalServiceTokenAuth"));
  assert.match(rerank.description, /central.*MANAGEMENT.*handler.*isAuthenticated/s);
  assert.match(rerank.description, /`oma_`.*loopback CLI.*internal-service/i);
  assert.equal(rerank.responses["200"]["x-sensitive"], true);
});

test("job history and MCP operational outputs are sensitive", () => {
  for (const [method, route] of [
    ["get", "/api/jobs"],
    ["post", "/api/jobs/{id}/disable"],
    ["post", "/api/jobs/{id}/enable"],
    ["post", "/api/jobs/{id}/run-now"],
    ["get", "/api/jobs/{id}/runs"],
    ["post", "/api/local/redis/start"],
    ["get", "/api/local/redis/status"],
    ["post", "/api/local/redis/stop"],
  ] as const) {
    assert.equal(operation(method, route).responses["200"]["x-sensitive"], true);
  }
});

test("health ping and init are explicitly public, while management routes stay conditional", () => {
  for (const [method, route] of [
    ["get", "/api/health/ping"],
    ["get", "/api/init"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.deepEqual(routeOperation.security, []);
    assert.equal(routeOperation["x-local-only"], undefined);
  }
  assert.match(operation("get", "/api/init").description, /explicitly public.*initialization side effect/i);
  assert.match(operation("get", "/api/health/ping").description, /explicitly public read-only/i);

  for (const [method, route] of [
    ["get", "/api/github-skills"],
    ["post", "/api/github-skills"],
    ["get", "/api/guardrails"],
    ["post", "/api/guardrails/test"],
    ["get", "/api/headroom/status"],
    ["get", "/api/health/degradation"],
    ["delete", "/api/intelligence/sync"],
    ["get", "/api/intelligence/sync"],
    ["post", "/api/intelligence/sync"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.notDeepEqual(routeOperation.security, []);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.match(routeOperation.description, /method-derived.*(?:read|write)/i);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }
  assert.match(operation("get", "/api/health/degradation").description, /not explicitly public/i);
  assert.equal(operation("get", "/api/health/degradation")["x-local-only"], undefined);
});

test("headroom and issue-agent local-only gates preserve their distinct remote-bypass behavior", () => {
  for (const [method, route] of [
    ["post", "/api/headroom/start"],
    ["post", "/api/headroom/stop"],
    ["get", "/api/issue-agent/runs"],
    ["post", "/api/issue-agent/runs"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-local-only"], true);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /loopback.*private-LAN/i);
    assert.match(routeOperation.description, /requireLogin=false/);
  }
  for (const route of ["/api/headroom/start", "/api/headroom/stop"]) {
    assert.match(operation("post", route).description, /remote management credential cannot bypass/i);
    assert.ok(operation("post", route).responses["403"]);
  }
  for (const method of ["get", "post"]) {
    const routeOperation = operation(method, "/api/issue-agent/runs");
    assert.ok(hasScheme(routeOperation.security, "ManagementApiKeyBearerAuth"));
    assert.match(routeOperation.description, /explicitly configure a path-specific manage-scope bypass/i);
    assert.match(routeOperation.description, /not an `oma_` access token/i);
  }
});

test("guardrail tests, headroom status, and issue-agent payloads are marked sensitive", () => {
  const guardrailTest = operation("post", "/api/guardrails/test");
  assert.equal(guardrailTest.requestBody["x-sensitive"], true);
  assert.equal(guardrailTest.responses["200"]["x-sensitive"], true);

  const headroomStatus = operation("get", "/api/headroom/status");
  assert.equal(headroomStatus.responses["200"]["x-sensitive"], true);

  const issueAgentPost = operation("post", "/api/issue-agent/runs");
  assert.equal(issueAgentPost.requestBody["x-sensitive"], true);
  assert.equal(issueAgentPost.responses["200"]["x-sensitive"], true);
  assert.equal(issueAgentPost.requestBody.content["application/json"].schema.properties.recordedContext["x-sensitive"], true);
  assert.equal(issueAgentPost.requestBody.content["application/json"].schema.properties.githubExport["x-sensitive"], true);

  assert.match(operation("post", "/api/github-skills").description, /action: planned.*does not install/i);
  assert.match(operation("get", "/api/guardrails").description, /comment labels.*LOCAL_ONLY.*no guardrails path/i);
  assert.equal(operation("get", "/api/guardrails")["x-local-only"], undefined);
  assert.equal(operation("post", "/api/guardrails/test")["x-local-only"], undefined);
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
