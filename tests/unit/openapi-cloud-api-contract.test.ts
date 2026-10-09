import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { isPublicApiRoute } from "../../src/shared/constants/publicApiRoutes.ts";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;

const CLOUD_OPERATIONS = [
  ["/api/cloud/auth", "post"],
  ["/api/cloud/credentials/update", "put"],
  ["/api/cloud/model/resolve", "post"],
  ["/api/cloud/models/alias", "get"],
  ["/api/cloud/models/alias", "put"],
] as const;

function operation(route: string, method: string) {
  const result = spec.paths?.[route]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${route}`);
  return result;
}

function sourceCloudOperations() {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (!relativeFile.startsWith("src/app/api/cloud/")) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

test("cloud OpenAPI operations match source methods and the public/management auth split", () => {
  const documented = new Set(CLOUD_OPERATIONS.map(([route, method]) => `${method} ${route}`));
  assert.deepEqual([...documented].sort(), [...sourceCloudOperations()].sort());
  assert.equal(documented.size, 5);

  const publicOperations = [
    ["/api/cloud/auth", "post"],
    ["/api/cloud/model/resolve", "post"],
    ["/api/cloud/models/alias", "get"],
  ] as const;
  for (const [route, method] of publicOperations) {
    const op = operation(route, method);
    assert.equal(classifyRoute(route, method.toUpperCase()).routeClass, "PUBLIC");
    assert.equal(isPublicApiRoute(route, method.toUpperCase()), true);
    assert.ok(
      op.security?.some((requirement: Record<string, unknown>) => "BearerAuth" in requirement)
    );
    if (route === "/api/cloud/models/alias") {
      assert.ok(
        op.security?.some(
          (requirement: Record<string, unknown>) => "CloudAuthorizationApiKeyAuth" in requirement
        ),
        "cloud alias GET also accepts a raw Authorization API key without a Bearer prefix"
      );
    } else {
      assert.deepEqual(op.security, [{ BearerAuth: [] }]);
    }
    assert.match(op.description ?? "", /PUBLIC/i);
    assert.match(op.description ?? "", /valid OmniRoute API key/i);
    assert.match(op.description ?? "", /Bearer/i);
    assert.equal(
      op.security.some(
        (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
      ),
      false,
      `${method.toUpperCase()} ${route} still requires a handler-validated API key`
    );
  }

  const writeOperations = [
    ["/api/cloud/credentials/update", "put"],
    ["/api/cloud/models/alias", "put"],
  ] as const;
  for (const [route, method] of writeOperations) {
    const op = operation(route, method);
    assert.equal(classifyRoute(route, method.toUpperCase()).routeClass, "MANAGEMENT");
    assert.equal(isPublicApiRoute(route, method.toUpperCase()), false);
    for (const scheme of [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
    ]) {
      assert.ok(
        op.security?.some((requirement: Record<string, unknown>) => scheme in requirement),
        `${method.toUpperCase()} ${route} must document ${scheme}`
      );
    }
    assert.equal(
      op.security?.some(
        (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
      ),
      false,
      `${method.toUpperCase()} ${route} is always-authenticated even if requireLogin=false`
    );
    assert.match(op.description ?? "", /regardless of `requireLogin`/);
    for (const status of ["401", "403", "503"]) {
      assert.ok(op.responses?.[status], `${method.toUpperCase()} ${route} must document ${status}`);
    }
  }

  assert.equal(
    spec.components.securitySchemes.InternalServiceTokenAuth.name,
    "x-omniroute-internal-service-token"
  );
  assert.match(spec.components.securitySchemes.InternalServiceTokenAuth.description, /loopback/i);
  assert.equal(spec.components.securitySchemes.CloudAuthorizationApiKeyAuth.name, "Authorization");
});

test("cloud auth and resolution responses expose masked data and exact alias shapes", () => {
  const auth = operation("/api/cloud/auth", "post");
  assert.equal(auth.requestBody, undefined);
  assert.equal(
    auth.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudWorkerAuthResponse"
  );
  assert.equal(
    auth.responses?.["401"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  const authResponse = spec.components.schemas.CloudWorkerAuthResponse;
  assert.deepEqual(authResponse.required, ["connections", "modelAliases"]);
  const connection = spec.components.schemas.CloudWorkerConnectionResponse;
  for (const key of ["hasApiKey", "hasAccessToken", "hasRefreshToken", "maskedApiKey"]) {
    assert.ok(connection.properties[key], `missing cloud-auth connection field ${key}`);
  }
  for (const rawCredential of ["apiKey", "accessToken", "refreshToken", "idToken"]) {
    assert.equal(
      connection.properties[rawCredential],
      undefined,
      `raw ${rawCredential} must not be returned`
    );
  }
  assert.deepEqual(connection.properties.maskedApiKey.type, ["string", "null"]);
  assert.match(connection.description, /never returned/i);
  assert.equal(
    authResponse.properties.modelAliases.$ref,
    "#/components/schemas/CloudWorkerModelAliasMap"
  );

  const resolve = operation("/api/cloud/model/resolve", "post");
  assert.equal(
    resolve.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudWorkerResolveAliasRequest"
  );
  assert.equal(
    resolve.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudWorkerResolveAliasResponse"
  );
  assert.equal(
    resolve.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ValidationErrorResponse"
  );
  assert.equal(
    resolve.responses?.["404"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  const resolveRequest = spec.components.schemas.CloudWorkerResolveAliasRequest;
  assert.deepEqual(resolveRequest.required, ["alias"]);
  assert.equal(resolveRequest.properties.alias.minLength, 1);

  const aliasesGet = operation("/api/cloud/models/alias", "get");
  assert.equal(
    aliasesGet.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudWorkerModelAliasesResponse"
  );
  assert.equal(
    spec.components.schemas.CloudWorkerModelAliasesResponse.properties.aliases.$ref,
    "#/components/schemas/CloudWorkerModelAliasMap"
  );
});

test("cloud writes document secret updates, validation, collision, and result envelopes", () => {
  const credentials = operation("/api/cloud/credentials/update", "put");
  assert.equal(credentials.requestBody?.required, true);
  assert.equal(credentials.requestBody?.["x-sensitive"], true);
  assert.equal(
    credentials.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudWorkerCredentialUpdateRequest"
  );
  assert.equal(
    credentials.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudWorkerCredentialUpdateResponse"
  );
  assert.equal(
    credentials.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ValidationErrorResponse"
  );
  assert.equal(
    credentials.responses?.["404"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  const credentialsRequest = spec.components.schemas.CloudWorkerCredentialUpdateRequest;
  assert.equal(credentialsRequest["x-sensitive"], true);
  assert.deepEqual(credentialsRequest.required, ["provider", "credentials"]);
  const credentialFields = spec.components.schemas.CloudWorkerCredentialUpdateFields;
  assert.equal(credentialFields["x-sensitive"], true);
  assert.equal(credentialFields.properties.accessToken.writeOnly, true);
  assert.equal(credentialFields.properties.refreshToken.writeOnly, true);
  assert.deepEqual(credentialFields.anyOf.map((variant: any) => variant.required[0]).sort(), [
    "accessToken",
    "expiresIn",
    "refreshToken",
  ]);
  assert.match(credentials.description, /never returned|sensitive/i);

  const aliasUpdate = operation("/api/cloud/models/alias", "put");
  assert.equal(
    aliasUpdate.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudWorkerModelAliasUpdateRequest"
  );
  assert.equal(
    aliasUpdate.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CloudWorkerModelAliasUpdateResponse"
  );
  assert.deepEqual(
    aliasUpdate.responses?.["400"]?.content?.["application/json"]?.schema?.oneOf?.map(
      (variant: any) => variant.$ref
    ),
    ["#/components/schemas/ValidationErrorResponse", "#/components/schemas/StringErrorResponse"]
  );
  assert.match(aliasUpdate.description, /sync.*failure.*does not change/i);
});

test("cloud OpenAPI changes are mirrored to the public specification", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});

test("cloud auth returns only dummy masked credentials", async () => {
  const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openapi-cloud-auth-contract-"));
  const environmentKeys = [
    "DATA_DIR",
    "API_KEY_SECRET",
    "STORAGE_ENCRYPTION_KEY",
    "DISABLE_SQLITE_AUTO_BACKUP",
  ] as const;
  const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.DATA_DIR = testDataDir;
  process.env.API_KEY_SECRET = "openapi-cloud-auth-contract-secret";
  process.env.STORAGE_ENCRYPTION_KEY = "openapi-cloud-auth-contract-encryption";
  process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

  const core = await import("../../src/lib/db/core.ts");
  const apiKeys = await import("../../src/lib/db/apiKeys.ts");
  const providers = await import("../../src/lib/db/providers.ts");
  const { POST } = await import("../../src/app/api/cloud/auth/route.ts");

  try {
    const apiKey = await apiKeys.createApiKey("cloud-auth-contract", "test-machine", []);
    await providers.createProviderConnection({
      provider: "openai",
      authType: "api_key",
      apiKey: "dummy-provider-key-1234",
      accessToken: "dummy-access-token-secret",
      refreshToken: "dummy-refresh-token-secret",
      projectId: "dummy-project",
      expiresAt: "2027-01-01T00:00:00.000Z",
      defaultModel: "gpt-dummy",
      isActive: true,
    });
    await providers.createProviderConnection({
      provider: "anthropic",
      authType: "api_key",
      apiKey: "tinykey",
      isActive: true,
    });

    const response = await POST(
      new Request("http://localhost/api/cloud/auth", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey.key}` },
      })
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const openai = body.connections.find((connection: any) => connection.provider === "openai");
    const anthropic = body.connections.find(
      (connection: any) => connection.provider === "anthropic"
    );
    assert.ok(openai);
    assert.ok(anthropic);
    assert.equal(openai.maskedApiKey, "dumm****1234");
    assert.equal(anthropic.maskedApiKey, "****");
    assert.equal(openai.hasAccessToken, true);
    assert.equal(openai.hasRefreshToken, true);
    assert.equal("accessToken" in openai, false);
    assert.equal("refreshToken" in openai, false);
    assert.equal("apiKey" in openai, false);

    const serialized = JSON.stringify(body);
    for (const secret of [
      "dummy-provider-key-1234",
      "dummy-access-token-secret",
      "dummy-refresh-token-secret",
    ]) {
      assert.equal(serialized.includes(secret), false, `cloud auth response leaked ${secret}`);
    }
  } finally {
    core.resetDbInstance();
    apiKeys.resetApiKeyState();
    fs.rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    for (const key of environmentKeys) {
      const value = previousEnvironment.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
