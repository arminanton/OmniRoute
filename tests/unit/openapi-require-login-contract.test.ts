import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { updateRequireLoginSchema } from "../../src/shared/validation/schemas/settings.ts";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-require-login-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const requireLoginRoute = await import("../../src/app/api/settings/require-login/route.ts");

function operation(method: string): Record<string, any> {
  const result = spec.paths["/api/settings/require-login"]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} /api/settings/require-login`);
  return result;
}

test.beforeEach(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("public login/setup status matches the live handler fields", async () => {
  const response = await requireLoginRoute.GET();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(
    Object.keys(body).sort(),
    Object.keys(spec.components.schemas.RequireLoginStatusResponse.properties).sort()
  );
  assert.equal(typeof body.nodeCompatible, "boolean");
  assert.equal(typeof body.oidcDisablePasswordLogin, "boolean");
  assert.equal(
    operation("get").security,
    undefined,
    "the login screen reads this before authentication"
  );
  assert.equal(
    operation("get").responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/RequireLoginStatusResponse"
  );
});

test("require-login writes document the bootstrap/auth alternatives and validator bounds", () => {
  const post = operation("post");
  assert.ok(post.security?.some((item: object) => Object.hasOwn(item, "BearerAuth")));
  assert.ok(post.security?.some((item: object) => Object.hasOwn(item, "ManagementSessionAuth")));
  assert.ok(post.security?.some((item: object) => Object.keys(item).length === 0));
  assert.equal(post.requestBody.required, true);
  assert.equal(
    post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/RequireLoginUpdateRequest"
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.RequireLoginUpdateRequest.properties).sort(),
    Object.keys(updateRequireLoginSchema.shape).sort()
  );
  assert.equal(spec.components.schemas.RequireLoginUpdateRequest.properties.password.minLength, 4);
  assert.equal(
    spec.components.schemas.RequireLoginUpdateRequest.properties.password.writeOnly,
    true
  );
  assert.equal(updateRequireLoginSchema.safeParse({}).success, false);
  assert.equal(updateRequireLoginSchema.safeParse({ password: "test" }).success, true);
  assert.equal(updateRequireLoginSchema.safeParse({ requireLogin: true }).success, true);
  assert.equal(
    post.responses["200"].content["application/json"].schema.$ref,
    "#/components/schemas/RequireLoginUpdateResponse"
  );
  assert.ok(post.responses["400"]);
  assert.ok(post.responses["401"]);
  assert.ok(post.responses["403"]);
  assert.ok(post.responses["503"]);
});
