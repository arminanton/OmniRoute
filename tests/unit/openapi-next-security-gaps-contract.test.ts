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
  ["get", "/api/middleware/hooks/{name}"],
  ["put", "/api/middleware/hooks/{name}"],
  ["get", "/api/models"],
  ["put", "/api/models"],
  ["get", "/api/models/alias"],
  ["put", "/api/models/alias"],
  ["delete", "/api/models/alias"],
  ["get", "/api/models/catalog"],
  ["delete", "/api/monitoring/health"],
  ["get", "/api/network/info"],
  ["post", "/api/omniroute/route/preview"],
  ["get", "/api/omniroute/status"],
  ["post", "/api/playground/simulate-route"],
  ["get", "/api/pricing/models"],
  ["get", "/api/provider-metrics"],
  ["get", "/api/provider-stats"],
  ["post", "/api/providers/command-code/auth/callback"],
  ["get", "/api/providers/expiration"],
  ["post", "/api/proxy-fallback/test"],
  ["get", "/api/radar/catalog"],
  ["get", "/api/radar/intel"],
  ["post", "/api/radar/intel/sync"],
  ["delete", "/api/radar/local-model-state"],
  ["get", "/api/radar/local-model-state"],
  ["patch", "/api/radar/local-model-state"],
  ["put", "/api/radar/local-model-state"],
  ["get", "/api/radar/offers"],
  ["post", "/api/radar/offers/sync"],
  ["get", "/api/radar/referrals"],
  ["get", "/api/radar/settings"],
  ["post", "/api/services/9router/rotate-key"],
  ["post", "/api/services/9router/start"],
  ["get", "/api/services/9router/status"],
  ["post", "/api/services/9router/stop"],
  ["post", "/api/services/9router/update"],
  ["post", "/api/services/bifrost/auto-restart-adopted"],
  ["post", "/api/services/bifrost/auto-start"],
  ["post", "/api/services/bifrost/install"],
  ["post", "/api/services/bifrost/restart"],
  ["post", "/api/services/bifrost/start"],
  ["get", "/api/services/bifrost/status"],
  ["post", "/api/services/bifrost/stop"],
  ["post", "/api/services/bifrost/update"],
  ["get", "/api/services/cliproxy/accounts"],
  ["post", "/api/services/cliproxy/auto-restart-adopted"],
  ["post", "/api/radar/settings"],
  ["get", "/api/radar/status"],
  ["post", "/api/radar/sync"],
  ["post", "/api/radar/sync-all"],
  ["delete", "/api/resilience/model-cooldowns"],
  ["get", "/api/resilience/model-cooldowns"],
  ["get", "/api/search/providers"],
  ["get", "/api/search/stats"],
  ["get", "/api/services/{name}/logs"],
  ["post", "/api/services/9router/auto-restart-adopted"],
  ["post", "/api/services/9router/auto-start"],
  ["post", "/api/services/9router/install"],
  ["post", "/api/services/9router/provider-expose"],
  ["post", "/api/services/9router/restart"],
  ["get", "/api/services/9router/models"],
  ["post", "/api/services/cliproxy/auto-start"],
  ["post", "/api/services/cliproxy/install"],
  ["post", "/api/services/cliproxy/provider-expose"],
  ["post", "/api/services/cliproxy/restart"],
  ["post", "/api/services/cliproxy/start"],
  ["get", "/api/services/cliproxy/status"],
  ["post", "/api/services/cliproxy/stop"],
  ["post", "/api/services/cliproxy/update"],
  ["post", "/api/services/dario/auto-restart-adopted"],
  ["post", "/api/services/dario/auto-start"],
  ["post", "/api/services/dario/install"],
  ["post", "/api/services/dario/restart"],
  ["post", "/api/services/dario/start"],
  ["get", "/api/services/dario/status"],
  ["post", "/api/services/dario/stop"],
  ["post", "/api/services/dario/update"],
  ["post", "/api/services/mux/auto-restart-adopted"],
  ["post", "/api/services/mux/auto-start"],
  ["post", "/api/services/mux/install"],
  ["post", "/api/services/mux/restart"],
  ["post", "/api/services/mux/start"],
  ["post", "/api/services/mux/stop"],
  ["post", "/api/services/mux/update"],
  ["get", "/api/services/mux/status"],
  ["get", "/api/session-pools"],
  ["get", "/api/session-pools/{provider}"],
  ["get", "/api/sessions"],
  ["get", "/api/storage/health"],
  ["get", "/api/synced-available-models"],
  ["post", "/api/tunnels/tailscale/login"],
  ["post", "/api/tunnels/tailscale/start-daemon"],
  ["get", "/api/usage/{connectionId}"],
  ["get", "/api/usage/analytics"],
  ["get", "/api/usage/history"],
  ["get", "/api/usage/budget"],
  ["post", "/api/usage/budget"],
  ["get", "/api/usage/cache-health"],
  ["get", "/api/usage/combo-health"],
  ["get", "/api/usage/utilization"],
  ["head", "/api/v1/models"],
  ["get", "/api/v1/models/{model}"],
  ["head", "/api/v1/models/{model}"],
  ["get", "/api/v1/provider-plugin-manifest"],
  ["get", "/api/v1/search"],
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

