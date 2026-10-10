import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Operation = {
  description?: string;
  security?: Array<Record<string, string[]>>;
  responses?: Record<string, Record<string, any>>;
  requestBody?: Record<string, any>;
  parameters?: Array<Record<string, any>>;
  [key: string]: any;
};

const root = process.cwd();
const canonicalText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(root, "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, any> };
};

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
  for (const scheme of [
    "BearerAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementAnthropicApiKeyAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
  ]) {
    assert.ok(securityNames(op).includes(scheme), `${label} accepts ${scheme}`);
  }
  assert.ok(alternatives.some((alternative) => Object.keys(alternative).length === 0));
  assert.match(op.description ?? "", /requireLogin=false/);
  assert.match(op.description ?? "", /not in the explicit public API allowlist/i);
  assert.equal(
    op.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired",
    `${label} documents authentication required`
  );
  assert.equal(
    op.responses?.["403"]?.$ref,
    "#/components/responses/ManagementInvalidToken",
    `${label} documents invalid management credentials`
  );
  assert.ok(op.responses?.["503"], `${label} documents an unavailable-auth/credential response`);
}

test("management compression and analytics routes declare conditional auth", () => {
  const operations: Array<[string, string]> = [
    ["/api/analytics/auto-routing", "get"],
    ["/api/analytics/compression", "get"],
    ["/api/compression/compare", "post"],
    ["/api/compression/compare/verify", "post"],
    ["/api/compression/engines", "get"],
    ["/api/compression/retrieve", "post"],
    ["/api/context/analytics", "get"],
  ];
  for (const [pathname, method] of operations) {
    const op = operation(pathname, method);
    assertConditionalManagement(op, `${method.toUpperCase()} ${pathname}`);
    assert.notEqual(op["x-local-only"], true, `${method.toUpperCase()} ${pathname} is not LOCAL_ONLY`);
  }
});

test("explicit public login, OIDC, and Codex ticket flows use empty security", () => {
  const publicOperations: Array<[string, string]> = [
    ["/api/auth/login", "post"],
    ["/api/auth/logout", "post"],
    ["/api/auth/oidc/login", "get"],
    ["/api/auth/oidc/callback", "get"],
    ["/api/codex/connect/{token}", "get"],
    ["/api/codex/connect/{token}", "post"],
  ];
  for (const [pathname, method] of publicOperations) {
    const op = operation(pathname, method);
    assert.deepEqual(op.security, [], `${method.toUpperCase()} ${pathname} is explicitly public`);
    assert.notEqual(op["x-local-only"], true);
  }

  const login = operation("/api/auth/login", "post");
  assert.ok(login.requestBody?.["x-sensitive"]);
  assert.ok(spec.components.schemas.AuthLoginRequest.properties.password["x-sensitive"]);
  assert.ok(login.responses?.["200"]?.["x-sensitive"]);

  const oidcStart = operation("/api/auth/oidc/login", "get");
  assert.ok(oidcStart.responses?.["302"]?.headers?.["Set-Cookie"]?.["x-sensitive"]);
  const oidcCallback = operation("/api/auth/oidc/callback", "get");
  for (const name of ["code", "state"]) {
    const parameter = oidcCallback.parameters?.find((item) => item.name === name);
    assert.ok(parameter?.["x-sensitive"], `OIDC ${name} is sensitive`);
  }
  assert.ok(oidcCallback.responses?.["302"]?.["x-sensitive"]);
  assert.ok(oidcCallback.responses?.["302"]?.headers?.["Set-Cookie"]?.["x-sensitive"]);

  const codexGet = operation("/api/codex/connect/{token}", "get");
  const ticketParameter = spec.paths["/api/codex/connect/{token}"].parameters?.find(
    (item) => item.name === "token"
  );
  assert.ok(ticketParameter?.["x-sensitive"], "Codex path ticket is a sensitive capability");
  assert.ok(codexGet.responses?.["404"], "expired/reused public device-flow ticket is documented");

  const codexPost = operation("/api/codex/connect/{token}", "post");
  assert.ok(codexPost.requestBody?.["x-sensitive"]);
  assert.equal(
    codexPost.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/OAuthDeviceCompleteRequest"
  );
  for (const name of ["access_token", "refresh_token", "id_token"]) {
    assert.ok(spec.components.schemas.OAuthDeviceCompleteRequest.properties[name]["x-sensitive"]);
  }
  for (const status of ["400", "410", "500"]) {
    assert.ok(codexPost.responses?.[status], `Codex completion documents ${status}`);
  }
});

test("compression prompt and retrieved cache payloads are classified as sensitive", () => {
  const compare = operation("/api/compression/compare", "post");
  assert.ok(compare.requestBody?.["x-sensitive"]);
  const messages = compare.requestBody?.content?.["application/json"]?.schema?.properties?.messages;
  assert.ok(messages?.["x-sensitive"]);
  assert.ok(messages?.items?.properties?.content?.["x-sensitive"]);

  const verify = operation("/api/compression/compare/verify", "post");
  assert.ok(verify.requestBody?.["x-sensitive"]);
  const itemSchema = verify.requestBody?.content?.["application/json"]?.schema?.properties?.items?.items;
  assert.ok(itemSchema?.properties?.original?.["x-sensitive"]);
  assert.ok(itemSchema?.properties?.compressed?.["x-sensitive"]);
  assert.match(verify.description ?? "", /external.*judge|judge.*provider/i);
  assert.match(verify.description ?? "", /\$5.*cap/i);
  assert.ok(verify.responses?.["200"]?.["x-sensitive"]);

  const retrieve = operation("/api/compression/retrieve", "post");
  assert.ok(retrieve.responses?.["200"]?.["x-sensitive"]);
  assert.match(retrieve.description ?? "", /block.*prompt text|prompt text/i);
});

test("Caveman aliases document only their legacy accepted credentials", () => {
  for (const method of ["get", "put"]) {
    const op = operation("/api/context/caveman/config", method);
    assert.deepEqual(
      op.security,
      [{ ManagementApiKeyBearerAuth: [] }, { ManagementSessionAuth: [] }, {}]
    );
    assert.equal(securityNames(op).includes("BearerAuth"), false);
    assert.match(op.description ?? "", /does not accept `oma_live_` Access Tokens/i);
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.match(op.description ?? "", /not in the explicit public API allowlist/i);
    assert.notEqual(op["x-local-only"], true);
    for (const status of ["401", "403", "503"]) {
      assert.ok(op.responses?.[status], `${method.toUpperCase()} Caveman config documents ${status}`);
    }
  }
  assert.ok(operation("/api/context/caveman/config", "put").responses?.["400"]);
  assert.ok(operation("/api/context/caveman/config", "put").responses?.["500"]);
});

test("the public OpenAPI mirror remains byte-identical to the canonical contract", () => {
  assert.equal(publicText, canonicalText);
});
