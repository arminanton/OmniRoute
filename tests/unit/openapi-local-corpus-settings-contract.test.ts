import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "omni-openapi-local-corpus-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(
  await fs.readFile(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")
) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const localCorpusRoute = await import("../../src/app/api/settings/local-corpus/route.ts");
const { resetLocalCorpusIndex } = await import("../../src/lib/localCorpus/configured.ts");

function request(method: string, body?: unknown): Promise<Request> {
  return makeManagementSessionRequest("http://localhost/api/settings/local-corpus", {
    method,
    ...(body === undefined ? {} : { body }),
  });
}

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/settings/local-corpus"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings/local-corpus`);
  return result;
}

async function resetStorage(): Promise<void> {
  coreDb.resetDbInstance();
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await fs.mkdir(TEST_DATA_DIR, { recursive: true });
  resetLocalCorpusIndex();
}

test.beforeEach(resetStorage);

test.after(async () => {
  await resetStorage();
  coreDb.resetDbInstance();
  await fs.rm(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("local-corpus GET exposes unconfigured root and default bounded index status", async () => {
  const response = await localCorpusRoute.GET((await request("GET")) as never);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["configured", "rootPath", "status"]);
  assert.equal(body.configured, false);
  assert.equal(body.rootPath, null);
  assert.equal(body.status.configured, false);
  assert.equal(body.status.source, null);
  assert.deepEqual(Object.keys(body.status).sort(), [
    "chunks",
    "configured",
    "indexedBytes",
    "indexedFiles",
    "lastIndexedAt",
    "limits",
    "source",
    "truncated",
  ]);
  assert.deepEqual(Object.keys(body.status.limits).sort(), [
    "maxFileBytes",
    "maxFiles",
    "maxReadLines",
    "maxTotalBytes",
  ]);
});

test("local-corpus POST canonicalizes the root and DELETE disconnects without deleting files", async () => {
  const rootPath = path.join(TEST_DATA_DIR, "corpus");
  await fs.mkdir(rootPath);
  await fs.writeFile(path.join(rootPath, "source.txt"), "local source remains", "utf8");

  const saved = await localCorpusRoute.POST((await request("POST", { rootPath })) as never);
  const savedBody = await saved.json();
  assert.equal(saved.status, 200);
  assert.deepEqual(Object.keys(savedBody).sort(), ["configured", "message", "rootPath"]);
  assert.equal(savedBody.configured, true);
  assert.equal(savedBody.rootPath, await fs.realpath(rootPath));
  assert.match(savedBody.message, /local filesystem/);

  const read = await localCorpusRoute.GET((await request("GET")) as never);
  const readBody = await read.json();
  assert.equal(readBody.configured, true);
  assert.equal(readBody.rootPath, await fs.realpath(rootPath));
  assert.equal(readBody.status.configured, true);
  assert.equal(readBody.status.source, null);
  assert.equal(readBody.status.indexedFiles, 0);

  const removed = await localCorpusRoute.DELETE((await request("DELETE")) as never);
  const removedBody = await removed.json();
  assert.equal(removed.status, 200);
  assert.deepEqual(Object.keys(removedBody).sort(), ["configured", "message"]);
  assert.equal(removedBody.configured, false);
  assert.match(removedBody.message, /Source files were not modified/);
  assert.equal(
    await fs.readFile(path.join(rootPath, "source.txt"), "utf8"),
    "local source remains"
  );
});

test("local-corpus POST rejects invalid or inaccessible roots", async () => {
  const relative = await localCorpusRoute.POST(
    (await request("POST", { rootPath: "relative/path" })) as never
  );
  assert.equal(relative.status, 400);
  assert.ok((await relative.json()).error);

  const missing = await localCorpusRoute.POST(
    (await request("POST", { rootPath: path.join(TEST_DATA_DIR, "missing") })) as never
  );
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /Local corpus root is not accessible/);
});

test("local-corpus OpenAPI documents conditional auth, root bounds and response envelopes", () => {
  for (const method of ["get", "post", "delete"]) {
    const op = operation(method);
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
    assert.ok(op.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
    assert.ok(op.security?.some((item: object) => Object.keys(item).length === 0));
    assert.ok(op.responses["401"]);
  }
  assert.equal(
    operation("get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/LocalCorpusSettingsResponse"
  );
  assert.equal(
    operation("post").requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/LocalCorpusRootRequest"
  );
  assert.equal(
    operation("post").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/LocalCorpusRootSetResponse"
  );
  assert.equal(
    operation("delete").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/LocalCorpusDisconnectResponse"
  );
  assert.equal(spec.components.schemas.LocalCorpusRootRequest.properties.rootPath.maxLength, 4096);
  assert.ok(spec.components.schemas.LocalCorpusStatusResponse.properties.limits.$ref);
});
