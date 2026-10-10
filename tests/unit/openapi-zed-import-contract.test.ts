import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const discoverSource = fs.readFileSync(
  path.join(ROOT, "src/app/api/providers/zed/discover/route.ts"),
  "utf8"
);
const importSource = fs.readFileSync(
  path.join(ROOT, "src/app/api/providers/zed/import/route.ts"),
  "utf8"
);
const manualImportSource = fs.readFileSync(
  path.join(ROOT, "src/app/api/providers/zed/manual-import/route.ts"),
  "utf8"
);
const confirmationSchemaSource = fs.readFileSync(
  path.join(ROOT, "src/shared/validation/schemas/misc.ts"),
  "utf8"
);
const zedImportSchemaSource = fs.readFileSync(
  path.join(ROOT, "src/shared/validation/schemas/auth.ts"),
  "utf8"
);
const fingerprintSource = fs.readFileSync(
  path.join(ROOT, "src/lib/zed-oauth/credentialFingerprint.ts"),
  "utf8"
);
const managementAuthSource = fs.readFileSync(
  path.join(ROOT, "src/lib/api/requireManagementAuth.ts"),
  "utf8"
);

const SECURITY = [
  { BearerAuth: [] },
  { ManagementAnthropicApiKeyAuth: [] },
  { ManagementGoogleApiKeyAuth: [] },
  { ManagementSessionAuth: [] },
  { LocalCliTokenAuth: [] },
  { InternalServiceTokenAuth: [] },
  {},
];

function operation(route: string) {
  const result = spec.paths[route]?.post;
  assert.ok(result, `missing POST ${route}`);
  return result;
}

function responseSchema(route: string) {
  const schema = operation(route).responses?.["200"]?.content?.["application/json"]?.schema;
  assert.ok(schema, `missing JSON 200 schema for POST ${route}`);
  return schema;
}

