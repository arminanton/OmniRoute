import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as yaml from "js-yaml";

const canonicalText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

function operation(method: string, pathname: string) {
  const value = spec.paths[pathname]?.[method];
  assert.ok(value, `Missing ${method.toUpperCase()} ${pathname}`);
  return value;
}

const contracts = [
  ["delete", "/api/discovery/results/{id}", ["200", "400", "401", "403", "404", "500", "503"], "DiscoveryResultDeleteResponse"],
  ["get", "/api/discovery/results/{id}", ["200", "400", "401", "403", "404", "500", "503"], "DiscoveryResultResponse"],
  ["post", "/api/discovery/scan", ["200", "400", "401", "403", "500", "503"], "DiscoveryResultsResponse"],
  ["post", "/api/discovery/verify/{id}", ["200", "400", "401", "403", "404", "500", "503"], "DiscoveryResultResponse"],
  ["get", "/api/docs", ["200", "401", "403", "503"], null],
  ["get", "/api/docs/codex-cli", ["200", "401", "403", "404", "503"], "CodexCliGuideResponse"],
  ["get", "/api/evals", ["200", "401", "403", "500", "503"], "EvalDashboardResponse"],
  ["post", "/api/evals", ["200", "400", "401", "403", "500", "503"], "EvalRunResponse"],
  ["get", "/api/evals/{suiteId}", ["200", "401", "403", "404", "500", "503"], "EvalSuiteByIdResponse"],
  ["get", "/api/free-tier/summary", ["200", "401", "403", "503"], "FreeTierSummaryResponse"],
  ["get", "/api/gamification/anomalies", ["200", "401", "403", "503"], "GamificationAnomaliesResponse"],
  ["get", "/api/gamification/badges", ["200", "401", "403", "503"], "GamificationBadgeDefinitionsResponse"],
  ["get", "/api/gamification/badges/earned", ["200", "401", "403", "503"], "GamificationEarnedBadgesResponse"],
  ["get", "/api/github-skills", ["200", "401", "403", "500", "503"], "GitHubSkillsSearchResponse"],
  ["post", "/api/github-skills", ["200", "400", "401", "403", "500", "503"], "GitHubSkillsInstallPlanResponse"],
] as const;

test("all 15 audited operations have source-backed status sets and typed success bodies", () => {
  assert.equal(contracts.length, 15);
  for (const [method, pathname, statuses, schemaName] of contracts) {
    const op = operation(method, pathname);
    assert.deepEqual(Object.keys(op.responses).sort(), [...statuses].sort(), `${method.toUpperCase()} ${pathname}`);
    const response = op.responses["200"];
    assert.ok(response, `${method.toUpperCase()} ${pathname} has a 200 response`);
    if (pathname === "/api/docs") {
      assert.equal(response.content?.["text/html"]?.schema?.type, "string");
      continue;
    }
    assert.equal(
      response.content?.["application/json"]?.schema?.$ref,
      `#/components/schemas/${schemaName}`,
      `${method.toUpperCase()} ${pathname}`,
    );
    assert.ok(spec.components.schemas[schemaName!], `Missing ${schemaName}`);
  }
});

test("auth and locality declarations from the security batch remain intact", () => {
  for (const pathname of ["/api/docs", "/api/docs/codex-cli"]) {
    const op = operation("get", pathname);
    assert.notDeepEqual(op.security, [], `${pathname} is not explicitly public`);
    assert.ok(op.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.match(op.description, /central classifier assigns it to MANAGEMENT/i);
  }

  for (const pathname of [
    "/api/gamification/anomalies",
    "/api/gamification/badges",
    "/api/gamification/badges/earned",
  ]) {
    const op = operation("get", pathname);
    assert.notDeepEqual(op.security, []);
    assert.ok(op.security.some((alternative: object) => Object.keys(alternative).length === 0));
    assert.equal(op["x-local-only"], undefined, `${pathname} has no enforced locality gate`);
    assert.match(op.description, /centrally classified as MANAGEMENT/);
  }
  assert.equal(operation("get", "/api/discovery/results/{id}")["x-local-only"], true);
  assert.match(operation("get", "/api/free-tier/summary").description, /paid overlay may be returned anonymously/i);
});

test("sensitive evaluation, discovery, usage, and GitHub destination fields are marked", () => {
  assert.equal(operation("get", "/api/discovery/results/{id}").responses["200"]["x-sensitive"], true);
  assert.equal(operation("post", "/api/discovery/scan").responses["200"]["x-sensitive"], true);
  assert.equal(operation("get", "/api/evals").responses["200"]["x-sensitive"], true);
  assert.equal(operation("post", "/api/evals").requestBody["x-sensitive"], true);
  assert.equal(operation("post", "/api/evals").responses["200"]["x-sensitive"], true);
  assert.equal(operation("get", "/api/evals/{suiteId}").responses["200"]["x-sensitive"], true);
  assert.equal(operation("get", "/api/free-tier/summary").responses["200"]["x-sensitive"], true);
  assert.ok(operation("get", "/api/free-tier/summary").parameters.some((p: any) => p.name === "excludeTosAvoid"));
  assert.ok(operation("get", "/api/gamification/badges").parameters.some((p: any) => p.name === "category"));
  assert.equal(spec.components.schemas.GamificationAnomaly.properties.apiKeyId["x-sensitive"], true);
  assert.equal(spec.components.schemas.GamificationEarnedBadge.properties.apiKeyId["x-sensitive"], true);
  assert.equal(spec.components.schemas.GitHubSkillPlanTargetSuccess.properties.destDir["x-sensitive"], true);
});

test("docs shell documents its cache/robots headers and Codex guide exposes its body variant", () => {
  const docs = operation("get", "/api/docs").responses["200"];
  assert.equal(docs.headers["Cache-Control"].schema.const, "public, max-age=300, s-maxage=300");
  assert.equal(docs.headers["X-Robots-Tag"].schema.const, "noindex");
  assert.equal(
    operation("get", "/api/docs/codex-cli").responses["404"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse",
  );
});

test("GitHub skill plan documents per-target planned/error variants", () => {
  assert.deepEqual(
    operation("get", "/api/github-skills").parameters.map((p: any) => p.name).sort(),
    ["maxResults", "minScore", "minStars", "query"],
  );
  const result = spec.components.schemas.GitHubSkillPlanTargetResult;
  assert.deepEqual(result.oneOf.map((item: any) => item.$ref), [
    "#/components/schemas/GitHubSkillPlanTargetSuccess",
    "#/components/schemas/GitHubSkillPlanTargetFailure",
  ]);
  assert.equal(spec.components.schemas.GitHubSkillPlanTargetSuccess.properties.action.const, "planned");
  assert.equal(spec.components.schemas.GitHubSkillPlanTargetFailure.properties.action.const, "error");
});

test("public OpenAPI mirror remains byte-identical to the canonical document", () => {
  assert.equal(fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8"), canonicalText);
});
