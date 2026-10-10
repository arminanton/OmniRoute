import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const SPEC_PATH = path.join(ROOT, "docs/openapi.yaml");
const spec = yaml.load(fs.readFileSync(SPEC_PATH, "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

function routeSource(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function assertSecurityAlternatives(
  operation: Record<string, any>,
  schemes: string[],
  { anonymous = true }: { anonymous?: boolean } = {}
): void {
  for (const scheme of schemes) {
    assert.ok(
      operation.security?.some((entry: Record<string, unknown>) => Object.hasOwn(entry, scheme)),
      `${operation.operationId} must declare ${scheme}`
    );
  }
  assert.equal(
    operation.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
    anonymous,
    `${operation.operationId} anonymous alternative must match the local-open policy`
  );
}

function componentSchema(name: string): any {
  const schema = spec.components.schemas[name];
  assert.ok(schema, `${name} must be defined in components.schemas`);
  return schema;
}

function resolveSchema(schema: any): any {
  if (typeof schema?.$ref !== "string") return schema;
  const prefix = "#/components/schemas/";
  assert.ok(schema.$ref.startsWith(prefix), `expected local schema ref, got ${schema.$ref}`);
  return componentSchema(schema.$ref.slice(prefix.length));
}

function assertRequiredKeys(schema: any, expected: string[], label: string): void {
  assert.deepEqual(
    [...(schema.required ?? [])].sort(),
    [...expected].sort(),
    `${label} required keys`
  );
}

function responseSchemaRef(pathname: string, method: "get" | "post"): string | undefined {
  return spec.paths[pathname]?.[method]?.responses?.["200"]?.content?.["application/json"]?.schema
    ?.$ref;
}

function operationResponseText(pathname: string, method: "get" | "post"): string {
  const operation = spec.paths[pathname]?.[method];
  const schemaRef = responseSchemaRef(pathname, method);
  const component = schemaRef?.split("/").pop();
  return JSON.stringify({
    operationDescription: operation?.description,
    response: operation?.responses?.["200"],
    schema: component ? spec.components.schemas[component] : undefined,
  });
}

const successContracts: Array<{
  path: string;
  method: "get" | "post";
  component: string;
}> = [
  {
    path: "/api/providers/{id}/chatgpt-web-codex-doctor",
    method: "get",
    component: "ChatGptWebCodexDoctorResponse",
  },
  {
    path: "/api/providers/bulk",
    method: "post",
    component: "ProviderBulkConnectionResponse",
  },
  {
    path: "/api/providers/bulk-web-session",
    method: "post",
    component: "ProviderBulkConnectionResponse",
  },
  {
    path: "/api/providers/claude-auth/import",
    method: "post",
    component: "ProviderAuthImportResponse",
  },
  {
    path: "/api/providers/claude-auth/import-bulk",
    method: "post",
    component: "ProviderBulkConnectionResponse",
  },
  {
    path: "/api/providers/claude-auth/zip-extract",
    method: "post",
    component: "ProviderAuthZipExtractResponse",
  },
  {
    path: "/api/providers/command-code/auth/apply",
    method: "post",
    component: "CommandCodeAuthApplyResponse",
  },
  {
    path: "/api/providers/command-code/auth/start",
    method: "post",
    component: "CommandCodeAuthStartResponse",
  },
  {
    path: "/api/providers/command-code/auth/status",
    method: "get",
    component: "CommandCodeAuthStatusResponse",
  },
  {
    path: "/api/providers/command-code/auth/status",
    method: "post",
    component: "CommandCodeAuthStatusResponse",
  },
  {
    path: "/api/providers/free-onboarding",
    method: "get",
    component: "FreeProviderOnboardingListResponse",
  },
  {
    path: "/api/providers/free-onboarding",
    method: "post",
    component: "FreeProviderOnboardingSetupResponse",
  },
  {
    path: "/api/providers/import",
    method: "post",
    component: "ProviderImportBulkResponse",
  },
  {
    path: "/api/providers/openrouter-stats",
    method: "get",
    component: "OpenRouterProviderStatsResponse",
  },
];

test("provider management operations expose their source-backed typed 200 response components", () => {
  for (const contract of successContracts) {
    const operation = spec.paths[contract.path]?.[contract.method];
    assert.ok(operation, `${contract.method.toUpperCase()} ${contract.path} must be documented`);

    const response = operation.responses?.["200"];
    assert.ok(response, `${contract.method.toUpperCase()} ${contract.path} must document 200`);
    assert.ok(
      response.content?.["application/json"],
      `${contract.method.toUpperCase()} ${contract.path} must declare JSON response content`
    );
    assert.equal(
      responseSchemaRef(contract.path, contract.method),
      `#/components/schemas/${contract.component}`,
      `${contract.method.toUpperCase()} ${contract.path} must use ${contract.component}`
    );
    if (
      contract.component === "ProviderBulkConnectionResponse" ||
      contract.component === "ProviderImportBulkResponse"
    ) {
      assert.equal(
        spec.components.schemas[contract.component].properties.total.minimum,
        1,
        `${contract.component} total reflects source request schemas with non-empty entries`
      );
    }
    assert.ok(
      spec.components.schemas[contract.component],
      `${contract.component} must be defined in components.schemas`
    );
  }
});

test("provider management routes retain their source auth guards", () => {
  const managementGuardedRoutes = [
    "src/app/api/providers/[id]/chatgpt-web-codex-doctor/route.ts",
    "src/app/api/providers/bulk/route.ts",
    "src/app/api/providers/bulk-web-session/route.ts",
    "src/app/api/providers/claude-auth/import/route.ts",
    "src/app/api/providers/claude-auth/import-bulk/route.ts",
    "src/app/api/providers/claude-auth/zip-extract/route.ts",
    "src/app/api/providers/command-code/auth/apply/route.ts",
    "src/app/api/providers/command-code/auth/start/route.ts",
    "src/app/api/providers/command-code/auth/status/route.ts",
    "src/app/api/providers/free-onboarding/route.ts",
    "src/app/api/providers/import/route.ts",
  ];

  for (const relativePath of managementGuardedRoutes) {
    assert.match(
      routeSource(relativePath),
      /requireManagementAuth\(request\)/,
      `${relativePath} must keep its management-auth guard`
    );
  }

  for (const contract of successContracts.filter(
    (candidate) => candidate.path !== "/api/providers/openrouter-stats"
  )) {
    const operation = spec.paths[contract.path]?.[contract.method];
    assertSecurityAlternatives(operation, [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
      "ManagementGoogleApiKeyAuth",
      "ManagementAnthropicApiKeyAuth",
    ]);
    assert.match(
      operation.description,
      /requireManagementAuth|management bearer/i,
      `${contract.method.toUpperCase()} ${contract.path} must explain its management guard`
    );
  }

  const doctorOperation = spec.paths["/api/providers/{id}/chatgpt-web-codex-doctor"].get;
  assert.equal(doctorOperation["x-local-only"], true);
  assert.ok(
    routeSource("src/server/authz/routeGuard.ts").includes(
      "/^\\/api\\/providers\\/[^/]+\\/chatgpt-web-codex-doctor\\/?$/"
    ),
    "doctor endpoint must remain in the central loopback-only route list"
  );

  const openRouterOperation = spec.paths["/api/providers/openrouter-stats"].get;
  const openRouterSource = routeSource("src/app/api/providers/openrouter-stats/route.ts");
  assert.match(
    openRouterSource,
    /isAuthenticated\(req\)/,
    "OpenRouter stats must keep its auth guard"
  );
  assertSecurityAlternatives(openRouterOperation, [
    "ManagementApiKeyBearerAuth",
    "ManagementSessionAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementAnthropicApiKeyAuth",
  ]);
  assert.equal(
    openRouterOperation.security.some(
      (entry: Record<string, unknown>) =>
        Object.hasOwn(entry, "LocalCliTokenAuth") ||
        Object.hasOwn(entry, "InternalServiceTokenAuth")
    ),
    false,
    "legacy isAuthenticated() does not accept loopback CLI or internal-service credentials"
  );
});

test("credential-bearing provider responses document and enforce their redaction boundaries", () => {
  const credentialFields = ["apiKey", "accessToken", "refreshToken", "idToken"];
  const sanitizedRouteSources = [
    "src/app/api/providers/claude-auth/import/route.ts",
    "src/app/api/providers/claude-auth/import-bulk/route.ts",
  ];

  for (const relativePath of sanitizedRouteSources) {
    const source = routeSource(relativePath);
    for (const field of credentialFields) {
      assert.match(
        source,
        new RegExp(`delete safe\\.${field}\\b`),
        `${relativePath} must remove ${field} before returning a connection`
      );
    }
    assert.match(source, /sanitizeProviderSpecificDataForResponse\(/);
  }

  for (const relativePath of [
    "src/app/api/providers/bulk/route.ts",
    "src/app/api/providers/bulk-web-session/route.ts",
    "src/app/api/providers/import/route.ts",
  ]) {
    const source = routeSource(relativePath);
    assert.match(source, /delete safe\.apiKey\b/);
    assert.match(source, /sanitizeProviderSpecificDataForResponse\(/);
  }

  for (const contract of [
    {
      path: "/api/providers/claude-auth/import",
      method: "post",
    },
    {
      path: "/api/providers/claude-auth/import-bulk",
      method: "post",
    },
    {
      path: "/api/providers/bulk",
      method: "post",
    },
    {
      path: "/api/providers/bulk-web-session",
      method: "post",
    },
    {
      path: "/api/providers/import",
      method: "post",
    },
    {
      path: "/api/providers/command-code/auth/apply",
      method: "post",
    },
  ] as const) {
    assert.match(
      operationResponseText(contract.path, contract.method),
      /sanitiz|omit|remov/i,
      `${contract.method.toUpperCase()} ${contract.path} must document credential redaction`
    );
  }

  const zipRoute = routeSource("src/app/api/providers/claude-auth/zip-extract/route.ts");
  assert.match(zipRoute, /json:\s*JSON\.parse\(f\.content\)/);
  assert.match(
    operationResponseText("/api/providers/claude-auth/zip-extract", "post"),
    /credential|token|sensitive/i,
    "ZIP response docs must warn that parsed auth JSON can contain credential material"
  );
  const zipSchema = spec.components.schemas.ProviderAuthZipExtractResponse;
  assert.equal(zipSchema["x-sensitive"], true);
  assert.match(zipSchema.properties.entries.items.properties.json.description, /raw credentials/i);
  assert.deepEqual(zipSchema.properties.entries.items.properties.parseError.enum, [
    "Not valid JSON",
    null,
  ]);

  const safeConnection = spec.components.schemas.ProviderConnectionCredentialRedacted;
  const rootForbidden = safeConnection.not.anyOf.flatMap(
    (condition: { required?: string[] }) => condition.required || []
  );
  for (const field of ["apiKey", "accessToken", "refreshToken", "idToken"]) {
    assert.ok(rootForbidden.includes(field), `safe connection schema must forbid root ${field}`);
    assert.equal(
      safeConnection.properties[field],
      undefined,
      `${field} must not be a response field`
    );
  }
  const providerDataSchema = safeConnection.properties.providerSpecificData.oneOf[0];
  const nestedForbidden = providerDataSchema.not.anyOf.flatMap(
    (condition: { required?: string[] }) => condition.required || []
  );
  const sanitizerSource = routeSource("src/lib/providers/requestDefaults.ts");
  const sanitizedFields = [...sanitizerSource.matchAll(/delete sanitized\.([A-Za-z0-9_]+);/g)].map(
    (match) => match[1]
  );
  for (const field of sanitizedFields) {
    assert.ok(
      nestedForbidden.includes(field),
      `safe providerSpecificData schema must forbid sanitized ${field}`
    );
  }
});

test("Command Code start/status/apply success responses preserve no-store behavior", () => {
  for (const relativePath of [
    "src/app/api/providers/command-code/auth/start/route.ts",
    "src/app/api/providers/command-code/auth/status/route.ts",
    "src/app/api/providers/command-code/auth/apply/route.ts",
  ]) {
    assert.match(routeSource(relativePath), /noStoreJson\(/);
  }

  const noStoreOperations = [
    { path: "/api/providers/command-code/auth/start", method: "post" },
    { path: "/api/providers/command-code/auth/status", method: "get" },
    { path: "/api/providers/command-code/auth/status", method: "post" },
    { path: "/api/providers/command-code/auth/apply", method: "post" },
  ] as const;
  for (const { path: pathname, method } of noStoreOperations) {
    const operation = spec.paths[pathname]?.[method];
    assert.equal(
      operation?.responses?.["200"]?.headers?.["Cache-Control"]?.schema?.const,
      "no-store",
      `${method.toUpperCase()} ${pathname} must document its no-store success response`
    );
  }

  assert.match(
    routeSource("src/app/api/providers/command-code/auth/shared.ts"),
    /"Cache-Control":\s*"no-store"/
  );

  assert.match(
    routeSource("src/app/api/providers/command-code/auth/shared.ts"),
    /randomBytes\(32\)\.toString\("base64url"\)/
  );
  const startState = spec.components.schemas.CommandCodeAuthStartResponse.properties.state;
  assert.equal(startState.minLength, 43);
  assert.equal(startState.maxLength, 43);
  assert.equal(startState.pattern, "^[A-Za-z0-9_-]{43}$");

  const applySource = routeSource("src/app/api/providers/command-code/auth/apply/route.ts");
  for (const field of ["apiKey", "accessToken", "refreshToken", "idToken"]) {
    assert.match(applySource, new RegExp(`delete result\\.${field}\\b`));
  }
});

test("provider response components have the source-required keys and credential-safe projections", () => {
  const requiredByComponent: Record<string, string[]> = {
    ChatGptWebCodexDoctorResponse: ["status"],
    ProviderBulkConnectionResponse: ["success", "failed", "total", "created", "errors"],
    ProviderAuthImportResponse: ["connection", "created"],
    ProviderAuthZipExtractResponse: ["entries"],
    CommandCodeAuthApplyResponse: ["connection", "status"],
    CommandCodeAuthStartResponse: ["state", "authUrl", "callbackUrl", "expiresAt", "mode"],
    CommandCodeAuthStatusResponse: ["status", "metadata", "expiresAt", "receivedAt", "appliedAt"],
    FreeProviderOnboardingListResponse: ["providers"],
    FreeProviderOnboardingSetupResponse: ["results"],
    ProviderImportBulkResponse: ["success", "failed", "total", "created", "errors"],
    OpenRouterProviderStatsResponse: ["object", "data", "meta"],
  };
  for (const [name, required] of Object.entries(requiredByComponent)) {
    assertRequiredKeys(componentSchema(name), required, name);
  }

  const doctor = componentSchema("ChatGptWebCodexDoctorResponse").properties.status;
  assertRequiredKeys(
    doctor,
    [
      "browser",
      "storageState",
      "login",
      "temporaryChats",
      "tunnelBinary",
      "tunnel",
      "connector",
      "toolRoundtrip",
      "runtime",
      "lease",
      "solAvailable",
      "proAvailable",
      "recovery",
      "lastError",
    ],
    "Codex doctor status"
  );
  assert.deepEqual(doctor.properties.browser.properties.mode.enum, [
    "internal-cdp",
    "local-chromium",
    "unavailable",
  ]);
  assert.deepEqual(doctor.properties.lastError.type, ["string", "null"]);

  const redactedConnection = componentSchema("ProviderConnectionCredentialRedacted");
  assertRequiredKeys(redactedConnection, ["id", "provider"], "redacted connection");
  for (const field of ["apiKey", "accessToken", "refreshToken", "idToken", "sessionToken"]) {
    assert.equal(
      redactedConnection.properties?.[field],
      undefined,
      `${field} is never a response field`
    );
    assert.ok(
      redactedConnection.not?.anyOf?.some((condition: any) => condition.required?.includes(field)),
      `redacted connection must forbid ${field}`
    );
  }

  const bulk = componentSchema("ProviderBulkConnectionResponse");
  for (const count of ["success", "failed", "total"]) {
    assert.equal(bulk.properties?.[count]?.type, "integer", `${count} is a count`);
  }
  assert.equal(
    bulk.properties?.total?.minimum,
    1,
    "all bulk request schemas require at least one entry, so response total is nonzero"
  );
  assert.equal(
    bulk.properties?.created?.items?.$ref,
    "#/components/schemas/ProviderConnectionCredentialRedacted"
  );
  assert.equal(
    bulk.properties?.errors?.items?.$ref,
    "#/components/schemas/ProviderBulkConnectionError"
  );
  const bulkError = componentSchema("ProviderBulkConnectionError");
  assertRequiredKeys(bulkError, ["index", "name", "message"], "bulk error row");
  assert.equal(bulkError.properties?.index?.type, "integer");
  assert.equal(bulkError.properties?.name?.type, "string");
  assert.equal(bulkError.properties?.message?.type, "string");
  assert.ok(
    bulkError.properties?.provider,
    "mixed-provider import may include provider on an error row"
  );
  assert.ok(!bulkError.required?.includes("provider"), "single-provider bulk errors omit provider");

  const authImport = componentSchema("ProviderAuthImportResponse");
  assert.equal(
    authImport.properties?.connection?.$ref,
    "#/components/schemas/ProviderConnectionCredentialRedacted"
  );
  assert.equal(authImport.properties?.created?.type, "boolean");

  const mixedImport = componentSchema("ProviderImportBulkResponse");
  assert.equal(
    mixedImport.properties?.created?.items?.$ref,
    "#/components/schemas/ProviderConnectionCredentialRedacted"
  );
  assert.equal(mixedImport.properties?.total?.minimum, 1);
  assertRequiredKeys(
    mixedImport.properties?.errors?.items,
    ["index", "name", "provider", "message"],
    "mixed-provider import error row"
  );
});

test("ZIP extraction returns arbitrary parsed JSON and a nullable parseError", () => {
  const zip = componentSchema("ProviderAuthZipExtractResponse");
  const entry = resolveSchema(zip.properties?.entries?.items);
  assertRequiredKeys(entry, ["name", "json", "parseError"], "ZIP entry");
  assert.equal(entry.properties?.json?.type, undefined, "JSON.parse may return any JSON value");
  assert.equal(entry.properties?.json?.$ref, undefined);
  assert.ok(entry.properties?.json?.description);
  assert.deepEqual(entry.properties?.parseError?.type, ["string", "null"]);
  assert.deepEqual(entry.properties?.parseError?.enum, ["Not valid JSON", null]);
});

test("Command Code response status unions and nullable fields match the auth lifecycle", () => {
  const status = componentSchema("CommandCodeAuthStatusResponse");
  assert.deepEqual(status.properties?.status?.enum, ["pending", "received", "applied", "expired"]);
  assert.ok(
    status.properties?.metadata?.oneOf?.some((variant: any) => variant.type === "null"),
    "metadata is null until the callback is received"
  );
  for (const field of ["receivedAt", "appliedAt"]) {
    assert.ok(
      status.properties?.[field]?.type?.includes("null"),
      `${field} is nullable before transition`
    );
  }
  assert.equal(status.properties?.stateHash, undefined);
  assert.equal(status.properties?.apiKey, undefined);

  const start = componentSchema("CommandCodeAuthStartResponse");
  assert.equal(start.properties?.mode?.const, "manual");
  assert.equal(start.properties?.state?.["x-sensitive"], true);
  assert.equal(
    componentSchema("CommandCodeAuthApplyResponse").properties?.status?.const,
    "applied"
  );
});

test("free onboarding setup results distinguish all source outcomes", () => {
  const provider = componentSchema("FreeProviderOnboardingProvider");
  assertRequiredKeys(provider, ["id", "name", "website", "caution"], "free provider option");
  assert.equal(provider.properties?.defaultModel?.type, "string");
  assert.ok(!provider.required?.includes("defaultModel"));

  const response = componentSchema("FreeProviderOnboardingSetupResponse");
  const result = resolveSchema(response.properties?.results?.items);
  assert.equal(result.oneOf?.length, 3);
  const variants = new Map<string, any>(
    result.oneOf.map((variant: any): [string, any] => [
      String(variant.properties?.status?.const),
      variant,
    ])
  );
  assert.deepEqual([...variants.keys()].sort(), ["created", "failed", "skipped"]);
  assertRequiredKeys(
    variants.get("created"),
    ["providerId", "status", "connectionId"],
    "created result"
  );
  assertRequiredKeys(variants.get("skipped"), ["providerId", "status", "reason"], "skipped result");
  assertRequiredKeys(variants.get("failed"), ["providerId", "status", "reason"], "failed result");
  assert.equal(variants.get("skipped").properties.reason.const, "already-configured");
  assert.equal(variants.get("failed").properties.reason.const, "Failed to create provider");
});

test("OpenRouter stats meta covers refresh and cached data variants", () => {
  const response = componentSchema("OpenRouterProviderStatsResponse");
  assert.equal(response.properties?.object?.const, "list");
  const entry = resolveSchema(response.properties?.data?.items);
  assertRequiredKeys(
    entry,
    ["slug", "displayName", "modelCount", "totalTokens", "totalRequests", "popularityRank"],
    "OpenRouter popularity row"
  );
  const meta = resolveSchema(response.properties?.meta);
  assertRequiredKeys(meta, ["source", "count"], "OpenRouter stats meta");
  assert.deepEqual(meta.properties?.source?.enum, ["fresh", "error", "stale-cache", "cache"]);
  assert.equal(meta.properties?.count?.type, "integer");
  for (const optional of ["cachedAt", "stale", "error"]) {
    assert.ok(meta.properties?.[optional], `${optional} metadata must be represented`);
    assert.ok(
      !meta.required?.includes(optional),
      `${optional} is conditional on cache/refresh outcome`
    );
  }
});
