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
  assert.match(
    op.description ?? "",
    /not in the\s+explicit public(?: API)?\s+allowlist|not explicitly public/i
  );
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
  assert.equal(
    op.responses?.["503"]?.$ref,
    "#/components/responses/ManagementAuthUnavailable",
    `${label} documents management-auth unavailability`
  );
}

test("conditional management routes are distinguished from explicitly public APIs", () => {
  const operations: Array<[string, string]> = [
    ["/api/a2a/status", "get"],
    ["/api/agent-skills", "get"],
    ["/api/agent-skills/{id}", "get"],
    ["/api/agent-skills/{id}/raw", "get"],
    ["/api/agent-skills/coverage", "get"],
    ["/api/analytics/diversity", "get"],
    ["/api/assess", "get"],
    ["/api/assess", "post"],
    ["/api/cli/whoami", "get"],
  ];

  for (const [pathname, method] of operations) {
    assertConditionalManagement(operation(pathname, method), `${method.toUpperCase()} ${pathname}`);
  }
});

test("Agent Skills routes do not claim unconditional public access", () => {
  for (const pathname of [
    "/api/agent-skills",
    "/api/agent-skills/{id}",
    "/api/agent-skills/{id}/raw",
    "/api/agent-skills/coverage",
  ]) {
    const description = operation(pathname, "get").description ?? "";
    assert.doesNotMatch(description, /No authentication required/i, pathname);
    assert.match(description, /centrally classified\s+as MANAGEMENT/i, pathname);
  }
});

test("ACP agent routes retain LOCAL_ONLY and document their narrower legacy credentials", () => {
  for (const method of ["get", "post", "delete"]) {
    const op = operation("/api/acp/agents", method);
    assert.equal(op["x-local-only"], true, `${method.toUpperCase()} ACP remains LOCAL_ONLY`);
    const expectedSecurity =
      method === "delete"
        ? [
            { ManagementApiKeyBearerAuth: [] },
            { ManagementGoogleApiKeyAuth: [] },
            { ManagementAnthropicApiKeyAuth: [] },
            { ManagementSessionAuth: [] },
            {},
          ]
        : [{ ManagementApiKeyBearerAuth: [] }, { ManagementSessionAuth: [] }, {}];
    assert.deepEqual(
      op.security,
      expectedSecurity
    );
    assert.doesNotMatch(securityNames(op).join(" "), /(^|\s)BearerAuth($|\s)/);
    assert.match(op.description ?? "", /does not accept `oma_live_` Access Tokens/i);
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.equal(op.responses?.["403"]?.$ref, "#/components/responses/LocalOnlyAccessDenied");
  }
});

test("CLI connect is password-authenticated public bootstrap with a non-cacheable secret response", () => {
  const op = operation("/api/cli/connect", "post");
  assert.deepEqual(op.security, []);
  assert.match(op.description ?? "", /explicitly public route/i);
  assert.match(op.description ?? "", /password-body authentication/i);
  assert.equal(op.requestBody?.["x-sensitive"], true);
  assert.equal(op.requestBody?.content?.["application/json"]?.schema?.required?.[0], "password");
  assert.equal(
    op.requestBody?.content?.["application/json"]?.schema?.properties?.password?.["x-sensitive"],
    true
  );
  assert.equal(op.responses?.["200"]?.["x-sensitive"], true);
  assert.equal(
    op.responses?.["200"]?.headers?.["Cache-Control"]?.schema?.const,
    "no-store"
  );
  assert.equal(
    op.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CliRemoteConnectResponse"
  );
  const responseSchema = (spec as any).components.schemas.CliRemoteConnectResponse;
  assert.equal(responseSchema["x-sensitive"], true);
  assert.ok(responseSchema.required.includes("token"));
  assert.equal(responseSchema.properties.token["x-sensitive"], true);
});

test("public OpenAPI mirror exactly matches the canonical contract", () => {
  assert.equal(publicText, canonicalText);
});
