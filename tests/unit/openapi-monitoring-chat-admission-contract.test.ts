import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { buildHealthPayload } from "../../src/lib/monitoring/observability.ts";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;

test("authenticated monitoring health specifies separate ingest-byte queue gauges", () => {
  const operation = spec.paths?.["/api/monitoring/health"]?.get;
  assert.ok(operation, "GET /api/monitoring/health must be documented");
  const response = operation.responses?.["200"]?.content?.["application/json"]?.schema;
  assert.equal(response?.$ref, "#/components/schemas/MonitoringHealthResponse");

  const monitoring = spec.components.schemas.MonitoringHealthResponse;
  const authView = monitoring.oneOf.find(
    (entry: Record<string, unknown>) =>
      entry.$ref === "#/components/schemas/AuthenticatedSystemHealthResponse"
  );
  assert.ok(authView, "the health response union must include its management view");

  const authenticated = spec.components.schemas.AuthenticatedSystemHealthResponse;
  assert.ok(authenticated.required.includes("chatAdmission"));
  const admission = authenticated.properties.chatAdmission;
  assert.ok(admission.oneOf.some((entry: Record<string, unknown>) => entry.type === "null"));
  assert.ok(
    admission.oneOf.some(
      (entry: Record<string, unknown>) =>
        entry.$ref === "#/components/schemas/ChatAdmissionHealthSummary"
    )
  );

  assert.ok(authenticated.required.includes("callLogArtifacts"));
  const writerProperty = authenticated.properties.callLogArtifacts;
  assert.ok(writerProperty.oneOf.some((entry: Record<string, unknown>) => entry.type === "null"));
  assert.ok(
    writerProperty.oneOf.some(
      (entry: Record<string, unknown>) =>
        entry.$ref === "#/components/schemas/CallLogArtifactWriterSnapshot"
    )
  );
  const writer = spec.components.schemas.CallLogArtifactWriterSnapshot;
  for (const field of [
    "preparationRefusalsInvalidEstimateTotal",
    "preparationRefusalsSingleArtifactBudgetTotal",
    "preparationRefusalsAggregateReservationBudgetTotal",
  ]) {
    assert.ok(writer.required.includes(field), `missing required writer counter ${field}`);
    assert.equal(writer.properties[field]?.type, "integer");
    assert.equal(writer.properties[field]?.minimum, 0);
  }

  const summary = spec.components.schemas.ChatAdmissionHealthSummary;
  for (const field of [
    "activeHeavy",
    "activeHealthyHeadroom",
    "waiting",
    "queuedBytes",
    "shedTotal",
    "shedsByReason",
    "lanes",
    "inflightBytes",
    "byteBudgetQueuedBytes",
    "byteBudgetWaiting",
    "maxInflightBytes",
    "budgetSource",
    "pressureSeverity",
    "countCapEnabled",
  ]) {
    assert.ok(summary.required.includes(field), `missing required admission field ${field}`);
    assert.ok(summary.properties[field], `missing admission schema for ${field}`);
  }
  assert.match(summary.properties.waiting.description, /structural-gate waiters only/i);
  assert.match(summary.properties.queuedBytes.description, /aggregate byte charge/i);
  assert.equal(spec.components.schemas.PublicHealthResponse.properties.chatAdmission, undefined);
});

test("monitoring health OpenAPI contract mirrors the public artifact", () => {
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});

test("health contract separates public degraded liveness from management diagnostics", () => {
  const publicHealth = spec.components.schemas.PublicHealthResponse;
  assert.deepEqual(publicHealth.properties.status.enum, ["healthy", "degraded", "unknown"]);
  assert.equal(publicHealth.additionalProperties, false);

  const degraded = spec.components.schemas.DegradedHealthResponse;
  assert.equal(degraded.additionalProperties, false);
  assert.match(degraded.description, /management-authenticated/i);
  for (const field of [
    "providerBreakers",
    "providerHealth",
    "rateLimitStatus",
    "learnedLimits",
    "lockouts",
    "quotaMonitor",
    "sessions",
    "adaptiveAdmission",
    "chatAdmission",
    "callLogArtifacts",
    "dedup",
  ]) {
    assert.ok(degraded.required.includes(field), `degraded management response omits ${field}`);
    assert.ok(degraded.properties[field], `degraded management response does not declare ${field}`);
  }
});

test("authenticated health schema declares every serialized implementation field", () => {
  const payload = JSON.parse(
    JSON.stringify(
      buildHealthPayload({
        appVersion: "test",
        buildSha: "0123456789abcdef0123456789abcdef01234567",
        catalogCount: 1,
        settings: { setupComplete: true },
        connections: [],
        circuitBreakers: [],
        rateLimitStatus: {},
        learnedLimits: {},
        lockouts: [],
        localProviders: {},
        inflightRequests: 0,
        quotaMonitorSummary: {
          active: 0,
          alerting: 0,
          exhausted: 0,
          errors: 0,
          statusCounts: {
            starting: 0,
            idle: 0,
            healthy: 0,
            warning: 0,
            exhausted: 0,
            error: 0,
          },
          byProvider: {},
        },
        quotaMonitorMonitors: [],
        activeSessions: [],
        activeSessionsByKey: {},
        credentialHealth: { total: 0, healthy: 0, failed: 0, unknown: 0, stale: 0 },
      })
    )
  ) as Record<string, unknown>;

  const schema = spec.components.schemas.AuthenticatedSystemHealthResponse;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(payload).sort(),
    Object.keys(schema.properties).sort(),
    "the authenticated health schema must enumerate the complete serialized payload"
  );

  const system = payload.system as Record<string, unknown>;
  const systemSchema = schema.properties.system;
  assert.equal(systemSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(system).sort(), Object.keys(systemSchema.properties).sort());

  const pressureSchema = spec.components.schemas.RuntimeMemoryPressureSnapshot;
  assert.deepEqual(pressureSchema.required, [
    "heapPressureThresholdMb",
    "psiSource",
    "state",
    "sampleAgeMs",
    "signals",
  ]);
  assert.deepEqual(Object.keys(pressureSchema.properties).sort(), [
    "heapPressureThresholdMb",
    "psiSource",
    "sampleAgeMs",
    "signals",
    "state",
  ]);
});
