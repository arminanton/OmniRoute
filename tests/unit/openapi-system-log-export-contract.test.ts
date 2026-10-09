import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-openapi-system-contract-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.STORAGE_ENCRYPTION_KEY = "openapi-system-contract-test-key";
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const destinationDb = await import("../../src/lib/db/logExportDestinations.ts");
const logExportRegistry = await import("../../src/lib/logExport/registry.ts");
const jobRegistryModule = await import("../../src/lib/jobRegistry/index.ts");
const sessionManager = await import("../../open-sse/services/sessionManager.ts");
const storageHealthRoute = await import("../../src/app/api/storage/health/route.ts");
const sessionsRoute = await import("../../src/app/api/sessions/route.ts");
const jobsRoute = await import("../../src/app/api/jobs/route.ts");
const logTypesRoute = await import("../../src/app/api/log-export/types/route.ts");
const destinationsRoute = await import("../../src/app/api/log-export/destinations/route.ts");
const logStatusRoute = await import("../../src/app/api/log-export/status/route.ts");

function operation(pathTemplate: string, method: string): Record<string, any> {
  const result = spec.paths[pathTemplate]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathTemplate}`);
  return result;
}

function schemaProperties(name: string): string[] {
  return Object.keys(spec.components.schemas[name]?.properties ?? {}).sort();
}

function assertResponseRef(pathTemplate: string, method: string, status: string, name: string) {
  assert.equal(
    operation(pathTemplate, method).responses?.[status]?.content?.["application/json"]?.schema
      ?.$ref,
    `#/components/schemas/${name}`
  );
}

test.beforeEach(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  sessionManager.clearSessions();
  jobRegistryModule.__resetJobRegistry();
});

