import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const specPath = path.join(process.cwd(), "docs", "openapi.yaml");
type OpenApiSchema = {
  $ref?: string;
  const?: string;
  enum?: unknown[];
  type?: string | string[];
  additionalProperties?: boolean;
  properties?: Record<string, OpenApiSchema>;
};
const spec = yaml.load(fs.readFileSync(specPath, "utf8")) as {
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: Array<{
          name?: string;
          description?: string;
          schema?: { minLength?: number };
        }>;
        responses?: Record<string, { content?: Record<string, { schema?: OpenApiSchema }> }>;
      }
    >
  >;
  components: { schemas: Record<string, OpenApiSchema> };
};

test("call-log list combo parameter is a combo-only flag", () => {
  const parameters = spec.paths["/api/usage/call-logs"]?.get?.parameters ?? [];
  const combo = parameters.find((parameter) => parameter.name === "combo");
  assert.ok(combo, "combo query parameter should be documented");
  assert.equal(combo.schema?.minLength, 1);
  assert.match(
    combo.description ?? "",
    /non-empty value selects only requests assigned to a combo/i
  );
});

test("call-log summary documents nullable SQLite fields and parsed summary payloads", () => {
  const summary = spec.components.schemas.CallLogSummary;
  assert.ok(summary, "CallLogSummary component should exist");
  assert.deepEqual(summary.properties?.method?.type, ["string", "null"]);
  assert.deepEqual(summary.properties?.path?.type, ["string", "null"]);
  assert.deepEqual(summary.properties?.model?.type, ["string", "null"]);
  assert.deepEqual(summary.properties?.requestSummary?.type, ["object", "null"]);
  assert.equal(summary.properties?.tokens?.additionalProperties, false);
  for (const jsonType of ["string", "object", "array", "number", "boolean", "null"]) {
    assert.ok(
      (summary.properties?.error?.type as string[] | undefined)?.includes(jsonType),
      `call-log error schema must allow ${jsonType}`
    );
  }
});

test("call-log detail OpenAPI exposes the persisted diagnostic and transport shape", () => {
  const operation = spec.paths["/api/usage/call-logs/{id}"]?.get;
  const detailRef = operation?.responses?.["200"]?.content?.["application/json"]?.schema?.$ref;
  assert.equal(detailRef, "#/components/schemas/CallLogDetailResponse");

  const properties = spec.components.schemas.CallLogPipelinePayloads?.properties;
  assert.ok(properties, "CallLogPipelinePayloads component should exist");
  for (const field of [
    "diagnosticOverflow",
    "diagnosticOverflowOnly",
    "transportTelemetry",
    "routeDecision",
    "clientRawRequest",
    "openaiRequest",
    "providerRequest",
    "providerResponse",
    "clientResponse",
    "providerAttemptDiagnostics",
    "providerAttemptDiagnosticsDropped",
    "error",
    "toolLoop",
    "streamChunks",
  ]) {
    assert.ok(properties[field], `pipeline property ${field} should be documented`);
  }

  assert.equal(properties.transportTelemetry?.$ref, "#/components/schemas/TransportTelemetry");
  assert.deepEqual(Object.keys(properties.streamChunks?.properties ?? {}).sort(), [
    "client",
    "openai",
    "provider",
  ]);
  assert.equal(
    spec.components.schemas.TransportTelemetry.properties?.schema?.const,
    "omni-transport-telemetry/v1"
  );
  assert.equal(
    spec.components.schemas.TransportAttemptTelemetry.properties?.transport?.enum?.includes(
      "websocket"
    ),
    true
  );
});
