import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const qdrantModelsSource = fs.readFileSync(
  path.join(ROOT, "src/app/api/settings/qdrant/embedding-models/route.ts"),
  "utf8"
);
const qdrantCleanupSource = fs.readFileSync(
  path.join(ROOT, "src/app/api/settings/qdrant/cleanup/route.ts"),
  "utf8"
);
const contextCombosSource = fs.readFileSync(
  path.join(ROOT, "src/app/api/context/combos/route.ts"),
  "utf8"
);
const mitmSource = fs.readFileSync(path.join(ROOT, "src/app/api/settings/mitm/route.ts"), "utf8");

function operation(pathTemplate: string, method: string) {
  const result = spec.paths?.[pathTemplate]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathTemplate}`);
  return result;
}

function schema(name: string) {
  const result = spec.components?.schemas?.[name];
  assert.ok(result, `missing OpenAPI schema ${name}`);
  return result;
}

function sourceSchemaProperties(source: string, schemaName: string): string[] {
  const declaration = source.match(
    new RegExp(
      `export const ${schemaName} = z\\s*\\.object\\(\\{([\\s\\S]*?)\\n\\s*\\}\\)\\s*\\.strict\\(\\);`
    )
  );
  assert.ok(declaration, `missing source validator ${schemaName}`);
  return [...declaration[1].matchAll(/^[ \t]{4}([A-Za-z][A-Za-z0-9]*):/gm)].map(
    (match) => match[1]
  );
}

function assertConditionalManagementAuth(op: any) {
  const security = op.security ?? [];
  assert.ok(security.some((entry: Record<string, unknown>) => "BearerAuth" in entry));
  assert.ok(security.some((entry: Record<string, unknown>) => "ManagementSessionAuth" in entry));
  assert.ok(security.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0));
  assert.equal(
    op.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.ok(op.responses?.["403"]);
  assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
}

function mitmFunctionSource(method: "GET" | "PUT" | "POST"): string {
  const start = mitmSource.indexOf(`export async function ${method}(request: Request) {`);
  assert.notEqual(start, -1, `missing source handler ${method}`);
  const next = mitmSource.indexOf("\nexport async function ", start + 1);
  return mitmSource.slice(start, next === -1 ? undefined : next);
}

test("Qdrant response contracts match the source-backed embedding option and cleanup bodies", () => {
  const models = operation("/api/settings/qdrant/embedding-models", "get");
  const modelsResponse = models.responses?.["200"]?.content?.["application/json"]?.schema;
  assert.equal(
    modelsResponse?.properties?.models?.items?.$ref,
    "#/components/schemas/QdrantEmbeddingModelOption"
  );
  assert.deepEqual(schema("QdrantEmbeddingModelOption").required, ["value", "label"]);
  assert.deepEqual(Object.keys(schema("QdrantEmbeddingModelOption").properties).sort(), [
    "dimensions",
    "label",
    "value",
  ]);
  assert.match(
    qdrantModelsSource,
    /type EmbeddingModelOption = \{\s*value: string;\s*label: string;\s*dimensions\?: number;/
  );
  assert.match(qdrantModelsSource, /return NextResponse\.json\(\{ models: withRegistry \}\)/);

  const cleanup = operation("/api/settings/qdrant/cleanup", "post");
  assert.equal(
    cleanup.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/QdrantCleanupResponse"
  );
  assert.deepEqual(schema("QdrantCleanupResponse").required, [
    "ok",
    "deletedCount",
    "retentionDays",
  ]);
  assert.deepEqual(Object.keys(schema("QdrantCleanupResponse").properties).sort(), [
    "deletedCount",
    "ok",
    "retentionDays",
  ]);
  assert.equal(
    cleanup.responses?.["500"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ApiErrorResponse"
  );
  assert.equal(cleanup.responses?.["503"], undefined);
  assert.match(
    qdrantCleanupSource,
    /return NextResponse\.json\(\{\s*ok: result\.ok,\s*deletedCount: result\.deletedCount,\s*retentionDays: memorySettings\.retentionDays,\s*\}\)/
  );
  assert.match(
    qdrantCleanupSource,
    /return NextResponse\.json\(\{ error: \{ message \} \}, \{ status: 500 \}\)/
  );
});

test("context combo collection documents conditional auth and its typed 201 create contract", () => {
  const list = operation("/api/context/combos", "get");
  const create = operation("/api/context/combos", "post");
  assertConditionalManagementAuth(list);
  assertConditionalManagementAuth(create);
  assert.match(contextCombosSource, /requireManagementAuth\(request\)/);

  assert.equal(
    list.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ContextCompressionComboListResponse"
  );
  assert.equal(
    create.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ContextCompressionComboCreateRequest"
  );
  assert.deepEqual(
    Object.keys(schema("ContextCompressionComboCreateRequest").properties).sort(),
    sourceSchemaProperties(contextCombosSource, "compressionComboCreateSchema").sort()
  );
  assert.deepEqual(schema("ContextCompressionComboCreateRequest").required, ["name"]);
  assert.equal(schema("ContextCompressionComboCreateRequest").additionalProperties, false);
  assert.equal(
    create.responses?.["201"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ContextCompressionComboRecord"
  );
  assert.equal(create.responses?.["200"], undefined);
  assert.match(contextCombosSource, /return NextResponse\.json\(combo, \{ status: 201 \}\)/);
});

test("MITM operations document conditional auth, sensitive update inputs, and source errors", () => {
  const get = operation("/api/settings/mitm", "get");
  const put = operation("/api/settings/mitm", "put");
  const post = operation("/api/settings/mitm", "post");

  for (const [method, op] of [
    ["GET", get],
    ["PUT", put],
    ["POST", post],
  ] as const) {
    assertConditionalManagementAuth(op);
    assert.equal(op["x-loopback-only"], true);
    assert.match(mitmFunctionSource(method), /requireManagementAuth\(request\)/);
  }

  assert.ok(get.parameters?.some((parameter: any) => parameter.name === "download"));
  assert.equal(
    get.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/MitmStatusResponse"
  );
  assert.equal(get.responses?.["200"]?.content?.["application/x-pem-file"]?.schema?.type, "string");
  assert.ok(get.responses?.["404"]);
  assert.ok(get.responses?.["500"]);

  assert.equal(put.requestBody?.required, false);
  assert.equal(put.requestBody?.["x-sensitive"], true);
  assert.equal(
    put.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/MitmUpdateRequest"
  );
  const updateSchema = schema("MitmUpdateRequest");
  assert.deepEqual(Object.keys(updateSchema.properties).sort(), [
    "apiKey",
    "enabled",
    "keyId",
    "port",
    "sudoPassword",
  ]);
  for (const secretField of ["apiKey", "sudoPassword"]) {
    assert.equal(updateSchema.properties[secretField].writeOnly, true);
    assert.equal(updateSchema.properties[secretField]["x-sensitive"], true);
  }
  assert.ok(put.responses?.["400"]);
  assert.ok(put.responses?.["500"]);

  assert.equal(post.requestBody?.required, false);
  assert.equal(
    post.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/MitmRegenerateCertificateRequest"
  );
  assert.deepEqual(schema("MitmRegenerateCertificateRequest").properties.action.enum, [
    "regenerate-cert",
  ]);
  assert.ok(post.responses?.["400"]);
  assert.ok(post.responses?.["409"]);
  assert.ok(post.responses?.["500"]);

  assert.match(mitmSource, /apiKey: z\.string\(\)\.optional\(\)/);
  assert.match(mitmSource, /keyId: z\.string\(\)\.optional\(\)/);
  assert.match(mitmSource, /sudoPassword: z\.string\(\)\.optional\(\)/);
  assert.match(
    mitmSource,
    /port: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(65535\)\.optional\(\)/
  );
  assert.match(mitmSource, /download.*=== "cert"/);
  assert.match(mitmSource, /status: 409/);
  assert.match(mitmSource, /toPublicSafeTunnelError/);
});