test("the audited batches declare all 178 effective OpenAPI operations", () => {
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
    const successStatus = route === "/api/mcp/stream" ? "2XX" : "200";
    assert.equal(routeOperation.responses[successStatus]["x-sensitive"], true);
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

test("model endpoints document their distinct central and delegated auth policies", () => {
  for (const [method, route, scope] of [
    ["get", "/api/models", "read"],
    ["put", "/api/models", "write"],
    ["get", "/api/models/alias", "read"],
    ["put", "/api/models/alias", "write"],
    ["delete", "/api/models/alias", "write"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.match(routeOperation.description, new RegExp(`method-derived.*${scope}.*scope`, "i"));
    assert.match(routeOperation.description, /requireLogin.*anonymous requests/i);
    assert.equal(routeOperation.responses["401"] !== undefined, true);
    assert.equal(routeOperation.responses["403"] !== undefined, true);
    assert.equal(routeOperation.responses["503"] !== undefined, true);
  }
  const catalog = operation("get", "/api/models/catalog");
  assert.ok(hasScheme(catalog.security, "ManagementApiKeyBearerAuth"));
  assert.ok(hasScheme(catalog.security, "ManagementSessionAuth"));
  assert.ok(catalog.security.some((alternative: object) => Object.keys(alternative).length === 0));
  assert.ok(!hasScheme(catalog.security, "BearerAuth"));
  assert.ok(!hasScheme(catalog.security, "LocalCliTokenAuth"));
  assert.ok(!hasScheme(catalog.security, "InternalServiceTokenAuth"));
  assert.match(catalog.description, /delegated catalog handler.*`requireAuthForModels`/);
  assert.match(catalog.description, /`oma_`.*loopback CLI.*internal-service.*401/);
  assert.equal(catalog.responses["200"]["x-sensitive"], true);
});

test("middleware hook reads and updates preserve the LOCAL_ONLY boundary and mark code/logs sensitive", () => {
  for (const [method, scope] of [["get", "read"], ["put", "write"]] as const) {
    const routeOperation = operation(method, "/api/middleware/hooks/{name}");
    assert.equal(routeOperation["x-local-only"], true);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /middleware code.*executed on the request path/i);
    assert.match(routeOperation.description, /default bypass list is only `\/api\/mcp\//i);
    assert.match(routeOperation.description, new RegExp(`method-derived.*${scope}.*scope`, "i"));
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }
  assert.equal(operation("put", "/api/middleware/hooks/{name}").requestBody["x-sensitive"], true);
});

test("monitoring reset and network information preserve the isAuthenticated intersection", () => {
  const healthGet = operation("get", "/api/monitoring/health");
  assert.ok(hasScheme(healthGet.security, "BearerAuth"));
  assert.ok(healthGet.security.some((alternative: object) => Object.keys(alternative).length === 0));
  assert.match(healthGet.description, /Anonymous callers.*public liveness view/s);

  const reset = operation("delete", "/api/monitoring/health");
  assert.ok(hasScheme(reset.security, "ManagementApiKeyBearerAuth"));
  assert.ok(hasScheme(reset.security, "ManagementGoogleApiKeyAuth"));
  assert.ok(hasScheme(reset.security, "ManagementAnthropicApiKeyAuth"));
  assert.ok(hasScheme(reset.security, "ManagementSessionAuth"));
  assert.ok(reset.security.some((alternative: object) => Object.keys(alternative).length === 0));
  assert.ok(!hasScheme(reset.security, "BearerAuth"));
  assert.ok(!hasScheme(reset.security, "LocalCliTokenAuth"));
  assert.match(reset.description, /`isAuthenticated\(\)`.*central management gate/s);
  assert.match(reset.description, /`oma_`.*machine\/internal credentials.*401/);
  assert.equal(reset.responses["200"]["x-sensitive"], true);
  assert.ok(reset.responses["403"]);
  assert.ok(reset.responses["503"]);

  const network = operation("get", "/api/network/info");
  assert.ok(hasScheme(network.security, "ManagementApiKeyBearerAuth"));
  assert.ok(hasScheme(network.security, "ManagementGoogleApiKeyAuth"));
  assert.ok(hasScheme(network.security, "ManagementAnthropicApiKeyAuth"));
  assert.ok(hasScheme(network.security, "ManagementSessionAuth"));
  assert.ok(network.security.some((alternative: object) => Object.keys(alternative).length === 0));
  assert.ok(!hasScheme(network.security, "BearerAuth"));
  assert.ok(!hasScheme(network.security, "LocalCliTokenAuth"));
  assert.match(network.description, /central management gate.*`isAuthenticated\(\)`/s);
  assert.match(network.description, /network topology.*sensitive/i);
  assert.equal(network.responses["200"]["x-sensitive"], true);
  assert.ok(network.responses["403"]);
  assert.ok(network.responses["503"]);
});

test("routing preview/status, playground, pricing, and provider metrics mark operational data sensitive", () => {
  for (const [method, route, scope] of [
    ["post", "/api/omniroute/route/preview", "write"],
    ["get", "/api/omniroute/status", "read"],
    ["post", "/api/playground/simulate-route", "write"],
    ["get", "/api/pricing/models", "read"],
    ["get", "/api/provider-metrics", "read"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /requireLogin.*anonymous requests/i);
    assert.match(routeOperation.description, new RegExp(`method-derived.*${scope}.*scope`, "i"));
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }
  assert.equal(operation("post", "/api/omniroute/route/preview").requestBody["x-sensitive"], true);
  assert.equal(operation("post", "/api/playground/simulate-route").requestBody["x-sensitive"], true);
  assert.match(operation("post", "/api/omniroute/route/preview").description, /without making an upstream model request/i);
  assert.match(operation("post", "/api/playground/simulate-route").description, /does not execute an upstream request/i);
});

test("provider stats and expiry remain conditional central-management reads", () => {
  for (const [method, route, scope] of [
    ["get", "/api/provider-stats", "read"],
    ["get", "/api/providers/expiration", "read"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /no handler-level auth.*central MANAGEMENT gate/s);
    assert.match(routeOperation.description, new RegExp(`method-derived.*${scope}.*scope`, "i"));
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }
});

test("tags, token health, and translator routes document central conditional management auth", () => {
  for (const [method, route, scope] of [
    ["get", "/api/tags", "read"],
    ["get", "/api/token-health", "read"],
    ["post", "/api/translator/detect", "write"],
    ["get", "/api/translator/history", "read"],
    ["post", "/api/translator/send", "write"],
    ["post", "/api/translator/transform-stream", "write"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-local-only"], undefined);
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(hasScheme(routeOperation.security, "LocalCliTokenAuth"));
    assert.ok(hasScheme(routeOperation.security, "InternalServiceTokenAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /no .*auth check.*central MANAGEMENT policy/s);
    assert.match(routeOperation.description, new RegExp(`method-derived.*${scope}.*scope`, "i"));
    assert.match(routeOperation.description, /requireLogin=false.*anonymous.*remotely/s);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }

  assert.equal(operation("get", "/api/token-health").responses["200"]["x-sensitive"], true);
  assert.equal(operation("post", "/api/translator/detect").requestBody["x-sensitive"], true);
  assert.equal(operation("get", "/api/translator/history").responses["200"]["x-sensitive"], true);
  const send = operation("post", "/api/translator/send");
  assert.equal(send.requestBody["x-sensitive"], true);
  assert.equal(send.responses["200"]["x-sensitive"], true);
  assert.match(send.description, /builds provider credentials server-side.*provider quota or cost/i);
  assert.match(operation("get", "/api/translator/history").description, /does not store the translated body/i);
  const transform = operation("post", "/api/translator/transform-stream");
  assert.equal(transform.requestBody["x-sensitive"], true);
  assert.equal(transform.responses["200"]["x-sensitive"], true);
  assert.match(transform.description, /maximum 100,000 characters.*no provider call/i);
});

test("tunnel auth intersections, locality exceptions, and sensitive operations match route guards", () => {
  const handlerAuthRoutes = [
    ["get", "/api/tunnels/cloudflared"],
    ["post", "/api/tunnels/cloudflared"],
    ["get", "/api/tunnels/ngrok"],
    ["post", "/api/tunnels/ngrok"],
    ["get", "/api/tunnels/tailscale"],
    ["get", "/api/tunnels/tailscale/check"],
    ["post", "/api/tunnels/tailscale/disable"],
    ["post", "/api/tunnels/tailscale/enable"],
    ["post", "/api/tunnels/tailscale/install"],
  ] as const;
  for (const [method, route] of handlerAuthRoutes) {
    const routeOperation = operation(method, route);
    assert.ok(hasScheme(routeOperation.security, "ManagementApiKeyBearerAuth"), `${method} ${route}`);
    assert.ok(hasScheme(routeOperation.security, "ManagementGoogleApiKeyAuth"), `${method} ${route}`);
    assert.ok(hasScheme(routeOperation.security, "ManagementAnthropicApiKeyAuth"), `${method} ${route}`);
    assert.ok(hasScheme(routeOperation.security, "ManagementSessionAuth"), `${method} ${route}`);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.ok(!hasScheme(routeOperation.security, "BearerAuth"), `${method} ${route}`);
    assert.ok(!hasScheme(routeOperation.security, "LocalCliTokenAuth"), `${method} ${route}`);
    assert.ok(!hasScheme(routeOperation.security, "InternalServiceTokenAuth"), `${method} ${route}`);
    assert.match(routeOperation.description, /central MANAGEMENT (?:policy|auth).*`isAuthenticated\(\)`/is);
    assert.match(routeOperation.description, /(?:does not accept|but not)\s+(?:central-only `oma_`|`oma_` tokens)/i);
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }

  assert.equal(operation("get", "/api/tunnels/cloudflared")["x-local-only"], undefined);
  assert.match(operation("get", "/api/tunnels/cloudflared").description, /GET is explicitly exempt.*LOCAL_ONLY/s);
  const cloudflaredPost = operation("post", "/api/tunnels/cloudflared");
  assert.equal(cloudflaredPost["x-local-only"], true);
  assert.match(cloudflaredPost.description, /spawn-capable endpoint has no remote manage-scope bypass/i);
  assert.match(cloudflaredPost.description, /locked.*stop remains available/i);

  assert.equal(operation("get", "/api/tunnels/ngrok")["x-local-only"], undefined);
  const ngrokPost = operation("post", "/api/tunnels/ngrok");
  assert.equal(ngrokPost["x-local-only"], undefined);
  assert.equal(ngrokPost.requestBody["x-sensitive"], true);
  assert.match(ngrokPost.description, /unlocked `requireLogin=false`.*anonymously from remote peers/s);
  assert.match(ngrokPost.description, /public tunnel.*highly sensitive/i);

  for (const route of ["/api/tunnels/tailscale", "/api/tunnels/tailscale/check"]) {
    assert.equal(operation("get", route)["x-local-only"], undefined);
  }
  for (const route of [
    "/api/tunnels/tailscale/disable",
    "/api/tunnels/tailscale/enable",
    "/api/tunnels/tailscale/install",
  ]) {
    const routeOperation = operation("post", route);
    assert.equal(routeOperation["x-local-only"], true);
    assert.match(routeOperation.description, /spawn-capable path has no remote manage-scope bypass/i);
    assert.equal(routeOperation.requestBody["x-sensitive"], true);
  }
  assert.match(operation("post", "/api/tunnels/tailscale/disable").description, /remains available.*locked/i);
  assert.match(operation("post", "/api/tunnels/tailscale/enable").description, /locked.*blocks.*capability/i);
  assert.match(operation("post", "/api/tunnels/tailscale/install").description, /locked.*blocks.*installation/i);
});

test("Command Code callback documents its management-gate ticket mismatch and admin access-token scope", () => {
  const callback = operation("post", "/api/providers/command-code/auth/callback");
  assert.equal(callback["x-local-only"], undefined);
  assert.ok(callback.security.some((alternative: object) => Object.keys(alternative).length === 0));
  assert.ok(hasScheme(callback.security, "BearerAuth"));
  assert.match(callback.description, /centrally classified as MANAGEMENT.*not on the explicit public allowlist/s);
  assert.match(callback.description, /state is an additional handler check, not a central-auth bypass/i);
  assert.match(callback.description, /`oma_`.*requires `admin`.*POST under `\/api\/providers\//s);
  assert.match(callback.description, /global CORS allowlist/i);
  assert.match(callback.description, /Origin filter is not authentication/i);
  assert.match(callback.description, /state is not consumed by this callback/i);
  assert.equal(callback.requestBody["x-sensitive"], true);
  assert.equal(callback.responses["200"]["x-sensitive"], true);
  assert.equal(callback.responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.ok(callback.responses["401"]);
  assert.ok(callback.responses["503"]);
  assert.ok(callback.responses["403"].content["application/json"].schema.oneOf);
});

test("proxy fallback testing is conditional management access with a guarded outbound probe", () => {
  const proxyTest = operation("post", "/api/proxy-fallback/test");
  assert.equal(proxyTest["x-local-only"], undefined);
  assert.ok(hasScheme(proxyTest.security, "BearerAuth"));
  assert.ok(proxyTest.security.some((alternative: object) => Object.keys(alternative).length === 0));
  assert.match(proxyTest.description, /`requireManagementAuth`/);
  assert.match(proxyTest.description, /method-derived `write`/);
  assert.match(proxyTest.description, /private.*URLs are rejected unless the operator enables/i);
  assert.match(proxyTest.description, /outbound network probes/i);
  assert.equal(proxyTest.requestBody["x-sensitive"], true);
  assert.equal(proxyTest.responses["200"]["x-sensitive"], true);
  assert.ok(proxyTest.responses["401"]);
  assert.ok(proxyTest.responses["403"]);
  assert.ok(proxyTest.responses["503"]);
});

test("Radar endpoints remain conditional MANAGEMENT routes with flag-order and credential notes", () => {
  const radar = [
    ["get", "/api/radar/catalog", "read"],
    ["get", "/api/radar/intel", "read"],
    ["post", "/api/radar/intel/sync", "write"],
    ["delete", "/api/radar/local-model-state", "write"],
    ["get", "/api/radar/local-model-state", "read"],
    ["patch", "/api/radar/local-model-state", "write"],
    ["put", "/api/radar/local-model-state", "write"],
    ["get", "/api/radar/offers", "read"],
    ["post", "/api/radar/offers/sync", "write"],
    ["get", "/api/radar/referrals", "read"],
    ["get", "/api/radar/settings", "read"],
    ["post", "/api/radar/settings", "write"],
    ["get", "/api/radar/status", "read"],
    ["post", "/api/radar/sync", "write"],
    ["post", "/api/radar/sync-all", "write"],
  ] as const;
  for (const [method, route, scope] of radar) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-local-only"], undefined, `${method.toUpperCase()} ${route}`);
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.match(routeOperation.description, /handler checks `RADAR_ENABLED` before.*central/s);
    assert.match(routeOperation.description, /central .*first|central auth runs first/i);
    assert.match(routeOperation.description, new RegExp(`method-derived.*${scope}.*scope`, "i"));
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["404"]);
    assert.ok(routeOperation.responses["503"]);
  }

  for (const route of [
    "/api/radar/catalog",
    "/api/radar/intel",
    "/api/radar/local-model-state",
    "/api/radar/offers",
    "/api/radar/referrals",
    "/api/radar/settings",
    "/api/radar/status",
  ]) {
    const get = operation("get", route);
    assert.equal(get.responses["200"].headers["Cache-Control"].schema.const, "no-store");
  }
  for (const method of ["delete", "patch", "put"] as const) {
    assert.equal(operation(method, "/api/radar/local-model-state").responses["200"].headers["Cache-Control"].schema.const, "no-store");
  }
  assert.match(operation("get", "/api/radar/referrals").description, /GET can trigger a server-side refresh/i);
  assert.match(operation("get", "/api/radar/settings").description, /masked key suffix.*raw supporter key is never returned/i);
  assert.match(operation("post", "/api/radar/intel/sync").description, /supporter key remains server-side/i);
  assert.match(operation("post", "/api/radar/offers/sync").description, /supporter key remains server-side/i);
  const settingsPost = operation("post", "/api/radar/settings");
  assert.equal(settingsPost.requestBody["x-sensitive"], true);
  assert.equal(settingsPost.responses["200"]["x-sensitive"], true);
  assert.equal(settingsPost.responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.equal(spec.components.schemas.RadarSettingsUpdateRequest.properties.supporterKey["x-sensitive"], true);
});

test("model cooldown and search routes document conditional auth and sensitive provider state", () => {
  for (const [method, route, scope] of [
    ["get", "/api/resilience/model-cooldowns", "read"],
    ["delete", "/api/resilience/model-cooldowns", "write"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.equal(routeOperation["x-local-only"], undefined);
    assert.match(routeOperation.description, /central MANAGEMENT auth runs first/i);
    assert.match(routeOperation.description, new RegExp(`method-derived.*${scope}.*scope`, "i"));
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.match(routeOperation.description, /provider state are sensitive/i);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }

  const deleteCooldowns = operation("delete", "/api/resilience/model-cooldowns");
  assert.equal(deleteCooldowns.requestBody.required, true);
  assert.equal(
    deleteCooldowns.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ModelCooldownClearRequest",
  );
  const clearRequestSchema = spec.components.schemas.ModelCooldownClearRequest;
  assert.match(clearRequestSchema.description, /`all: true`.*otherwise both `provider`.*`model`/s);
  assert.deepEqual(clearRequestSchema.anyOf[0].required, ["all"]);
  assert.equal(clearRequestSchema.anyOf[0].properties.all.const, true);
  assert.deepEqual(clearRequestSchema.anyOf[1].required, ["provider", "model"]);
  assert.equal(clearRequestSchema.additionalProperties, true);

  for (const route of ["/api/search/providers", "/api/search/stats"]) {
    const routeOperation = operation("get", route);
    assert.ok(hasScheme(routeOperation.security, "ManagementApiKeyBearerAuth"));
    assert.ok(hasScheme(routeOperation.security, "ManagementSessionAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.equal(hasScheme(routeOperation.security, "BearerAuth"), false);
    assert.equal(hasScheme(routeOperation.security, "LocalCliTokenAuth"), false);
    assert.equal(hasScheme(routeOperation.security, "InternalServiceTokenAuth"), false);
    assert.equal(routeOperation["x-local-only"], undefined);
    assert.match(routeOperation.description, /narrower `isAuthenticated\(\)` check/i);
    assert.match(routeOperation.description, /does not accept central-only `oma_`.*CLI tokens.*internal-service tokens/s);
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.match(routeOperation.description, /first-run bootstrap.*loopback/i);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }

  assert.equal(spec.components.schemas.SearchProviderCatalogItem.properties.status["x-sensitive"], true);
  assert.equal(spec.components.schemas.SearchStatsRecentItem.properties.query["x-sensitive"], true);
  assert.equal(spec.components.schemas.SearchStatsRecentItem.properties.filters["x-sensitive"], true);
});

test("embedded-service endpoints preserve the spawn-capable LOCAL_ONLY gate and admin access-token scope", () => {
  for (const [method, route] of [
    ["post", "/api/services/9router/rotate-key"],
    ["post", "/api/services/9router/start"],
    ["get", "/api/services/9router/status"],
    ["post", "/api/services/9router/stop"],
    ["post", "/api/services/9router/update"],
    ["post", "/api/services/bifrost/auto-restart-adopted"],
    ["post", "/api/services/bifrost/auto-start"],
    ["post", "/api/services/bifrost/install"],
    ["post", "/api/services/bifrost/restart"],
    ["post", "/api/services/bifrost/start"],
    ["get", "/api/services/bifrost/status"],
    ["post", "/api/services/bifrost/stop"],
    ["post", "/api/services/bifrost/update"],
    ["get", "/api/services/cliproxy/accounts"],
    ["post", "/api/services/cliproxy/auto-restart-adopted"],
    ["get", "/api/services/{name}/logs"],
    ["post", "/api/services/9router/auto-restart-adopted"],
    ["post", "/api/services/9router/auto-start"],
    ["post", "/api/services/9router/install"],
    ["post", "/api/services/9router/provider-expose"],
    ["post", "/api/services/9router/restart"],
    ["get", "/api/services/9router/models"],
    ["post", "/api/services/cliproxy/auto-start"],
    ["post", "/api/services/cliproxy/install"],
    ["post", "/api/services/cliproxy/provider-expose"],
    ["post", "/api/services/cliproxy/restart"],
    ["post", "/api/services/cliproxy/start"],
    ["get", "/api/services/cliproxy/status"],
    ["post", "/api/services/cliproxy/stop"],
    ["post", "/api/services/cliproxy/update"],
    ["post", "/api/services/dario/auto-restart-adopted"],
    ["post", "/api/services/dario/auto-start"],
    ["post", "/api/services/dario/install"],
    ["post", "/api/services/dario/restart"],
    ["post", "/api/services/dario/start"],
    ["get", "/api/services/dario/status"],
    ["post", "/api/services/dario/stop"],
    ["post", "/api/services/dario/update"],
    ["post", "/api/services/mux/auto-restart-adopted"],
    ["post", "/api/services/mux/auto-start"],
    ["post", "/api/services/mux/install"],
    ["post", "/api/services/mux/restart"],
    ["post", "/api/services/mux/start"],
    ["post", "/api/services/mux/stop"],
    ["post", "/api/services/mux/update"],
    ["get", "/api/services/mux/status"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-local-only"], true, `${method.toUpperCase()} ${route}`);
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /LOCAL_ONLY/);
    assert.match(routeOperation.description, /loopback.*trusted private-LAN/i);
    assert.match(routeOperation.description, /no remote manage-scope bypass/i);
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.match(routeOperation.description, /`oma_`.*`admin`.*`\/api\/services\/\*`/s);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }
});

test("session-pool, session, storage, and synced-model reads keep their distinct management auth chains", () => {
  for (const route of ["/api/session-pools", "/api/session-pools/{provider}"]) {
    const routeOperation = operation("get", route);
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(hasScheme(routeOperation.security, "ManagementSessionAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.equal(routeOperation["x-local-only"], undefined);
    assert.match(routeOperation.description, /handler's `requireManagementAuth` check/i);
    assert.match(routeOperation.description, /method-derived `read` scope/i);
    assert.match(routeOperation.description, /requireLogin=false.*including remotely/s);
    assert.match(routeOperation.description, /not explicitly public or LOCAL_ONLY/i);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }
  assert.ok(operation("get", "/api/session-pools/{provider}").responses["404"]);

  for (const route of ["/api/sessions", "/api/storage/health"]) {
    const routeOperation = operation("get", route);
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.equal(routeOperation["x-local-only"], undefined);
    assert.match(routeOperation.description, /no route-level auth check and relies on the central MANAGEMENT policy/i);
    assert.match(routeOperation.description, /method-derived `read` scope/i);
    assert.match(routeOperation.description, /requireLogin=false.*including remotely/s);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }
  assert.match(operation("get", "/api/sessions").description, /per-API-key session counts/i);
  assert.match(operation("get", "/api/storage/health").description, /host filesystem layout/i);

  const synced = operation("get", "/api/synced-available-models");
  assert.ok(hasScheme(synced.security, "ManagementApiKeyBearerAuth"));
  assert.ok(hasScheme(synced.security, "ManagementSessionAuth"));
  assert.ok(synced.security.some((alternative: object) => Object.keys(alternative).length === 0));
  assert.equal(hasScheme(synced.security, "BearerAuth"), false);
  assert.equal(hasScheme(synced.security, "LocalCliTokenAuth"), false);
  assert.equal(hasScheme(synced.security, "InternalServiceTokenAuth"), false);
  assert.equal(synced["x-local-only"], undefined);
  assert.match(synced.description, /central MANAGEMENT auth.*narrower `isAuthenticated\(\)` check/is);
  assert.match(synced.description, /does not accept central-only.*`oma_`.*loopback CLI tokens.*internal-service tokens/s);
  assert.match(synced.description, /requireLogin=false.*including remotely/s);
  assert.equal(synced.responses["200"]["x-sensitive"], true);
  assert.ok(synced.responses["401"]);
  assert.ok(synced.responses["403"]);
  assert.ok(synced.responses["503"]);
});

test("Mux and Dario service documentation covers locked capabilities and sensitive status data", () => {
  for (const [method, route] of [
    ["post", "/api/services/mux/install"],
    ["post", "/api/services/mux/start"],
    ["post", "/api/services/mux/restart"],
    ["post", "/api/services/mux/update"],
    ["get", "/api/services/mux/status"],
    ["post", "/api/services/dario/install"],
    ["post", "/api/services/dario/start"],
    ["post", "/api/services/dario/restart"],
    ["get", "/api/services/dario/status"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-sensitive"], true);
    assert.match(routeOperation.description, /runtime policy mode `locked`/i);
  }
  assert.match(operation("get", "/api/services/mux/status").description, /Mux server token.*not returned/i);
  assert.match(operation("get", "/api/services/dario/status").description, /DARIO_ADMIN_TOKEN/);
  assert.match(operation("get", "/api/services/dario/status").description, /admin key.*fails closed/i);
  assert.match(operation("post", "/api/services/dario/update").description, /restart failure.*still report success/i);
  assert.match(operation("post", "/api/services/mux/stop").description, /stop remains allowed.*`locked`/i);
  assert.match(operation("post", "/api/services/dario/stop").description, /stop remains (?:available|allowed).*`locked`/i);

  const muxAutoStart = operation("post", "/api/services/mux/auto-start");
  const successes = Object.keys(muxAutoStart.responses).filter((status) => /^2\d\d$/.test(status));
  assert.deepEqual(successes, ["204"]);
  assert.equal(muxAutoStart.responses["204"].content, undefined);

  const darioStop = operation("post", "/api/services/dario/stop");
  const muxStop = operation("post", "/api/services/mux/stop");
  assert.match(darioStop.description, /without probing.*unmanaged process/i);
  assert.match(muxStop.description, /without probing.*unmanaged process/i);
});

test("service model, lifecycle, and status contracts remain LOCAL_ONLY and mark sensitive state", () => {
  const nineRouterModels = operation("get", "/api/services/9router/models");
  assert.match(nineRouterModels.description, /`refresh=true`.*encrypted server-side 9Router key/s);
  assert.match(nineRouterModels.description, /key is resolved or generated server-side.*never included in the response/i);
  assert.equal(nineRouterModels.responses["200"]["x-sensitive"], true);

  const cliproxyStatus = operation("get", "/api/services/cliproxy/status");
  const darioStatus = operation("get", "/api/services/dario/status");
  for (const status of [cliproxyStatus, darioStatus]) {
    assert.equal(status["x-sensitive"], true);
    assert.equal(status.responses["200"]["x-sensitive"], true);
    assert.match(status.description, /no reveal query/i);
    assert.match(status.description, /runtime policy mode `locked`.*status (?:route )?return 500/s);
    assert.equal(status.responses["200"].headers?.["Cache-Control"], undefined);
  }
  assert.match(cliproxyStatus.description, /management password remains server-side/i);
  assert.match(darioStatus.description, /DARIO_ADMIN_TOKEN/);

  for (const [method, route] of [
    ["post", "/api/services/cliproxy/auto-start"],
    ["post", "/api/services/cliproxy/install"],
    ["post", "/api/services/cliproxy/provider-expose"],
    ["post", "/api/services/cliproxy/restart"],
    ["post", "/api/services/cliproxy/start"],
    ["post", "/api/services/cliproxy/stop"],
    ["post", "/api/services/cliproxy/update"],
    ["post", "/api/services/dario/auto-restart-adopted"],
    ["post", "/api/services/dario/auto-start"],
    ["post", "/api/services/dario/install"],
    ["post", "/api/services/dario/restart"],
    ["post", "/api/services/dario/start"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-sensitive"], true);
  }
  for (const [method, route] of [
    ["post", "/api/services/cliproxy/install"],
    ["post", "/api/services/cliproxy/start"],
    ["post", "/api/services/cliproxy/restart"],
    ["post", "/api/services/cliproxy/update"],
    ["post", "/api/services/dario/install"],
    ["post", "/api/services/dario/start"],
    ["post", "/api/services/dario/restart"],
  ] as const) {
    assert.match(operation(method, route).description, /runtime policy mode `locked`/i);
  }
  assert.match(operation("post", "/api/services/cliproxy/stop").description, /stopping remains allowed.*`locked`/i);
  for (const [method, route] of [
    ["post", "/api/services/cliproxy/auto-start"],
    ["post", "/api/services/cliproxy/provider-expose"],
    ["post", "/api/services/dario/auto-start"],
    ["post", "/api/services/dario/auto-restart-adopted"],
  ] as const) {
    assert.match(operation(method, route).description, /persist|when enabled|changes whether/i);
  }

  const autoStart = operation("post", "/api/services/cliproxy/auto-start");
  const successes = Object.keys(autoStart.responses).filter((status) => /^2\d\d$/.test(status));
  assert.deepEqual(successes, ["204"]);
  assert.equal(autoStart.responses["204"].content, undefined);
  assert.match(operation("post", "/api/services/dario/start").description, /admin-token retrieval failure path is fail-closed/i);

  const nineRouterStatus = operation("get", "/api/services/9router/status");
  assert.match(nineRouterStatus.description, /`reveal=key`.*`X-Reveal-Confirm: yes`/s);
  assert.equal(nineRouterStatus.responses["200"].headers["Cache-Control"].schema.const, "no-store");
});

test("service logs and 9Router lifecycle operations are sensitive and auto-start is bodyless 204", () => {
  const logs = operation("get", "/api/services/{name}/logs");
  assert.equal(logs["x-sensitive"], true);
  assert.equal(logs.responses["200"]["x-sensitive"], true);
  assert.match(logs.description, /log lines can contain credentials.*local paths/i);
  assert.ok(logs.responses["401"]);
  assert.ok(logs.responses["403"]);
  assert.ok(logs.responses["503"]);

  for (const [method, route] of [
    ["post", "/api/services/9router/auto-restart-adopted"],
    ["post", "/api/services/9router/auto-start"],
    ["post", "/api/services/9router/install"],
    ["post", "/api/services/9router/provider-expose"],
    ["post", "/api/services/9router/restart"],
  ] as const) {
    assert.equal(operation(method, route)["x-sensitive"], true);
  }
  assert.equal(operation("post", "/api/services/9router/install").responses["200"]["x-sensitive"], true);
  assert.equal(operation("post", "/api/services/9router/restart").responses["200"]["x-sensitive"], true);

  const autoStart = operation("post", "/api/services/9router/auto-start");
  const successes = Object.keys(autoStart.responses).filter((status) => /^2\d\d$/.test(status));
  assert.deepEqual(successes, ["204"]);
  assert.equal(autoStart.responses["204"].content, undefined);
});

test("9Router status scopes and no-store handling cover its explicit raw-key reveal branch", () => {
  const status = operation("get", "/api/services/9router/status");
  assert.match(status.description, /`reveal=key`.*`X-Reveal-Confirm: yes`/s);
  assert.match(status.description, /confirmation gate, not authentication/i);
  assert.equal(status["x-local-only"], true);
  assert.equal(status.responses["200"]["x-sensitive"], true);
  assert.equal(status.responses["200"].headers["Cache-Control"].schema.const, "no-store");
  assert.ok(status.parameters.some((parameter: any) => parameter.name === "reveal" && parameter.in === "query"));
  assert.ok(status.parameters.some((parameter: any) => parameter.name === "X-Reveal-Confirm" && parameter.in === "header"));
  const extended = spec.components.schemas.ServiceStatusExtended;
  const allOfObject = extended.allOf.find((part: any) => part.properties?.apiKeyPlain);
  assert.equal(allOfObject.properties.apiKeyPlain["x-sensitive"], true);
  assert.equal(allOfObject.properties.apiKeyPlain.readOnly, true);

  const cliproxyAccounts = operation("get", "/api/services/cliproxy/accounts");
  assert.equal(cliproxyAccounts.responses["200"]["x-sensitive"], true);
  assert.equal(cliproxyAccounts.responses["200"].headers["Cache-Control"].schema.const, "no-store");
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

test("usage endpoints retain central management auth and expose sensitive quota and cost data", () => {
  for (const [method, route, scope] of [
    ["get", "/api/usage/{connectionId}", "read"],
    ["get", "/api/usage/analytics", "read"],
    ["get", "/api/usage/history", "read"],
    ["get", "/api/usage/budget", "read"],
    ["post", "/api/usage/budget", "write"],
    ["get", "/api/usage/cache-health", "read"],
    ["get", "/api/usage/combo-health", "read"],
    ["get", "/api/usage/utilization", "read"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.equal(routeOperation["x-local-only"], undefined);
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(hasScheme(routeOperation.security, "ManagementSessionAuth"));
    assert.ok(hasScheme(routeOperation.security, "LocalCliTokenAuth"));
    assert.ok(hasScheme(routeOperation.security, "InternalServiceTokenAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(routeOperation.description, /MANAGEMENT/);
    assert.match(routeOperation.description, new RegExp(`method-derived.*${scope}`, "i"));
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }

  for (const route of [
    "/api/usage/analytics",
    "/api/usage/history",
    "/api/usage/budget",
  ]) {
    const method = route === "/api/usage/budget" ? "post" : "get";
    assert.match(operation(method, route).description, /`requireManagementAuth\(\)`/);
  }

  const live = operation("get", "/api/usage/{connectionId}");
  assert.equal(live.parameters.find((parameter: any) => parameter.name === "connectionId")["x-sensitive"], true);
  assert.match(live.description, /refreshes live provider quota.*persists.*cache/i);
  assert.match(live.description, /exact sibling `\/api\/usage\/om-usage`.*separate public CLI endpoint/i);
  const analytics = operation("get", "/api/usage/analytics");
  assert.equal(analytics.parameters.find((parameter: any) => parameter.name === "apiKeyIds")["x-sensitive"], true);
  const budgetGet = operation("get", "/api/usage/budget");
  assert.equal(budgetGet.parameters.find((parameter: any) => parameter.name === "apiKeyId")["x-sensitive"], true);
  assert.equal(operation("post", "/api/usage/budget").requestBody["x-sensitive"], true);
  assert.match(operation("get", "/api/usage/utilization").description, /email, name, and display name/i);
});

test("Tailscale login and daemon start are local-only spawn routes with handler auth and locked-mode gates", () => {
  for (const route of [
    "/api/tunnels/tailscale/login",
    "/api/tunnels/tailscale/start-daemon",
  ]) {
    const routeOperation = operation("post", route);
    assert.equal(routeOperation["x-local-only"], true);
    assert.ok(hasScheme(routeOperation.security, "ManagementApiKeyBearerAuth"));
    assert.ok(hasScheme(routeOperation.security, "ManagementGoogleApiKeyAuth"));
    assert.ok(hasScheme(routeOperation.security, "ManagementAnthropicApiKeyAuth"));
    assert.ok(hasScheme(routeOperation.security, "ManagementSessionAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.ok(!hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(!hasScheme(routeOperation.security, "LocalCliTokenAuth"));
    assert.ok(!hasScheme(routeOperation.security, "InternalServiceTokenAuth"));
    assert.match(routeOperation.description, /central MANAGEMENT.*`isAuthenticated\(\)`/is);
    assert.match(routeOperation.description, /LOCAL_ONLY.*spawn-capable.*no remote manage-scope bypass/s);
    assert.match(routeOperation.description, /requireLogin=false/);
    assert.match(routeOperation.description, /locked.*blocks.*capability/i);
    assert.equal(routeOperation.requestBody["x-sensitive"], true);
    assert.equal(routeOperation.responses["200"]["x-sensitive"], true);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["403"]);
    assert.ok(routeOperation.responses["503"]);
  }
  assert.match(operation("post", "/api/tunnels/tailscale/login").description, /authentication URL.*sensitive/i);
  assert.match(operation("post", "/api/tunnels/tailscale/start-daemon").description, /sudo password.*sensitive/i);
});

test("remaining v1 catalog and search reads use conditional CLIENT_API authentication", () => {
  for (const [method, route] of [
    ["head", "/api/v1/models"],
    ["get", "/api/v1/models/{model}"],
    ["head", "/api/v1/models/{model}"],
    ["get", "/api/v1/provider-plugin-manifest"],
    ["get", "/api/v1/search"],
  ] as const) {
    const routeOperation = operation(method, route);
    assert.ok(hasScheme(routeOperation.security, "BearerAuth"));
    assert.ok(hasScheme(routeOperation.security, "ClientApiKeyAuth"));
    assert.ok(hasScheme(routeOperation.security, "GoogleApiKeyAuth"));
    assert.ok(hasScheme(routeOperation.security, "ManagementSessionAuth"));
    assert.ok(routeOperation.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.ok(!hasScheme(routeOperation.security, "LocalCliTokenAuth"));
    assert.ok(!hasScheme(routeOperation.security, "InternalServiceTokenAuth"));
    assert.match(routeOperation.description, /CLIENT_API/);
    assert.match(routeOperation.description, /REQUIRE_API_KEY/);
    assert.ok(routeOperation.responses["401"]);
    assert.ok(routeOperation.responses["503"]);
  }
  for (const route of ["/api/v1/models", "/api/v1/models/{model}"]) {
    const head = operation("head", route);
    assert.match(head.description, /does not run.*`requireAuthForModels`/);
  }
  assert.match(operation("get", "/api/v1/models/{model}").description, /`isAuthRequired\(\)`.*`requireAuthForModels`/);
  assert.match(operation("get", "/api/v1/provider-plugin-manifest").description, /service-backend model IDs and capabilities.*no provider credentials/i);
  assert.match(operation("get", "/api/v1/provider-plugin-manifest").description, /publicly cacheable for 60 seconds/i);
  assert.match(operation("get", "/api/v1/search").description, /no credentials are returned/i);
});
