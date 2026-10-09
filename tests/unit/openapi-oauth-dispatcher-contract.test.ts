import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  anyOf?: Schema[];
  oneOf?: Schema[];
  writeOnly?: boolean;
};

type Response = {
  content?: Record<string, { schema?: Schema }>;
};

type Operation = {
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    schema?: Schema;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<string, Response>;
};

type PathItem = {
  get?: Operation;
  post?: Operation;
  parameters?: Operation["parameters"];
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, Schema> };
};

function operation(method: "get" | "post"): Operation {
  const result = spec.paths["/api/oauth/{provider}/{action}"]?.[method];
  assert.ok(result, `missing OAuth dispatcher ${method.toUpperCase()} operation`);
  return result;
}

function responseSchema(op: Operation, status: string): Schema {
  const schema = op.responses?.[status]?.content?.["application/json"]?.schema;
  assert.ok(schema, `missing JSON response schema for ${status}`);
  return schema;
}

function assertConditionalAuth(op: Operation): void {
  const security = op.security ?? [];
  assert.ok(security.some((entry) => Object.hasOwn(entry, "BearerAuth")));
  assert.ok(security.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
  assert.ok(security.some((entry) => Object.keys(entry).length === 0));
}

test("generic OAuth route lists the real method-specific actions and auth modes", () => {
  const get = operation("get");
  const post = operation("post");
  const pathAction = spec.paths["/api/oauth/{provider}/{action}"]?.parameters?.find(
    (parameter) => parameter.name === "action"
  );
  assert.deepEqual(pathAction?.schema?.enum, [
    "authorize",
    "device-code",
    "start-callback-server",
    "public-link-status",
    "exchange",
    "poll",
    "cancel",
    "poll-callback",
    "import-token",
    "public-link",
    "device-complete",
  ]);
  assertConditionalAuth(get);
  assertConditionalAuth(post);
  assert.deepEqual(get.parameters?.find((parameter) => parameter.name === "action")?.schema?.enum, [
    "authorize",
    "device-code",
    "start-callback-server",
    "public-link-status",
  ]);
  assert.deepEqual(
    post.parameters?.find((parameter) => parameter.name === "action")?.schema?.enum,
    [
      "exchange",
      "poll",
      "cancel",
      "poll-callback",
      "import-token",
      "public-link",
      "device-complete",
    ]
  );

  assert.ok(get.parameters?.some((parameter) => parameter.name === "token"));
  assert.equal(get.responses?.["302"], undefined);
  assert.ok(get.responses?.["410"]);
  assert.ok(post.responses?.["410"]);
  assert.match(post.description ?? "", /poll-callback/i);
  assert.match(post.description ?? "", /absent or invalid body/i);
});

test("GET OAuth result variants and provider-dependent query parameters are documented", () => {
  const get = operation("get");
  const variants = responseSchema(get, "200").anyOf?.map((schema) => schema.$ref);
  assert.deepEqual(variants, [
    "#/components/schemas/OAuthAuthorizeResponse",
    "#/components/schemas/OAuthDeviceCodeResponse",
    "#/components/schemas/OAuthCallbackServerResponse",
    "#/components/schemas/OAuthPublicLinkStatusResponse",
  ]);
  assert.ok(get.parameters?.some((parameter) => parameter.name === "gheUrl"));
  assert.ok(get.parameters?.some((parameter) => parameter.name === "region"));
  assert.ok(get.responses?.["403"]);
  assert.ok(get.responses?.["429"]);
  assert.ok(get.responses?.["502"]);
  assert.ok(get.responses?.["503"]);
});

test("POST OAuth actions document their body unions, safe result shapes, and errors", () => {
  const post = operation("post");
  const requestVariants = post.requestBody?.content?.["application/json"]?.schema?.anyOf?.map(
    (schema) => schema.$ref
  );
  assert.deepEqual(requestVariants, [
    "#/components/schemas/OAuthExchangeRequest",
    "#/components/schemas/OAuthPollRequest",
    "#/components/schemas/OAuthPollCallbackRequest",
    "#/components/schemas/OAuthImportTokenRequest",
    "#/components/schemas/OAuthDeviceCompleteRequest",
    "#/components/schemas/OAuthPublicLinkRequest",
  ]);
  assert.equal(post.requestBody?.required, false);
  const responseVariants = responseSchema(post, "200").anyOf?.map((schema) => schema.$ref);
  assert.deepEqual(responseVariants, [
    "#/components/schemas/OAuthConnectionSuccessResponse",
    "#/components/schemas/OAuthPollResultResponse",
    "#/components/schemas/OAuthPublicLinkResponse",
  ]);
  assert.ok(post.responses?.["400"]);
  assert.ok(post.responses?.["401"]);
  assert.ok(post.responses?.["403"]);
  assert.ok(post.responses?.["500"]);
  assert.ok(post.responses?.["502"]);
  assert.ok(post.responses?.["503"]);
});

test("OAuth request schemas match Zod constraints and responses omit OAuth credentials", () => {
  const schemas = spec.components.schemas;
  assert.deepEqual(schemas.OAuthExchangeRequest.required, ["code", "redirectUri"]);
  assert.deepEqual(schemas.OAuthPollRequest.required, ["deviceCode"]);
  assert.deepEqual(schemas.OAuthImportTokenRequest.required, ["token"]);
  assert.deepEqual(schemas.OAuthDeviceCompleteRequest.required, ["access_token"]);
  assert.equal(schemas.OAuthDeviceCompleteRequest.properties?.access_token?.writeOnly, true);
  assert.deepEqual(schemas.OAuthConnectionSummary.required, ["id", "provider"]);
  assert.equal(schemas.OAuthConnectionSummary.properties?.accessToken, undefined);
  assert.equal(schemas.OAuthConnectionSummary.properties?.refreshToken, undefined);
});
