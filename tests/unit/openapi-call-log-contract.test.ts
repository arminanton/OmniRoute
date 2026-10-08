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
  properties?: Record<string, OpenApiSchema>;
};
const spec = yaml.load(fs.readFileSync(specPath, "utf8")) as {
  paths: Record<
    string,
    Record<
      string,
      {
        responses?: Record<string, { content?: Record<string, { schema?: OpenApiSchema }> }>;
      }
    >
  >;
  components: { schemas: Record<string, OpenApiSchema> };
};

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
