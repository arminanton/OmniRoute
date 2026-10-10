import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

process.env.REQUIRE_API_KEY = "false";
delete process.env.OMNIROUTE_OTEL_ENDPOINT;
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const route = await import("../../../../src/app/api/v1/explain/routing/route.ts");
const routing = await import("../../../../open-sse/services/routing/index.ts");
const canonicalText = fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(process.cwd(), "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as any;

test.after(() => {
  routing.resetRoutingObservability();
});

test("routing explain response and OpenAPI schema expose the same bounded telemetry contract", async () => {
  routing.resetRoutingObservability();
  const event = routing.createRoutingEvent({
    requestId: "route-explain-test",
    provider: "openai",
    model: "gpt-test",
    strategy: "direct",
    latencyMs: 125,
    ttftMs: 30,
    itlMs: null,
    inputTokens: 4,
    outputTokens: 2,
    cost: 0.001,
    retries: 1,
    fallbackUsed: false,
    outcome: "success",
    status: 200,
    finishReason: "stop",
    connectionId: "connection-test",
    ts: Date.now(),
  });
  routing.emitRoutingEvent(event);

  const response = await route.GET(
    new Request("http://omniroute.local/api/v1/explain/routing?limit=1")
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = (await response.json()) as Record<string, any>;
  assert.deepEqual(Object.keys(body).sort(), [
    "events",
    "object",
    "otel",
    "otelEnabled",
    "quality",
    "sinks",
  ]);
  assert.equal(body.object, "routing_explain");
  assert.equal(body.otelEnabled, false);
  assert.equal(body.otel, null);
  assert.deepEqual(body.events, [event]);
  assert.deepEqual(Object.keys(body.events[0]).sort(), [
    "connectionId",
    "cost",
    "fallbackUsed",
    "finishReason",
    "inputTokens",
    "itlMs",
    "latencyMs",
    "model",
    "outcome",
    "outputTokens",
    "provider",
    "requestId",
    "retries",
    "status",
    "strategy",
    "ts",
    "ttftMs",
  ]);

  assert.equal(body.quality.length, 1);
  const quality = body.quality[0];
  assert.equal(quality.classification, "warming");
  assert.equal(quality.samples, 1);
  assert.deepEqual(Object.keys(quality).sort(), [
    "anomalies",
    "classification",
    "confidence",
    "lastTs",
    "latencyEwmaMs",
    "model",
    "operational",
    "provider",
    "rateLimited",
    "recencyMs",
    "samples",
    "semantic",
    "semanticConfidence",
    "successEwma",
    "ttftEwmaMs",
  ]);

  const operation = spec.paths["/api/v1/explain/routing"]?.get;
  assert.ok(operation, "missing GET /api/v1/explain/routing");
  assert.equal(
    operation.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/V1RoutingExplainResponse"
  );
  const responseSchema = spec.components.schemas.V1RoutingExplainResponse;
  assert.deepEqual(responseSchema.required, [
    "object",
    "sinks",
    "otelEnabled",
    "events",
    "quality",
    "otel",
  ]);
  assert.equal(responseSchema.properties.events.items.$ref, "#/components/schemas/V1RoutingEvent");
  assert.equal(
    responseSchema.properties.quality.items.$ref,
    "#/components/schemas/V1RoutingQuality"
  );
  assert.deepEqual(
    spec.components.schemas.V1RoutingEvent.required.slice().sort(),
    Object.keys(event).sort()
  );
  assert.deepEqual(
    spec.components.schemas.V1RoutingQuality.required.slice().sort(),
    Object.keys(quality).sort()
  );
  assert.equal(
    responseSchema.properties.otel.oneOf[0].$ref,
    "#/components/schemas/V1RoutingOtelStats"
  );
  assert.equal(responseSchema.properties.otel.oneOf[1].type, "null");
  assert.equal(publicText, canonicalText);
});

test("routing explain includes the full OTel stats returned by the local sink", async () => {
  const originalEndpoint = process.env.OMNIROUTE_OTEL_ENDPOINT;
  const originalExporterEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const originalFetch = globalThis.fetch;
  let fakeCollectorRequests = 0;
  process.env.OMNIROUTE_OTEL_ENDPOINT = "http://otel.test.invalid";
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  globalThis.fetch = async () => {
    fakeCollectorRequests += 1;
    return new Response(null, { status: 200 });
  };

  try {
    routing.resetRoutingObservability();
    routing.emitRoutingEvent(
      routing.createRoutingEvent({
        requestId: "otel-stats-route-test",
        provider: "openai",
        model: "gpt-test",
        latencyMs: 25,
        outcome: "success",
      })
    );
    const response = await route.GET(new Request("http://omniroute.local/api/v1/explain/routing"));
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.otelEnabled, true);
    assert.deepEqual(Object.keys(body.otel).sort(), [
      "buffered",
      "consecutiveFailures",
      "dropped",
      "flushedBatches",
    ]);
    assert.deepEqual(spec.components.schemas.V1RoutingOtelStats.required, [
      "buffered",
      "dropped",
      "consecutiveFailures",
      "flushedBatches",
    ]);
    assert.equal(body.otel.buffered, 1);
    assert.equal(body.otel.dropped, 0);
    assert.equal(body.otel.consecutiveFailures, 0);
    assert.equal(body.otel.flushedBatches, 0);
  } finally {
    routing.resetRoutingObservability();
    globalThis.fetch = originalFetch;
    if (originalEndpoint === undefined) delete process.env.OMNIROUTE_OTEL_ENDPOINT;
    else process.env.OMNIROUTE_OTEL_ENDPOINT = originalEndpoint;
    if (originalExporterEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalExporterEndpoint;
  }

  assert.equal(fakeCollectorRequests, 1, "the injected fetch stub handles the local OTel flush");
});
