import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  minLength?: number;
  maxLength?: number;
  minProperties?: number;
  maxProperties?: number;
  format?: string;
  const?: unknown;
  description?: string;
  writeOnly?: boolean;
  "x-sensitive"?: boolean;
  additionalProperties?: boolean | Schema;
};

type Response = {
  $ref?: string;
  description?: string;
  "x-sensitive"?: boolean;
  content?: Record<string, { schema?: Schema }>;
  headers?: Record<string, { schema?: Schema; description?: string }>;
};

type Operation = {
  description?: string;
  security?: Array<Record<string, unknown>>;
  requestBody?: {
    required?: boolean;
    "x-sensitive"?: boolean;
    content?: Record<string, { schema?: Schema }>;
  };
  responses?: Record<string, Response>;
};

type OpenApiDocument = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, Schema>;
    securitySchemes: Record<string, unknown>;
  };
};

const root = process.cwd();
const spec = yaml.load(
  fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8")
) as OpenApiDocument;
const providersRouteSource = fs.readFileSync(
  path.join(root, "src/app/api/providers/route.ts"),
  "utf8"
);
const providerSchemaSource = fs.readFileSync(
  path.join(root, "src/shared/validation/schemas/provider.ts"),
  "utf8"
);
const callbackRouteSource = fs.readFileSync(
  path.join(root, "src/app/api/providers/command-code/auth/callback/route.ts"),
  "utf8"
);
const callbackSharedSource = fs.readFileSync(
  path.join(root, "src/app/api/providers/command-code/auth/shared.ts"),
  "utf8"
);

function sourceObjectKeys(source: string, exportName: string): string[] {
  const block = source.match(
    new RegExp(
      `export const ${exportName} = z\\s*\\.object\\(\\{([\\s\\S]*?)\\n\\s{2}\\}\\)\\s*\\.superRefine\\(`
    )
  )?.[1];
  assert.ok(block, `could not locate ${exportName} in validation source`);
  return Array.from(block.matchAll(/^    ([A-Za-z][A-Za-z0-9]*):\s*z\b/gm), (match) => match[1]);
}