function assertManagementContract(route: string, accessTokenScope: string) {
  const current = operation(route);
  assert.deepEqual(current.security, SECURITY);
  assert.equal(
    current.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(
    current.responses?.["503"]?.$ref,
    "#/components/responses/ManagementAuthUnavailable"
  );
  assert.match(current.description, /`manage`\/`admin` API key via Bearer/);
  assert.match(current.description, /Anthropic `x-api-key`/);
  assert.match(current.description, /`anthropic-version` header/);
  assert.match(
    current.description,
    /User-Agent matching `claude-code`, `claude-cli`, or `anthropic`/
  );
  assert.match(current.description, /Google `x-goog-api-key`/);
  assert.match(current.description, /loopback CLI token/);
  assert.match(current.description, /trusted loopback internal-service token/);
  assert.match(
    current.description,
    new RegExp(`\\x60oma_live_\\x60 Access Token requires \\x60${accessTokenScope}\\x60 scope`)
  );
  assert.match(current.description, /requireLogin=false.*anonymous access/);
  assert.match(current.description, /URL credentials are not accepted/);
  assert.equal(inferRequiredScope("POST", route), "admin");
}

test("Zed keychain discovery returns only sensitive safe summaries", () => {
  const route = "/api/providers/zed/discover";
  const response = operation(route).responses?.["200"];
  assert.equal(response?.["x-sensitive"], true);
  assert.equal(responseSchema(route).$ref, "#/components/schemas/ZedDiscoverResponse");
  assertManagementContract(route, "admin");
  assert.match(operation(route).responses["404"].description, /Zed IDE is not installed/);

  const discover = spec.components.schemas.ZedDiscoverResponse;
  assert.deepEqual(discover.required, [
    "success",
    "zedInstalled",
    "count",
    "candidates",
    "skipped",
  ]);
  assert.equal(discover.properties.success.const, true);
  assert.equal(discover.properties.zedInstalled.const, true);
  assert.equal(discover.properties.count.type, "integer");
  assert.equal(
    discover.properties.candidates.items.$ref,
    "#/components/schemas/ZedDiscoverCandidate"
  );
  assert.equal(
    discover.properties.skipped.items.$ref,
    "#/components/schemas/ZedDiscoverSkippedCredential"
  );
  assert.equal(discover.properties.token, undefined);

  const candidate = spec.components.schemas.ZedDiscoverCandidate;
  assert.deepEqual(candidate.required, ["provider", "service", "account", "fingerprint"]);
  assert.deepEqual(Object.keys(candidate.properties).sort(), [
    "account",
    "fingerprint",
    "provider",
    "service",
  ]);
  assert.equal(candidate.properties.fingerprint.pattern, "^[a-f0-9]{16}$");
  assert.equal(candidate.properties.fingerprint["x-sensitive"], true);
  assert.equal(candidate.properties.token, undefined);

  const skipped = spec.components.schemas.ZedDiscoverSkippedCredential;
  assert.deepEqual(skipped.required, ["provider", "service", "account", "reason"]);
  assert.deepEqual(skipped.properties.reason.enum, ["unsupported provider", "missing token"]);

  assert.match(discoverSource, /requireManagementAuth\(request\)/);
  assert.match(
    discoverSource,
    /fingerprint: fingerprintZedCredential\(cred\.service, cred\.account, cred\.token\)/
  );
  assert.match(discoverSource, /reason: cred\.token \? "unsupported provider" : "missing token"/);
  assert.match(fingerprintSource, /\.digest\("hex"\)\s*\.slice\(0, 16\)/);
  assert.match(discoverSource, /raw token is never sent/i);
  assert.match(discoverSource, /status: 403/);
  assert.match(discoverSource, /status: 404/);
  assert.match(discoverSource, /status: 422/);
  assert.match(discoverSource, /status: 500/);
});

test("Zed confirmation import and manual import never return raw credentials", () => {
  const importPath = "/api/providers/zed/import";
  const importOperation = operation(importPath);
  assertManagementContract(importPath, "admin");
  assert.equal(importOperation.requestBody?.required, false);
  assert.equal(importOperation.requestBody?.["x-sensitive"], true);
  assert.match(importOperation.description, /OMNIROUTE_ZED_IMPORT_LEGACY_ONE_STEP=true/);
  assert.equal(
    importOperation.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ZedImportRequest"
  );
  assert.equal(importOperation.responses?.["200"]?.["x-sensitive"], true);
  assert.equal(responseSchema(importPath).$ref, "#/components/schemas/ZedImportResponse");
  assert.ok(importOperation.responses?.["400"]);
  assert.ok(importOperation.responses?.["404"]);
  assert.ok(importOperation.responses?.["422"]);
  assert.ok(importOperation.responses?.["500"]);
  assert.equal(
    importOperation.responses?.["403"]?.content?.["application/json"]?.schema?.oneOf?.some(
      (entry: Record<string, string>) =>
        entry.$ref === "#/components/schemas/ZedCredentialOperationErrorResponse"
    ),
    true
  );
  assert.equal(
    importOperation.responses?.["403"]?.content?.["application/json"]?.schema?.oneOf?.some(
      (entry: Record<string, string>) => entry.$ref === "#/components/schemas/ApiErrorResponse"
    ),
    true
  );

  const importRequest = spec.components.schemas.ZedImportRequest;
  assert.equal(importRequest["x-sensitive"], true);
  assert.deepEqual(importRequest.required, ["confirmedAccounts"]);
  assert.equal(importRequest.properties.confirmedAccounts.minItems, undefined);
  assert.equal(
    importRequest.properties.confirmedAccounts.items.$ref,
    "#/components/schemas/ZedConfirmedAccount"
  );
  const confirmation = spec.components.schemas.ZedConfirmedAccount;
  assert.deepEqual(confirmation.required, ["service", "account", "fingerprint"]);
  assert.equal(confirmation.properties.service.maxLength, 500);
  assert.equal(confirmation.properties.account.maxLength, 500);
  assert.equal(confirmation.properties.fingerprint.maxLength, 100);
  assert.equal(confirmation.properties.token, undefined);

  const importResponse = spec.components.schemas.ZedImportResponse;
  assert.deepEqual(importResponse.required, [
    "success",
    "count",
    "providers",
    "credentials",
    "zedInstalled",
  ]);
  assert.equal(importResponse.properties.success.const, true);
  assert.equal(importResponse.properties.zedInstalled.const, true);
  assert.equal(importResponse.properties.count.type, "integer");
  assert.equal(importResponse.properties.providers.uniqueItems, true);
  assert.equal(
    importResponse.properties.credentials.items.$ref,
    "#/components/schemas/ZedImportedCredentialSummary"
  );
  const summary = spec.components.schemas.ZedImportedCredentialSummary;
  assert.deepEqual(summary.required, ["provider", "service", "account", "hasToken"]);
  assert.equal(summary.properties.hasToken.type, "boolean");
  assert.equal(summary.properties.token, undefined);
  assert.equal(summary.properties.apiKey, undefined);
  assert.equal(importResponse.properties.token, undefined);
  assert.equal(importResponse.properties.apiKey, undefined);
  assert.equal(importResponse["x-sensitive"], true);
  assert.match(importResponse.properties.count.description, /successfully saved/);
  assert.match(importResponse.properties.credentials.description, /failed to save/);

  const manualPath = "/api/providers/zed/manual-import";
  const manualOperation = operation(manualPath);
  assertManagementContract(manualPath, "admin");
  assert.equal(manualOperation.requestBody?.required, true);
  assert.equal(manualOperation.requestBody?.["x-sensitive"], true);
  assert.equal(
    manualOperation.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ZedManualImportRequest"
  );
  assert.equal(manualOperation.responses?.["200"]?.["x-sensitive"], true);
  assert.equal(responseSchema(manualPath).$ref, "#/components/schemas/ZedManualImportResponse");
  for (const status of ["400", "401", "403", "500", "503"]) {
    assert.ok(manualOperation.responses?.[status], `missing ${status} ${manualPath}`);
  }

  const manualRequest = spec.components.schemas.ZedManualImportRequest;
  assert.deepEqual(manualRequest.required, ["provider", "token"]);
  assert.equal(manualRequest.properties.provider.minLength, 1);
  assert.equal(manualRequest.properties.provider.maxLength, 64);
  assert.equal(manualRequest.properties.token.minLength, 1);
  assert.equal(manualRequest.properties.token.maxLength, 512);
  assert.equal(manualRequest.properties.token.writeOnly, true);
  assert.equal(manualRequest.properties.token["x-sensitive"], true);
  assert.equal(manualRequest.properties.label.maxLength, 128);

  const manualResponse = spec.components.schemas.ZedManualImportResponse;
  assert.deepEqual(Object.keys(manualResponse.properties).sort(), [
    "connectionId",
    "provider",
    "success",
  ]);
  assert.deepEqual(manualResponse.required, ["success", "connectionId", "provider"]);
  assert.equal(manualResponse.properties.success.const, true);
  assert.equal(manualResponse.properties.token, undefined);
  assert.equal(manualResponse["x-sensitive"], true);
  assert.equal(
    manualOperation.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  assert.equal(
    manualOperation.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );

  assert.match(importSource, /requireManagementAuth\(request\)/);
  assert.match(importSource, /credentials: credentialSummary/);
  assert.match(importSource, /hasToken: Boolean\(cred\.token\)/);
  assert.match(importSource, /count: savedCount/);
  assert.match(importSource, /providers: uniqueProviders/);
  assert.match(importSource, /apiKey: cred\.token/);
  assert.match(importSource, /status: 400/);
  assert.match(importSource, /status: 403/);
  assert.match(importSource, /status: 404/);
  assert.match(importSource, /status: 422/);
  assert.match(importSource, /status: 500/);
  assert.match(manualImportSource, /token: z\.string\(\)\.min\(1\)\.max\(512\)/);
  assert.match(manualImportSource, /apiKey: token/);
  assert.match(manualImportSource, /apiKey: token/);
  assert.match(manualImportSource, /status: 400/);
  assert.match(manualImportSource, /status: 500/);
  assert.match(
    manualImportSource,
    /return NextResponse\.json\(\{ success: true, connectionId: connection\.id, provider \}\)/
  );
  assert.match(confirmationSchemaSource, /service: z\.string\(\)\.min\(1\)\.max\(500\)/);
  assert.match(confirmationSchemaSource, /account: z\.string\(\)\.min\(1\)\.max\(500\)/);
  assert.match(confirmationSchemaSource, /fingerprint: z\.string\(\)\.min\(1\)\.max\(100\)/);
  assert.match(zedImportSchemaSource, /confirmedAccounts: z\.array\(confirmedAccountSchema\)/);
  for (const source of [discoverSource, importSource, manualImportSource]) {
    assert.match(source, /requireManagementAuth\(request\)/);
  }
  assert.match(managementAuthSource, /status: 401/);
  assert.match(managementAuthSource, /status: 403/);
  assert.match(managementAuthSource, /status: 503/);
  assert.match(managementAuthSource, /extractApiKey\(request, \{ allowUrl: false \}\)/);
});
