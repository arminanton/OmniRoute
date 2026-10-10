import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Operation = {
  description?: string;
  security?: Array<Record<string, string[]>>;
  [key: string]: any;
};
const docsText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8");
const spec = yaml.load(docsText) as { paths: Record<string, Record<string, Operation>> };

function operation(pathname: string, method: string): Operation {
  const result = spec.paths[pathname]?.[method];
  assert.ok(result, `missing OpenAPI operation ${method.toUpperCase()} ${pathname}`);
  return result;
}
function securityNames(op: Operation): string[] {
  return (op.security ?? []).flatMap((alternative) => Object.keys(alternative));
}
function assertConditionalManagement(op: Operation) {
  const alternatives = op.security ?? [];
  assert.ok(securityNames(op).includes("BearerAuth"));
  assert.ok(securityNames(op).includes("ManagementSessionAuth"));
  assert.ok(alternatives.some((alternative) => Object.keys(alternative).length === 0));
  assert.match(op.description ?? "", /requireLogin=false/);
  assert.equal(
    op.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  const forbidden = op.responses?.["403"];
  assert.ok(
    forbidden?.$ref === "#/components/responses/ManagementInvalidToken" ||
      forbidden?.content?.["application/json"]?.schema?.$ref ===
        "#/components/schemas/ApiErrorResponse"
  );
  assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
}

test("management-auth route batch declares conditional session and bearer access", () => {
  const protectedOperations: Array<[string, string]> = [
    ["/api/admin/concurrency", "get"],
    ["/api/admin/concurrency", "post"],
    ["/api/chaos/run", "post"],
    ["/api/keys", "get"],
    ["/api/keys", "post"],
    ["/api/services/dario/admin/accounts", "get"],
    ["/api/services/dario/admin/accounts", "delete"],
    ["/api/services/dario/admin/import-from-omniroute", "get"],
    ["/api/services/dario/admin/import-from-omniroute", "post"],
    ["/api/services/dario/admin/login-start", "post"],
    ["/api/services/dario/admin/login-complete", "post"],
    ["/api/usage/provider-limits", "get"],
    ["/api/usage/provider-limits", "post"],
    ["/api/usage/quota", "get"],
    ["/api/usage/token-limits", "get"],
    ["/api/usage/token-limits", "post"],
    ["/api/usage/token-limits", "delete"],
  ];
  for (const [pathname, method] of protectedOperations) {
    assertConditionalManagement(operation(pathname, method));
  }
  for (const pathname of [
    "/api/services/dario/admin/accounts",
    "/api/services/dario/admin/import-from-omniroute",
    "/api/services/dario/admin/login-start",
    "/api/services/dario/admin/login-complete",
  ]) {
    const methods = spec.paths[pathname];
    for (const [method, op] of Object.entries(methods)) {
      if (["get", "post", "delete"].includes(method)) {
        assert.equal(op["x-local-only"], true, `${method.toUpperCase()} ${pathname}`);
        assert.match(op.description ?? "", /LOCAL_ONLY/);
      }
    }
  }
});

test("legacy auth helpers document their narrower end-to-end credentials", () => {
  for (const method of ["get", "post"]) {
    const op = operation("/api/system/env/repair", method);
    assert.ok(securityNames(op).includes("ManagementApiKeyBearerAuth"));
    assert.ok(securityNames(op).includes("ManagementSessionAuth"));
    assert.ok((op.security ?? []).some((entry) => Object.keys(entry).length === 0));
    assert.equal(securityNames(op).includes("BearerAuth"), false);
    assert.match(op.description ?? "", /does not accept `oma_live_` access tokens/i);
    assert.equal(
      op.responses?.["401"]?.$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    const forbidden = op.responses?.["403"];
    assert.ok(
      forbidden?.$ref === "#/components/responses/ManagementInvalidToken" ||
        forbidden?.content?.["application/json"]?.schema?.$ref ===
          "#/components/schemas/ApiErrorResponse"
    );
    assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
  }
  const inventory = operation("/api/settings/authz-inventory", "get");
  assert.ok(securityNames(inventory).includes("ManagementApiKeyBearerAuth"));
  assert.ok(securityNames(inventory).includes("ManagementSessionAuth"));
  assert.equal(securityNames(inventory).includes("BearerAuth"), false);
  assert.match(
    inventory.description ?? "",
    /does not accept `oma_live_` access tokens end-to-end/i
  );
});

test("key, OAuth, account, quota, and configuration responses are marked sensitive", () => {
  const response = (pathname: string, method: string, code: string) =>
    operation(pathname, method).responses?.[code];
  assert.equal(response("/api/keys", "get", "200")?.["x-sensitive"], true);
  assert.equal(response("/api/keys", "post", "201")?.["x-sensitive"], true);
  assert.equal(
    operation("/api/services/dario/admin/import-from-omniroute", "post")["x-sensitive"],
    true
  );
  assert.equal(
    response("/api/services/dario/admin/import-from-omniroute", "get", "200")?.["x-sensitive"],
    true
  );
  assert.equal(response("/api/services/dario/admin/accounts", "get", "200")?.["x-sensitive"], true);
  assert.equal(response("/api/settings/authz-inventory", "get", "200")?.["x-sensitive"], true);
  for (const [pathname, method, code] of [
    ["/api/system/env/repair", "get", "200"],
    ["/api/system/env/repair", "post", "200"],
    ["/api/usage/provider-limits", "get", "200"],
    ["/api/usage/provider-limits", "post", "200"],
    ["/api/usage/quota", "get", "200"],
    ["/api/usage/token-limits", "get", "200"],
    ["/api/usage/token-limits", "post", "200"],
    ["/api/usage/token-limits", "delete", "200"],
  ] as const) {
    assert.equal(response(pathname, method, code)?.["x-sensitive"], true, `${method} ${pathname}`);
  }
  assert.equal(publicText, docsText, "public OpenAPI must be an exact mirror of docs/openapi.yaml");
});
