/**
 * GHSA-mvf8-qc78-5mxm — GET /api/monitoring/health returned host-fingerprinting
 * detail (version, node version, pid, memory, provider config) to anonymous
 * callers. It now serves only the liveness verdict to non-management callers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NextRequest } from "next/server";
import { parse } from "yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

type HealthResponseSchema = {
  additionalProperties?: boolean;
  properties?: Record<string, { enum?: unknown[] }>;
};
type HealthOpenApi = { components: { schemas: Record<string, HealthResponseSchema> } };

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omni-health-view-"));
process.env.DATA_DIR = TEST_DATA_DIR;
const openapi = parse(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")
) as HealthOpenApi;

const core = await import("../../src/lib/db/core.ts");
const route = await import("../../src/app/api/monitoring/health/route.ts");

test.afterEach(() => route.__test_resetMonitoringHealthPayloadCache());

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("anonymous health GET is reduced to liveness only (GHSA-mvf8)", async () => {
  const res = await route.GET(new Request("http://localhost/api/monitoring/health") as never);
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok("status" in body, "liveness status must be present for probes");
  // No host fingerprinting for an anonymous caller.
  const keys = Object.keys(body);
  const allowed = new Set(["status", "setupComplete"]);
  for (const k of keys) {
    assert.ok(allowed.has(k), `anonymous health view leaked field: ${k}`);
  }
});

test("anonymous degraded health GET remains liveness-only when payload construction fails", async () => {
  route.__test_setMonitoringHealthPayloadBuilder(async () => {
    throw new Error("synthetic health payload failure");
  });

  const res = await route.GET(new Request("http://localhost/api/monitoring/health") as never);
  const body = (await res.json()) as Record<string, unknown>;

  assert.equal(res.status, 200);
  assert.deepEqual(body, { status: "degraded" });
  const publicSchema = openapi.components.schemas.PublicHealthResponse;
  assert.equal(publicSchema.additionalProperties, false);
  assert.ok(publicSchema.properties?.status?.enum?.includes(body.status));
  assert.ok(Object.keys(body).every((key) => key in (publicSchema.properties ?? {})));
});

test("management caller receives degraded health details after payload construction fails", async () => {
  route.__test_setMonitoringHealthPayloadBuilder(async () => {
    throw new Error("synthetic health payload failure");
  });
  const sessionReq = (await makeManagementSessionRequest(
    "http://localhost/api/monitoring/health"
  )) as unknown as NextRequest;

  const res = await route.GET(sessionReq as never);
  const body = (await res.json()) as Record<string, unknown>;

  assert.equal(res.status, 200);
  assert.equal(body.status, "degraded");
  assert.ok(Array.isArray(body.providerBreakers));
  assert.ok(body.quotaMonitor && typeof body.quotaMonitor === "object");
  assert.ok(body.sessions && typeof body.sessions === "object");
  assert.ok(body.chatAdmission === null);
  assert.ok(body.callLogArtifacts === null);
  const degradedSchema = openapi.components.schemas.DegradedHealthResponse;
  assert.equal(degradedSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(body).sort(), Object.keys(degradedSchema.properties ?? {}).sort());
});

test("management session sees the full health payload", async () => {
  const sessionReq = (await makeManagementSessionRequest(
    "http://localhost/api/monitoring/health"
  )) as unknown as NextRequest;
  const res = await route.GET(sessionReq as never);
  const body = (await res.json()) as Record<string, unknown>;
  assert.ok(
    Object.keys(body).length > 2,
    "a management caller must still receive the detailed payload"
  );
  const callLogArtifacts = body.callLogArtifacts as Record<string, unknown> | null;
  assert.ok(callLogArtifacts, "management health includes bounded call-log writer metrics");
  assert.deepEqual(Object.keys(callLogArtifacts).sort(), [
    "activeJobs",
    "artifactFootprintLimitBytes",
    "detailOmissionsTotal",
    "diagnosticStubFootprintLimitBytes",
    "diagnosticStubRefusalsTotal",
    "pointerFallbackFailuresTotal",
    "pointerFallbacksTotal",
    "preparationRefusalsAggregateReservationBudgetTotal",
    "preparationRefusalsInvalidEstimateTotal",
    "preparationRefusalsSingleArtifactBudgetTotal",
    "preparationRefusalsTotal",
    "queuedArtifacts",
    "queuedDiagnosticStubs",
    "reservedArtifactBytes",
    "reservedDiagnosticStubBytes",
    "workerFailuresTotal",
    "workerState",
  ]);
  assert.doesNotMatch(
    JSON.stringify(callLogArtifacts),
    /requestId|artifactPath|payload|credential/i
  );
  const chatAdmission = body.chatAdmission as Record<string, unknown> | null;
  assert.ok(
    chatAdmission,
    "management health includes structural and byte-budget admission gauges"
  );
  assert.equal(typeof chatAdmission.byteBudgetWaiting, "number");
  assert.equal(typeof chatAdmission.byteBudgetQueuedBytes, "number");
  assert.equal(typeof chatAdmission.waiting, "number");
  assert.equal(typeof chatAdmission.queuedBytes, "number");
  assert.equal(chatAdmission.byteBudgetWaiting, 0, "test has no ingest-byte admission waiters");
  assert.equal(chatAdmission.byteBudgetQueuedBytes, 0, "test has no queued ingest bytes");
});

/**
 * The local CLI reaches this PUBLIC-classified route with the machine
 * token, which `runAuthzPipeline` converts into the trusted subject stamp below
 * (the raw header is always stripped). The full payload — `version` in
 * particular — is what check:pack-boot asserts on the packed tarball, so pin the
 * stamped contract here.
 */
test("a stamped local-CLI caller receives the full payload including version", async () => {
  const pkgVersion = JSON.parse(
    fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ).version;
  const res = await route.GET(
    new Request("http://localhost/api/monitoring/health", {
      headers: {
        "x-omniroute-auth-kind": "management_key",
        "x-omniroute-auth-label": "local-cli-token",
      },
    }) as never
  );
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 200);
  assert.equal(body.version, pkgVersion);
});
