import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Operation = {
  description?: string;
  security?: Array<Record<string, string[]>>;
  responses?: Record<string, Record<string, any>>;
  [key: string]: any;
};

const root = process.cwd();
const canonicalText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(root, "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, any> };
};

const managementSchemes = [
  "BearerAuth",
  "ManagementGoogleApiKeyAuth",
  "ManagementAnthropicApiKeyAuth",
  "ManagementSessionAuth",
  "LocalCliTokenAuth",
  "InternalServiceTokenAuth",
];

function operation(pathname: string, method: string): Operation {
  const value = spec.paths[pathname]?.[method];
  assert.ok(value, `missing ${method.toUpperCase()} ${pathname}`);
  return value;
}

function securityNames(op: Operation): string[] {
  return (op.security ?? []).flatMap((alternative) => Object.keys(alternative));
}

function assertConditionalManagement(op: Operation, label: string): void {
  const alternatives = op.security ?? [];
  for (const scheme of managementSchemes) {
    assert.ok(securityNames(op).includes(scheme), `${label} accepts ${scheme}`);
  }
  assert.ok(alternatives.some((alternative) => Object.keys(alternative).length === 0));
  assert.match(op.description ?? "", /requireLogin=false/);
  assert.match(op.description ?? "", /not in the explicit public allowlist|not in the explicit public API allowlist/i);
  for (const status of ["401", "403", "503"]) {
    assert.ok(op.responses?.[status], `${label} documents ${status}`);
  }
}

test("context combo management routes declare conditional management security and exact errors", () => {
  const contracts: Array<[string, string, string[]]> = [
    ["/api/context/combos/{id}", "delete", ["200", "401", "403", "404", "503"]],
    ["/api/context/combos/{id}", "get", ["200", "401", "403", "404", "503"]],
    ["/api/context/combos/{id}", "put", ["200", "400", "401", "403", "404", "503"]],
    ["/api/context/combos/{id}/assignments", "get", ["200", "401", "403", "404", "503"]],
    ["/api/context/combos/{id}/assignments", "put", ["200", "400", "401", "403", "404", "503"]],
    ["/api/context/combos/default", "get", ["200", "401", "403", "503"]],
    ["/api/context/combos/default", "post", ["401", "403", "410", "503"]],
    ["/api/context/combos/default", "put", ["401", "403", "410", "503"]],
  ];
  for (const [pathname, method, statuses] of contracts) {
    const op = operation(pathname, method);
    assertConditionalManagement(op, `${method.toUpperCase()} ${pathname}`);
    assert.notEqual(op["x-local-only"], true);
    assert.deepEqual(Object.keys(op.responses ?? {}).sort(), [...statuses].sort());
  }
});

test("Cursor CLI catch-all preserves method/path-specific exchange and forwarding auth", () => {
  const get = operation("/api/cursor-cli/{path}", "get");
  assert.deepEqual(get.security, [{ CursorCliSessionBearerAuth: [] }]);
  assert.equal(get["x-local-only"], undefined);
  const getBranches = get["x-authentication-branches"];
  assert.ok(getBranches.some((branch: any) => branch.pathSuffix === "/auth/exchange_user_api_key" && branch.result.includes("405")));
  assert.ok(getBranches.some((branch: any) => branch.pathSuffix === "all other paths"));

  const post = operation("/api/cursor-cli/{path}", "post");
  assert.deepEqual(post.security, [
    { CursorCliSessionBearerAuth: [] },
    { CursorCliBootstrapApiKeyBearerAuth: [] },
  ]);
  assert.equal(
    post.security.some((alternative) => Object.keys(alternative).length === 0),
    false,
    "the whole catch-all is never declared anonymously accessible"
  );
  const branches = post["x-authentication-branches"] as Array<Record<string, any>>;
  const exchange = branches.find((branch) => branch.pathSuffix === "/auth/exchange_user_api_key");
  assert.ok(exchange);
  assert.equal(exchange.method, "POST");
  assert.equal(exchange.anonymousCondition, "REQUIRE_API_KEY=false");
  assert.ok(exchange.security.some((alternative: Record<string, unknown>) => Object.keys(alternative).length === 0));
  assert.match(exchange.result, /sensitive session JWT/i);
  const forward = branches.find((branch) => branch.pathSuffix === "all other paths");
  assert.ok(forward);
  assert.deepEqual(forward.security, [{ CursorCliSessionBearerAuth: [] }]);
  assert.equal(post.responses?.["200"]?.["x-sensitive"], true);
  assert.equal(spec.components.securitySchemes.CursorCliSessionBearerAuth.scheme, "bearer");
  assert.equal(spec.components.securitySchemes.CursorCliBootstrapApiKeyBearerAuth.scheme, "bearer");
});

test("Dahl token proxy uses conditional central management auth and marks the returned token sensitive", () => {
  const op = operation("/api/dahl/tokens", "post");
  assertConditionalManagement(op, "POST /api/dahl/tokens");
  assert.notEqual(op["x-local-only"], true);
  const success = op.responses?.["2XX"];
  assert.equal(success?.["x-sensitive"], true);
  assert.equal(success?.headers?.["Cache-Control"]?.schema?.const, "no-store");
  const token = success?.content?.["application/json"]?.schema?.properties?.token;
  assert.equal(token?.["x-sensitive"], true);
  assert.match(op.description ?? "", /fixed request to Dahl/i);
});

test("discovery routes preserve the LOCAL_ONLY boundary across unlocked management auth", () => {
  const contracts: Array<[string, string, string[]]> = [
    ["/api/discovery/results", "get", ["200", "401", "403", "500", "503"]],
    ["/api/discovery/results/{id}", "get", ["200", "400", "401", "403", "404", "500", "503"]],
    ["/api/discovery/scan", "post", ["200", "400", "401", "403", "500", "503"]],
    ["/api/discovery/verify/{id}", "post", ["200", "400", "401", "403", "404", "500", "503"]],
  ];
  for (const [pathname, method, statuses] of contracts) {
    const op = operation(pathname, method);
    assertConditionalManagement(op, `${method.toUpperCase()} ${pathname}`);
    assert.equal(op["x-local-only"], true);
    assert.match(op.description ?? "", /loopback and trusted private-LAN/i);
    assert.match(op.description ?? "", /(?:no|does not allow a) remote manage-scope bypass/i);
    assert.equal(op.responses?.["200"]?.["x-sensitive"], true);
    assert.deepEqual(Object.keys(op.responses ?? {}).sort(), [...statuses].sort());
  }
  assert.match(operation("/api/discovery/scan", "post").description ?? "", /outbound.*provider/i);
});

test("the public OpenAPI mirror remains byte-identical to the canonical contract", () => {
  assert.equal(publicText, canonicalText);
});