test.after(() => {
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("storage, session, and local job schemas match live handler output", async () => {
  const storageResponse = await storageHealthRoute.GET();
  const storageBody = await storageResponse.json();
  assert.equal(storageResponse.status, 200);
  assert.deepEqual(Object.keys(storageBody).sort(), schemaProperties("StorageHealthResponse"));

  const sessionsResponse = await sessionsRoute.GET();
  const sessionsBody = await sessionsResponse.json();
  assert.equal(sessionsResponse.status, 200);
  assert.deepEqual(Object.keys(sessionsBody).sort(), schemaProperties("DashboardSessionsResponse"));

  const jobs = jobRegistryModule.getJobRegistry();
  jobs.register({
    id: "openapi-contract-job",
    type: "interval",
    cron: null,
    intervalMs: 60_000,
    enabled: false,
    envFlag: null,
    config: { timezone: "UTC" },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    handler: async () => ({ success: true }),
  });

  const jobsResponse = await jobsRoute.GET();
  const jobsBody = await jobsResponse.json();
  assert.equal(jobsResponse.status, 200);
  assert.deepEqual(Object.keys(jobsBody), ["data"]);
  assert.ok(jobsBody.data.some((job: { id: string }) => job.id === "openapi-contract-job"));
  for (const job of jobsBody.data) {
    assert.deepEqual(Object.keys(job).sort(), schemaProperties("JobSummary"));
  }
});

test("log-export destination and type APIs publish their exact redacted view shapes", async () => {
  const registeredTypes = logExportRegistry.describeLogExportDestinationTypes();
  const typesResponse = await logTypesRoute.GET(
    new Request("http://localhost/api/log-export/types")
  );
  const typesBody = await typesResponse.json();
  assert.equal(typesResponse.status, 200);
  assert.deepEqual(Object.keys(typesBody), ["types"]);
  assert.deepEqual(typesBody.types, registeredTypes);
  assert.deepEqual(
    Object.keys(typesBody.types[0]).sort(),
    schemaProperties("LogExportDestinationTypeDescriptor")
  );
  for (const descriptor of typesBody.types) {
    for (const field of descriptor.fields) {
      assert.deepEqual(
        Object.keys(field).sort(),
        Object.keys(spec.components.schemas.LogExportConfigFieldDescriptor.properties)
          .filter((key) => Object.hasOwn(field, key))
          .sort()
      );
      assert.ok(
        ["text", "password", "textarea", "number", "boolean", "select"].includes(field.type)
      );
    }
  }

  destinationDb.createLogExportDestination({
    name: "Contract destination",
    type: "bigquery",
    config: {},
  });
  const destinationsResponse = await destinationsRoute.GET(
    new Request("http://localhost/api/log-export/destinations")
  );
  const destinationsBody = await destinationsResponse.json();
  assert.equal(destinationsResponse.status, 200);
  assert.equal(destinationsBody.destinations.length, 1);
  assert.deepEqual(
    Object.keys(destinationsBody.destinations[0]).sort(),
    schemaProperties("LogExportDestinationView")
  );

  const statusResponse = await logStatusRoute.GET(
    new Request("http://localhost/api/log-export/status")
  );
  const statusBody = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.deepEqual(Object.keys(statusBody).sort(), schemaProperties("LogExportStatusResponse"));
});

test("local job and log-export operations describe actual success bodies and management auth", () => {
  assertResponseRef("/api/storage/health", "get", "200", "StorageHealthResponse");
  assertResponseRef("/api/sessions", "get", "200", "DashboardSessionsResponse");
  assertResponseRef("/api/jobs", "get", "200", "JobsListResponse");
  assertResponseRef("/api/jobs/{id}/enable", "post", "200", "JobEnabledResponse");
  assertResponseRef("/api/jobs/{id}/disable", "post", "200", "JobEnabledResponse");
  assertResponseRef("/api/jobs/{id}/run-now", "post", "200", "JobTriggerResponse");
  assertResponseRef("/api/jobs/{id}/runs", "get", "200", "JobRunHistoryResponse");

  for (const [route, method] of [
    ["/api/log-export/types", "get"],
    ["/api/log-export/destinations", "get"],
    ["/api/log-export/destinations", "post"],
    ["/api/log-export/destinations/{id}", "get"],
    ["/api/log-export/destinations/{id}", "put"],
    ["/api/log-export/destinations/{id}", "delete"],
    ["/api/log-export/destinations/{id}/test", "post"],
    ["/api/log-export/destinations/{id}/run", "post"],
    ["/api/log-export/status", "get"],
  ] as const) {
    const op = operation(route, method);
    assert.ok(op.security?.some((entry: object) => Object.hasOwn(entry, "BearerAuth")));
    assert.ok(op.security?.some((entry: object) => Object.hasOwn(entry, "ManagementSessionAuth")));
    assert.ok(op.security?.some((entry: object) => Object.keys(entry).length === 0));
    assert.equal(
      op.responses?.["401"]?.$ref,
      "#/components/responses/ManagementAuthenticationRequired"
    );
    assert.equal(op.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
    assert.equal(op.responses?.["503"]?.$ref, "#/components/responses/ManagementAuthUnavailable");
  }

  assertResponseRef("/api/log-export/types", "get", "200", "LogExportDestinationTypesResponse");
  assertResponseRef(
    "/api/log-export/destinations",
    "get",
    "200",
    "LogExportDestinationListResponse"
  );
  assertResponseRef(
    "/api/log-export/destinations",
    "post",
    "201",
    "LogExportDestinationCreateResponse"
  );
  assertResponseRef(
    "/api/log-export/destinations/{id}",
    "get",
    "200",
    "LogExportDestinationResponse"
  );
  assertResponseRef(
    "/api/log-export/destinations/{id}",
    "put",
    "200",
    "LogExportDestinationResponse"
  );
  assertResponseRef(
    "/api/log-export/destinations/{id}",
    "delete",
    "200",
    "LogExportDestinationDeleteResponse"
  );
  assertResponseRef(
    "/api/log-export/destinations/{id}/test",
    "post",
    "200",
    "LogExportTestResponse"
  );
  assertResponseRef("/api/log-export/destinations/{id}/run", "post", "200", "LogExportRunResponse");
  assertResponseRef("/api/log-export/status", "get", "200", "LogExportStatusResponse");

  const create = operation("/api/log-export/destinations", "post").requestBody.content[
    "application/json"
  ].schema;
  assert.deepEqual(create.required, ["name", "type"]);
  assert.equal(create.properties.config.type, "object");
  assert.equal(
    create.properties.config.required,
    undefined,
    "destination-specific config defaults to an empty object in the handler"
  );
  assert.equal(create.properties.batchSize.minimum, 1);
  assert.equal(create.properties.batchSize.maximum, 10000);
  assert.equal(create.properties.maxBodyBytes.maximum, 5000000);
  assert.equal(create.properties.maxRowsPerRun.maximum, 1000000);
});
