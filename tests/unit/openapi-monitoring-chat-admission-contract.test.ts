import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

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