function assertManagementAuth(operation: Operation) {
  const requirements = operation.security ?? [];
  for (const scheme of [
    "BearerAuth",
    "ManagementAnthropicApiKeyAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
  ]) {
    assert.ok(
      requirements.some((requirement) => scheme in requirement),
      `missing ${scheme}`
    );
    assert.ok(spec.components.securitySchemes[scheme], `undefined security scheme ${scheme}`);
  }
  assert.ok(requirements.some((requirement) => Object.keys(requirement).length === 0));
  assert.equal(
    operation.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(operation.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
  assert.equal(
    operation.responses?.["503"]?.$ref,
    "#/components/responses/ManagementAuthUnavailable"
  );
  assert.match(operation.description ?? "", /in protected profiles/i);
  assert.match(
    operation.description ?? "",
    /unlocked standalone installs may permit anonymous access/i
  );
}

test("provider create schema and root management auth match source", () => {
  const sourceProperties = sourceObjectKeys(providerSchemaSource, "createProviderSchema").sort();
  const createOperation = spec.paths["/api/providers"]?.post;
  const createRequestSchemaRef =
    createOperation?.requestBody?.content?.["application/json"]?.schema?.$ref;
  assert.equal(createRequestSchemaRef, "#/components/schemas/ProviderConnectionCreate");

  const createSchema = spec.components.schemas.ProviderConnectionCreate;
  assert.equal(createSchema["x-sensitive"], true);
  assert.deepEqual(Object.keys(createSchema.properties ?? {}).sort(), sourceProperties);
  assert.deepEqual(createSchema.required?.slice().sort(), ["name", "provider"]);
  assert.equal(createSchema.properties?.apiKey?.maxLength, 100000);
  assert.equal(createSchema.properties?.apiKey?.writeOnly, true);
  assert.equal(createSchema.properties?.apiKey?.["x-sensitive"], true);
  assert.match(createSchema.properties?.apiKey?.description ?? "", /required.*providers/i);
  assert.match(providerSchemaSource, /if \(!apiKeyOptional && apiKey\.length === 0\)/);
  assert.equal(createSchema.properties?.providerSpecificData?.type, "object");
  assert.equal(createSchema.properties?.providerSpecificData?.writeOnly, true);
  assert.equal(createSchema.properties?.providerSpecificData?.["x-sensitive"], true);
  const updateSourceProperties = sourceObjectKeys(
    providerSchemaSource,
    "updateProviderConnectionSchema"
  );
  assert.ok(updateSourceProperties.includes("apiKey"));
  assert.ok(updateSourceProperties.includes("providerSpecificData"));
  const updateSchema = spec.components.schemas.ProviderConnectionUpdate;
  assert.equal(updateSchema["x-sensitive"], true);
  assert.equal(updateSchema.properties?.apiKey?.writeOnly, true);
  assert.equal(updateSchema.properties?.apiKey?.["x-sensitive"], true);
  assert.equal(updateSchema.properties?.providerSpecificData?.writeOnly, true);
  assert.equal(updateSchema.properties?.providerSpecificData?.["x-sensitive"], true);

  const providerConnectionSchema = spec.components.schemas.ProviderConnection;
  assert.equal(providerConnectionSchema.properties?.apiKey?.["x-sensitive"], true);

  const getStart = providersRouteSource.indexOf("export async function GET(request: Request)");
  const postStart = providersRouteSource.indexOf("export async function POST(request: Request)");
  const patchStart = providersRouteSource.indexOf("export async function PATCH(request: Request)");
  assert.ok(getStart >= 0 && postStart > getStart && patchStart > postStart);
  assert.match(providersRouteSource.slice(getStart, postStart), /requireManagementAuth\(request\)/);
  assert.match(
    providersRouteSource.slice(postStart, patchStart),
    /requireManagementAuth\(request\)/
  );
  assert.match(providersRouteSource.slice(postStart, patchStart), /status: 201/);
  assert.match(
    providersRouteSource.slice(postStart, patchStart),
    /rejectRetiredCommonChatGptWebProvider/
  );

  const list = spec.paths["/api/providers"]?.get;
  assert.ok(list);
  assertManagementAuth(list);
  assert.match(list.description ?? "", /API-key reveal is enabled/i);
  assert.match(list.description ?? "", /anonymous access and reveal enabled/i);
  assert.match(list.description ?? "", /`read` scope/);
  assert.equal(list.responses?.["200"]?.["x-sensitive"], true);
  assert.equal(spec.components.schemas.ProviderConnectionListResponse["x-sensitive"], true);
  assert.match(
    spec.components.schemas.ProviderConnectionListResponse.description ?? "",
    /raw keys when API-key reveal is enabled/i
  );
  assert.equal(
    list.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/StringErrorResponse"
  );

  assert.ok(createOperation);
  assertManagementAuth(createOperation);
  assert.match(createOperation.description ?? "", /`write` scope/);
  assert.equal(createOperation.requestBody?.["x-sensitive"], true);
  assert.match(createOperation.responses?.["201"]?.description ?? "", /omits the raw API key/i);
  assert.match(providersRouteSource.slice(getStart, postStart), /revealKeys \? c\.apiKey/);
  assert.match(providersRouteSource.slice(postStart, patchStart), /delete result\.apiKey/);
  assert.equal(
    createOperation.responses?.["400"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderConnectionErrorResponse"
  );
  assert.equal(
    createOperation.responses?.["404"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderConnectionErrorResponse"
  );
  assert.equal(
    createOperation.responses?.["410"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderConnectionErrorResponse"
  );
  assert.equal(
    createOperation.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ProviderConnectionErrorResponse"
  );
});

test("Command Code callback documents the sensitive payload, origin policy, and live outcomes", () => {
  const callback = spec.paths["/api/providers/command-code/auth/callback"]?.post;
  assert.ok(callback);
  assert.equal(spec.paths["/api/providers/command-code/auth/callback"]?.options, undefined);
  assert.match(callback.description ?? "", /OPTIONS response.*browser preflight/i);
  assert.match(callback.description ?? "", /CORS headers for allowed origins/i);

  const requestSchema = callback.requestBody?.content?.["application/json"]?.schema;
  assert.equal(requestSchema?.$ref, "#/components/schemas/CommandCodeAuthCallbackRequest");
  assert.equal(callback.requestBody?.required, true);
  const callbackRequest = spec.components.schemas.CommandCodeAuthCallbackRequest;
  assert.deepEqual(callbackRequest.required?.slice().sort(), ["apiKey", "state"]);
  assert.equal(callbackRequest.properties?.apiKey?.writeOnly, true);
  assert.equal(callbackRequest.properties?.apiKey?.["x-sensitive"], true);
  assert.equal(callbackRequest.properties?.apiKey?.maxLength, 4096);
  assert.equal(callbackRequest.properties?.state?.minLength, 32);
  assert.equal(callbackRequest.properties?.state?.maxLength, 512);

  assert.equal(
    callback.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CommandCodeAuthCallbackResponse"
  );
  for (const status of ["400", "413"]) {
    assert.equal(
      callback.responses?.[status]?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/CommandCodeAuthCallbackErrorResponse"
    );
  }
  assert.deepEqual(
    callback.responses?.["403"]?.content?.["application/json"]?.schema?.oneOf
      ?.map((branch: { $ref?: string }) => branch.$ref)
      .sort(),
    [
      "#/components/schemas/ApiErrorResponse",
      "#/components/schemas/CommandCodeAuthCallbackErrorResponse",
    ].sort()
  );
  assert.equal(
    spec.components.schemas.CommandCodeAuthCallbackResponse.properties?.apiKey,
    undefined,
    "the successful callback response must not expose the submitted API key"
  );

  const successReturn = callbackRouteSource.slice(
    callbackRouteSource.lastIndexOf("return noStoreJson(")
  );
  assert.match(successReturn, /success: true/);
  assert.match(successReturn, /metadata: session\.metadata/);
  assert.doesNotMatch(successReturn, /\bapiKey\s*:/);
  assert.match(callbackRouteSource, /export async function OPTIONS[\s\S]*?status: 204/);
  assert.match(callbackRouteSource, /rejectDisallowedCallbackOrigin\(request\)/);
  assert.match(callbackRouteSource, /MAX_CALLBACK_BODY_BYTES/);
  assert.match(callbackRouteSource, /status: isTooLarge \? 413 : 400/);
  assert.match(callbackSharedSource, /apiKey: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(4096\)/);
  assert.match(callbackSharedSource, /state: z\.string\(\)\.trim\(\)\.min\(32\)\.max\(512\)/);
  assert.match(callbackSharedSource, /const LOCAL_CALLBACK_ORIGIN = "http:\/\/localhost:3000"/);
  assert.match(
    callbackSharedSource,
    /const PRODUCTION_CALLBACK_ORIGINS = \["https:\/\/commandcode\.ai", "https:\/\/staging\.commandcode\.ai"\]/
  );
  assert.match(
    callbackSharedSource,
    /if \(!origin \|\| getAllowedCallbackOrigin\(origin\)\) return null/
  );
  assert.match(callback.description ?? "", /missing Origin is accepted/i);
  assert.match(callback.description ?? "", /10 KiB/);
  assert.match(callback.description ?? "", /https:\/\/commandcode\.ai/);
  assert.match(callback.description ?? "", /http:\/\/localhost:3000/);
});
