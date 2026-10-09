import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";
import { isAlwaysProtectedPath, isLocalOnlyPath } from "../../src/server/authz/routeGuard.ts";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const previousDataDir = process.env.DATA_DIR;
const previousAutoBackup = process.env.DISABLE_SQLITE_AUTO_BACKUP;
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-webhook-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
const core = await import("../../src/lib/db/core.ts");
const webhookDb = await import("../../src/lib/db/webhooks.ts");
const deliveryDb = await import("../../src/lib/db/webhookDeliveries.ts");
const detailRoute = await import("../../src/app/api/webhooks/[id]/route.ts");
const deliveriesRoute = await import("../../src/app/api/webhooks/[id]/deliveries/route.ts");

const operations = [
  { file: "src/app/api/webhooks/[id]/route.ts", method: "get", path: "/api/webhooks/{id}" },
  { file: "src/app/api/webhooks/[id]/route.ts", method: "put", path: "/api/webhooks/{id}" },
  { file: "src/app/api/webhooks/[id]/route.ts", method: "delete", path: "/api/webhooks/{id}" },
  {
    file: "src/app/api/webhooks/[id]/deliveries/route.ts",
    method: "get",
    path: "/api/webhooks/{id}/deliveries",
  },
  {
    file: "src/app/api/webhooks/[id]/test/route.ts",
    method: "post",
    path: "/api/webhooks/{id}/test",
  },
] as const;

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  if (previousAutoBackup === undefined) delete process.env.DISABLE_SQLITE_AUTO_BACKUP;
  else process.env.DISABLE_SQLITE_AUTO_BACKUP = previousAutoBackup;
});

function operation(route: (typeof operations)[number]) {
  const result = spec.paths?.[route.path]?.[route.method];
  assert.ok(result, `missing ${route.method.toUpperCase()} ${route.path}`);
  return result;
}

function sourceOperations() {
  const root = apiRoot(ROOT);
  const files = new Set(operations.map(({ file }) => file));
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (!files.has(relativeFile as (typeof operations)[number]["file"])) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

test("webhook instance OpenAPI operations match source routes and management policy", () => {
  const documented = new Set(operations.map(({ method, path }) => `${method} ${path}`));
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
  assert.equal(documented.size, 5);

  for (const route of operations) {
    const method = route.method.toUpperCase();
    const op = operation(route);
    assert.equal(classifyRoute(route.path, method).routeClass, "MANAGEMENT");
    assert.equal(isLocalOnlyPath(route.path, method), false);
    assert.equal(isAlwaysProtectedPath(route.path), false);
    assert.equal(inferRequiredScope(method, route.path), method === "GET" ? "read" : "write");
    for (const scheme of [
      "BearerAuth",
      "ManagementSessionAuth",
      "LocalCliTokenAuth",
      "InternalServiceTokenAuth",
    ]) {
      assert.ok(
        op.security?.some((entry: Record<string, unknown>) => scheme in entry),
        `${method} ${route.path} must document ${scheme}`
      );
    }
    assert.ok(
      op.security?.some((entry: Record<string, unknown>) => Object.keys(entry).length === 0),
      `${method} ${route.path} may be anonymous in the unlocked requireLogin=false profile`
    );
    assert.match(op.description ?? "", /requireLogin=false/);
    assert.ok(op.responses?.["401"] && op.responses?.["403"] && op.responses?.["503"]);
  }
});

test("webhook-instance schemas distinguish masked secrets, full update records, and safe deliveries", () => {
  const detail = operation(operations[0]);
  assert.equal(
    detail.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/WebhookDetailResponse"
  );
  assert.equal(detail.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(detail.responses?.["404"] && detail.responses?.["500"]);
  assert.equal(spec.components.schemas.WebhookMaskedRecord.properties.secret["x-sensitive"], true);

  const update = operation(operations[1]);
  assert.equal(
    update.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/WebhookUpdateRequest"
  );
  assert.equal(update.requestBody?.["x-sensitive"], true);
  assert.equal(
    update.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/WebhookUpdatedResponse"
  );
  assert.equal(update.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(update.responses?.["400"] && update.responses?.["404"] && update.responses?.["500"]);
  assert.equal(spec.components.schemas.WebhookUpdateRequest.additionalProperties, false);
  assert.equal(spec.components.schemas.WebhookUpdateRequest.properties.secret["x-sensitive"], true);

  const remove = operation(operations[2]);
  assert.equal(
    remove.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/WebhookDeleteResponse"
  );
  assert.ok(remove.responses?.["404"]);

  const deliveries = operation(operations[3]);
  assert.equal(
    deliveries.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/WebhookDeliveriesResponse"
  );
  assert.equal(
    spec.components.schemas.WebhookDeliveryRecord.properties.payload_snapshot,
    undefined
  );
  assert.ok(deliveries.parameters?.some((parameter: any) => parameter.name === "limit"));

  const sendTest = operation(operations[4]);
  assert.equal(
    sendTest.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/WebhookTestResponse"
  );
  assert.equal(sendTest.responses?.["200"]?.["x-sensitive"], true);
  assert.ok(sendTest.responses?.["404"] && sendTest.responses?.["422"]);
  assert.match(sendTest.description, /outbound network side effect/i);
});

test("webhook instance handlers mask GET secrets, expose full update record, and omit delivery payload", async () => {
  const webhook = webhookDb.createWebhook({
    url: "https://hooks.example.invalid/test",
    secret: "whsec_0123456789abcdef",
    description: "contract fixture",
  });
  deliveryDb.insertDelivery({
    webhookId: webhook.id,
    eventType: "test.ping",
    status: "success",
    httpStatus: 200,
    latencyMs: 12,
    payloadSnapshot: JSON.stringify({ private: "body" }),
  });
  const context = { params: Promise.resolve({ id: webhook.id }) };

  const detailResponse = await detailRoute.GET(
    new Request(`http://localhost/api/webhooks/${webhook.id}`),
    context
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.webhook.secret, "whsec_0123...");
  assert.equal(detail.webhook.metadata_encrypted, null);

  const updateResponse = await detailRoute.PUT(
    new Request(`http://localhost/api/webhooks/${webhook.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "updated" }),
    }),
    context
  );
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.webhook.description, "updated");
  assert.equal(updated.webhook.secret, "whsec_0123456789abcdef");

  const deliveriesResponse = await deliveriesRoute.GET(
    new Request(`http://localhost/api/webhooks/${webhook.id}/deliveries`),
    context
  );
  assert.equal(deliveriesResponse.status, 200);
  const deliveries = await deliveriesResponse.json();
  assert.equal(deliveries.deliveries.length, 1);
  assert.equal(deliveries.deliveries[0].status, "success");
  assert.equal("payload_snapshot" in deliveries.deliveries[0], false);
  assert.equal("private" in deliveries.deliveries[0], false);
});

test("webhook instance contract is mirrored in public OpenAPI", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
