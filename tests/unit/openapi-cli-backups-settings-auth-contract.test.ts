import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const publicSpec = yaml.load(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8"));

function operation(pathname: string, method: string): any {
  const result = spec.paths[pathname]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathname}`);
  return result;
}

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function responseSchema(op: any, status: string): any {
  const schema = op.responses?.[status]?.content?.["application/json"]?.schema;
  assert.ok(schema, `missing JSON schema for ${status}`);
  return schema;
}

function assertAlternatives(op: any, schemes: string[], allowAnonymous: boolean): void {
  for (const scheme of schemes) {
    assert.ok(
      op.security?.some((alternative: Record<string, unknown>) => scheme in alternative),
      `${op.operationId} must document ${scheme}`
    );
  }
  assert.equal(
    op.security?.some(
      (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
    ),
    allowAnonymous,
    `${op.operationId} anonymous alternative`
  );
}

function assertUnionRefs(schema: any, refs: string[], union = "anyOf"): void {
  const actual = (schema?.[union] ?? []).map((item: { $ref?: string }) => item.$ref).sort();
  assert.deepEqual(actual, [...refs].sort());
}

test("CLI backup OpenAPI operations match the list, restore, and delete handler contracts", () => {
  const pathname = "/api/cli-tools/backups";
  const get = operation(pathname, "get");
  const post = operation(pathname, "post");
  const remove = operation(pathname, "delete");
  const handler = source("src/app/api/cli-tools/backups/route.ts");

  assert.deepEqual(get.parameters.map((parameter: any) => parameter.name).sort(), [
    "tool",
    "toolId",
  ]);
  assert.equal(
    get.parameters.every((parameter: any) => parameter.required === false),
    true
  );
  assert.equal(
    get.parameters.every((parameter: any) => parameter.allowEmptyValue === true),
    true
  );
  assert.equal(
    get.responses["400"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );
  assert.equal(
    get.responses["500"].content["application/json"].schema.$ref,
    "#/components/schemas/StringErrorResponse"
  );

  assert.match(post.summary, /restore/i);
  assert.equal(
    post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/CliToolBackupMutationRequest"
  );
  assert.equal(
    remove.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/CliToolBackupMutationRequest"
  );
  const mutation = spec.components.schemas.CliToolBackupMutationRequest;
  assert.deepEqual(mutation.required, ["backupId"]);
  assert.equal(mutation.properties.tool.$ref, "#/components/schemas/CliToolBackupToolId");
  assert.equal(mutation.properties.toolId.$ref, "#/components/schemas/CliToolBackupToolId");
  assert.equal(mutation.properties.backupId.minLength, 1);
  assert.equal(mutation.properties.backupId.pattern, "\\S");
  assert.deepEqual(mutation.anyOf, [{ required: ["tool"] }, { required: ["toolId"] }]);

  for (const op of [get, post, remove]) {
    assert.equal(op["x-always-protected"], true);
    assert.equal(op.responses["400"].content["application/json"].schema !== undefined, true);
    assert.equal(
      op.responses["500"].content["application/json"].schema.$ref,
      "#/components/schemas/StringErrorResponse"
    );
    assert.equal(
      op.responses["401"].$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(op.responses["503"].$ref, "#/components/responses/ManagementAuthUnavailable");
  }
  assertUnionRefs(responseSchema(post, "400"), [
    "#/components/schemas/ValidationErrorResponse",
    "#/components/schemas/StringErrorResponse",
  ]);
  assertUnionRefs(responseSchema(remove, "400"), [
    "#/components/schemas/ValidationErrorResponse",
    "#/components/schemas/StringErrorResponse",
  ]);
  assertUnionRefs(responseSchema(post, "403"), [
    "#/components/schemas/ApiErrorResponse",
    "#/components/schemas/StringErrorResponse",
  ]);

  assert.match(handler, /searchParams\.get\("tool"\) \|\| searchParams\.get\("toolId"\)/);
  assert.match(handler, /restoreBackup\(tool, backupId\)/);
  assert.match(handler, /deleteBackup\(tool, backupId\)/);
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact mirrors canonical docs");
});

test("memory and Qdrant operations document legacy auth paths and JSON error envelopes", () => {
  const protectedByLegacyHelper = [
    ["/api/settings/memory", "get"],
    ["/api/settings/memory", "put"],
    ["/api/settings/qdrant", "get"],
    ["/api/settings/qdrant", "put"],
    ["/api/settings/qdrant/health", "get"],
    ["/api/settings/qdrant/search", "post"],
    ["/api/settings/qdrant/cleanup", "post"],
    ["/api/settings/qdrant/embedding-models", "get"],
  ] as const;
  const schemes = [
    "ManagementApiKeyBearerAuth",
    "ManagementAnthropicApiKeyAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementSessionAuth",
  ];

  for (const [pathname, method] of protectedByLegacyHelper) {
    const op = operation(pathname, method);
    assertAlternatives(op, schemes, true);
    assert.match(op.description, /isAuthenticated\(\)/);
    if (
      pathname === "/api/settings/memory" ||
      pathname === "/api/settings/qdrant" ||
      pathname === "/api/settings/qdrant/search"
    ) {
      assert.match(op.description, /requireLogin=false/);
      assert.match(op.description, /oma_live_/);
      assert.match(op.description, /loopback/i);
    } else {
      assert.match(op.description, /documented for `\/api\/settings\/qdrant`/);
    }
    assert.ok(op.responses["401"], `${method.toUpperCase()} ${pathname} declares 401`);
    assertUnionRefs(responseSchema(op, "401"), [
      "#/components/schemas/ApiErrorResponse",
      "#/components/schemas/StringErrorResponse",
    ]);
    assert.ok(op.responses["403"], `${method.toUpperCase()} ${pathname} declares central 403`);
    assert.ok(op.responses["503"], `${method.toUpperCase()} ${pathname} declares central 503`);
  }

  for (const relativePath of [
    "src/app/api/settings/memory/route.ts",
    "src/app/api/settings/qdrant/route.ts",
    "src/app/api/settings/qdrant/health/route.ts",
    "src/app/api/settings/qdrant/search/route.ts",
    "src/app/api/settings/qdrant/cleanup/route.ts",
    "src/app/api/settings/qdrant/embedding-models/route.ts",
  ]) {
    assert.match(source(relativePath), /isAuthenticated\(request\)/, relativePath);
  }

  for (const pathname of ["/api/settings/memory", "/api/settings/qdrant"]) {
    assert.equal(
      responseSchema(operation(pathname, "get"), "500").$ref,
      "#/components/schemas/ApiErrorResponse"
    );
    const put = operation(pathname, "put");
    assertUnionRefs(
      responseSchema(put, "400"),
      [
        "#/components/schemas/ApiErrorResponse",
        "#/components/schemas/DirectValidationErrorPayload",
      ],
      "oneOf"
    );
    assert.equal(responseSchema(put, "500").$ref, "#/components/schemas/ApiErrorResponse");
  }
  for (const [pathname, method] of [
    ["/api/settings/qdrant/health", "get"],
    ["/api/settings/qdrant/search", "post"],
    ["/api/settings/qdrant/cleanup", "post"],
    ["/api/settings/qdrant/embedding-models", "get"],
  ]) {
    const op = operation(pathname, method);
    assert.ok(op.responses["500"]);
    if (pathname === "/api/settings/qdrant/embedding-models") continue;
    assert.equal(responseSchema(op, "500").$ref, "#/components/schemas/ApiErrorResponse");
  }
  assertUnionRefs(
    responseSchema(operation("/api/settings/qdrant/search", "post"), "400"),
    ["#/components/schemas/ApiErrorResponse", "#/components/schemas/DirectValidationErrorPayload"],
    "oneOf"
  );
  assert.equal(
    responseSchema(operation("/api/settings/qdrant/embedding-models", "get"), "500").$ref,
    "#/components/schemas/QdrantEmbeddingModelsErrorResponse"
  );
  assert.deepEqual(spec.components.schemas.QdrantEmbeddingModelsErrorResponse.required, [
    "error",
    "models",
  ]);
  assert.match(
    source("src/shared/utils/apiAuth.ts"),
    /validateBearerApiKeyForManagement\(apiKey\)/
  );
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact mirrors canonical docs");
});

test("payload-rules auth alternatives, validation body, and string error body match its helper", () => {
  const pathname = "/api/settings/payload-rules";
  const get = operation(pathname, "get");
  const put = operation(pathname, "put");
  const schemes = [
    "BearerAuth",
    "ManagementAnthropicApiKeyAuth",
    "ManagementGoogleApiKeyAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
  ];

  for (const op of [get, put]) {
    assertAlternatives(op, schemes, true);
    assert.match(op.description, /requireManagementAuth\(\)/);
    assert.match(op.description, /requireLogin=false/);
    assert.match(op.description, /loopback/i);
    assert.ok(op.responses["503"]);
  }
  assert.match(get.description, /`read` scope/);
  assert.match(put.description, /`write` scope/);
  assert.equal(responseSchema(put, "400").$ref, "#/components/schemas/ValidationErrorResponse");
  assert.equal(responseSchema(get, "500").$ref, "#/components/schemas/StringErrorResponse");
  assert.equal(responseSchema(put, "500").$ref, "#/components/schemas/StringErrorResponse");
  assert.match(
    source("src/app/api/settings/payload-rules/route.ts"),
    /requireManagementAuth\(request\)/
  );
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact mirrors canonical docs");
});
