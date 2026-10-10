import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { isAlwaysProtectedPath } from "../../src/server/authz/routeGuard.ts";
import {
  cloudflareDeploySchema,
  denoDeploySchema,
  vercelDeploySchema,
} from "../../src/shared/validation/freeProxySchemas.ts";

const ROOT = process.cwd();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-settings-gap-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const coreDb = await import("../../src/lib/db/core.ts");
const faviconRoute = await import("../../src/app/api/settings/favicon/route.ts");
const modelsDevRoute = await import("../../src/app/api/settings/models-dev/route.ts");

function operation(pathname: string, method: string) {
  const result = spec.paths?.[pathname]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathname}`);
  return result;
}

function source(relativePath: string) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function assertSecurityAlternatives(
  op: any,
  schemes: string[],
  { anonymous = true }: { anonymous?: boolean } = {}
) {
  for (const scheme of schemes) {
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.hasOwn(entry, scheme)),
      `${op.operationId} must document ${scheme}`
    );
  }
  assert.equal(
    op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
    anonymous,
    `${op.operationId} anonymous alternative must match its local-open policy`
  );
}

function assertRequestSchemaMatchesZod(operationBody: any, component: any, schema: any) {
  const zodKeys = Object.keys(schema.shape).sort();
  const openApiKeys = Object.keys(component.properties).sort();
  assert.deepEqual(openApiKeys, zodKeys);
  const required = Object.keys(schema.shape).filter(
    (key) => !schema.shape[key].isOptional() && !schema.shape[key]._def?.defaultValue
  );
  assert.deepEqual([...component.required].sort(), required.sort());
  assert.equal(operationBody.required, true);
  assert.equal(operationBody["x-sensitive"], true);
}

test.beforeEach(async () => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

test("favicon contract covers image bytes, 307 fallback, and central management auth", async () => {
  const pathname = "/api/settings/favicon";
  const op = operation(pathname, "get");
  const handler = source("src/app/api/settings/favicon/route.ts");
  assert.equal(classifyRoute(pathname, "GET").routeClass, "MANAGEMENT");
  assert.equal(isAlwaysProtectedPath(pathname), false);
  assertSecurityAlternatives(op, [
    "BearerAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementAnthropicApiKeyAuth",
  ]);
  assert.match(op.description, /requireLogin=false/);
  assert.match(op.description, /bootstrap is loopback-only/i);
  assert.match(handler, /NextResponse\.redirect\(new URL\("\/favicon\.svg", request\.url\)\)/);

  const allowlist = handler.match(/const ALLOWED_IMAGE_TYPES = \[([\s\S]*?)\];/);
  assert.ok(allowlist, "handler must declare ALLOWED_IMAGE_TYPES");
  const allowedTypes = [...allowlist[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(
    Object.keys(op.responses["200"].content).sort(),
    [...new Set(allowedTypes)].sort(),
    "binary success media types must match the handler allowlist"
  );
  for (const media of Object.values(op.responses["200"].content) as any[]) {
    assert.equal(media.schema.type, "string");
    assert.equal(media.schema.format, "binary");
  }
  assert.equal(op.responses["200"].headers["Cache-Control"].schema.const, "public, max-age=300");
  assert.equal(op.responses["307"].headers.Location.required, true);
  assert.equal(op.responses["307"].headers.Location.schema.type, "string");
  assert.equal(op.responses["307"].headers.Location.schema.format, "uri");

  const faviconRequest = new Request("https://omni.example/api/settings/favicon");
  const fallback = await faviconRoute.GET(faviconRequest);
  assert.equal(fallback.status, 307);
  assert.equal(fallback.headers.get("location"), "https://omni.example/favicon.svg");

  const db = coreDb.getDbInstance();
  db.prepare("INSERT INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)").run(
    "customFaviconBase64",
    JSON.stringify("data:image/png;base64,AA==")
  );
  const image = await faviconRoute.GET(faviconRequest);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "public, max-age=300");
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), new Uint8Array([0]));
});

test("models.dev status and action contracts match source types and legacy auth gate", async () => {
  const pathname = "/api/settings/models-dev";
  const get = operation(pathname, "get");
  const post = operation(pathname, "post");
  const handler = source("src/app/api/settings/models-dev/route.ts");
  assert.equal(classifyRoute(pathname, "GET").routeClass, "MANAGEMENT");
  assert.equal(classifyRoute(pathname, "POST").routeClass, "MANAGEMENT");
  assert.match(handler, /isAuthenticated\(request\)/);
  for (const op of [get, post]) {
    assertSecurityAlternatives(op, [
      "ManagementApiKeyBearerAuth",
      "ManagementSessionAuth",
      "ManagementGoogleApiKeyAuth",
      "ManagementAnthropicApiKeyAuth",
    ]);
    assert.match(op.description, /legacy `isAuthenticated\(\)`/);
    assert.match(op.description, /requireLogin=false/);
  }
  assert.equal(get.parameters[0].name, "action");
  assert.equal(get.parameters[0].required, true);
  assert.equal(get.parameters[0].schema.const, "status");
  assert.equal(
    get.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/ModelsDevSyncStatusResponse"
  );
  coreDb
    .getDbInstance()
    .prepare(
      "INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', 'requireLogin', 'false')"
    )
    .run();
  const statusSchema = spec.components.schemas.ModelsDevSyncStatusResponse;
  const statusResponse = await modelsDevRoute.GET(
    new Request("http://localhost/api/settings/models-dev?action=status") as never
  );
  assert.equal(statusResponse.status, 200);
  const statusBody = await statusResponse.json();
  assert.deepEqual(Object.keys(statusBody).sort(), [...statusSchema.required].sort());

  assert.equal(
    post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/ModelsDevSyncActionRequest"
  );
  assert.deepEqual(spec.components.schemas.ModelsDevSyncActionRequest.properties.action.enum, [
    "sync",
    "start",
    "stop",
  ]);
  assert.equal(post.responses["200"].content["application/json"].schema.oneOf.length, 2);
  assert.equal(post.responses["400"].content["application/json"].schema.oneOf.length, 2);

  const unknown = await modelsDevRoute.GET(
    new Request("http://localhost/api/settings/models-dev?action=unknown") as never
  );
  assert.equal(unknown.status, 400);
  const unknownBody = await unknown.json();
  assert.equal(typeof unknownBody.error, "string");
});

test("relay-deploy contracts match validation schemas, management guards, and redacted results", () => {
  const routes = [
    {
      path: "/api/settings/proxy/cloudflare-deploy",
      file: "src/app/api/settings/proxy/cloudflare-deploy/route.ts",
      schemaName: "CloudflareRelayDeployRequest",
      sourceSchemaName: "cloudflareDeploySchema",
      zodSchema: cloudflareDeploySchema,
    },
    {
      path: "/api/settings/proxy/deno-deploy",
      file: "src/app/api/settings/proxy/deno-deploy/route.ts",
      schemaName: "DenoRelayDeployRequest",
      sourceSchemaName: "denoDeploySchema",
      zodSchema: denoDeploySchema,
    },
    {
      path: "/api/settings/proxy/vercel-deploy",
      file: "src/app/api/settings/proxy/vercel-deploy/route.ts",
      schemaName: "VercelRelayDeployRequest",
      sourceSchemaName: "vercelDeploySchema",
      zodSchema: vercelDeploySchema,
    },
  ];
  const successSchema = spec.components.schemas.ProxyRelayDeployResponse;
  assert.deepEqual(successSchema.required, ["success", "relayUrl"]);
  assert.deepEqual(Object.keys(successSchema.properties).sort(), [
    "poolProxyId",
    "relayUrl",
    "ssoProtectionWarning",
    "success",
  ]);
  assert.equal(successSchema.properties.success.const, true);
  assert.equal(successSchema.properties.relayUrl.format, "uri");
  for (const secretName of ["token", "apiToken", "denoToken", "relayAuth"]) {
    assert.equal(
      successSchema.properties[secretName],
      undefined,
      `${secretName} must not be returned`
    );
  }

  for (const route of routes) {
    const op = operation(route.path, "post");
    const handler = source(route.file);
    assert.equal(classifyRoute(route.path, "POST").routeClass, "MANAGEMENT");
    assert.equal(isAlwaysProtectedPath(route.path), false);
    assertSecurityAlternatives(op, [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
      "ManagementGoogleApiKeyAuth",
      "ManagementAnthropicApiKeyAuth",
    ]);
    assert.match(op.description, /requireLogin=false/);
    assert.match(handler, /requireManagementAuth\(request\)/);
    assert.match(handler, new RegExp(`validateBody\\(${route.sourceSchemaName}`));
    assertRequestSchemaMatchesZod(
      op.requestBody,
      spec.components.schemas[route.schemaName],
      route.zodSchema
    );
    assert.equal(
      op.responses["200"].content["application/json"].schema.$ref,
      "#/components/schemas/ProxyRelayDeployResponse"
    );
    assert.ok(
      op.responses["400"] && op.responses["401"] && op.responses["403"] && op.responses["503"]
    );
    assert.equal(
      op.responses["403"].$ref,
      "#/components/responses/ManagementOrRuntimePolicyForbidden"
    );
    assert.ok(handler.includes("poolProxyId: poolProxy?.id"));
  }
  const denoRequest = spec.components.schemas.DenoRelayDeployRequest;
  assert.equal(denoRequest.properties.orgDomain.pattern, "^[A-Za-z0-9.-]+$");
  assert.equal(
    denoDeploySchema.safeParse({
      denoToken: "a".repeat(20),
      orgDomain: "Org.Example",
    }).success,
    true,
    "documented Deno organization domain pattern must retain case-insensitive source behavior"
  );
  assert.match(source(routes[2].file), /ssoProtectionWarning/);
});

test("six targeted settings operations are mirrored in the public OpenAPI artifact", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
