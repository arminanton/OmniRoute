import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const ROOT = process.cwd();
const spec = yaml.load(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};
const metricsRouteSource = fs.readFileSync(
  path.join(ROOT, "src/app/api/provider-metrics/route.ts"),
  "utf8"
);
const statsRouteSource = fs.readFileSync(
  path.join(ROOT, "src/app/api/provider-stats/route.ts"),
  "utf8"
);
const callLogStatsSource = fs.readFileSync(path.join(ROOT, "src/lib/db/callLogStats.ts"), "utf8");
const providerStatsSource = fs.readFileSync(path.join(ROOT, "src/lib/db/providerStats.ts"), "utf8");
const comboMetricsSource = fs.readFileSync(
  path.join(ROOT, "open-sse/services/comboMetrics.ts"),
  "utf8"
);
const telemetrySource = fs.readFileSync(
  path.join(ROOT, "src/shared/utils/requestTelemetry.ts"),
  "utf8"
);
const toolLatencySource = fs.readFileSync(
  path.join(ROOT, "open-sse/services/toolLatencyTracker.ts"),
  "utf8"
);

function responseSchema(route: string) {
  const schema = spec.paths[route]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
  assert.ok(schema, `missing JSON 200 schema for GET ${route}`);
  return schema;
}

test("provider metrics 200 documents metric nullability and topology", () => {
  assert.equal(
    responseSchema("/api/provider-metrics").$ref,
    "#/components/schemas/ProviderMetricsResponse"
  );

  const response = spec.components.schemas.ProviderMetricsResponse;
  assert.deepEqual(response.required, ["metrics", "topology"]);
  assert.deepEqual(response.properties.metrics.additionalProperties, {
    $ref: "#/components/schemas/ProviderMetricsProviderSummary",
  });
  assert.equal(response.properties.topology.$ref, "#/components/schemas/ProviderMetricsTopology");
  assert.equal(response.additionalProperties, false);

  const metric = spec.components.schemas.ProviderMetricsProviderSummary;
  assert.deepEqual(metric.required, [
    "totalRequests",
    "totalSuccesses",
    "successRate",
    "avgLatencyMs",
    "lastRequestAt",
    "lastErrorAt",
    "lastStatus",
    "lastErrorStatus",
  ]);
  assert.deepEqual(metric.properties.avgLatencyMs.type, ["number", "null"]);
  assert.deepEqual(metric.properties.lastRequestAt.type, ["string", "null"]);
  assert.deepEqual(metric.properties.lastErrorAt.type, ["string", "null"]);
  assert.deepEqual(metric.properties.lastStatus.type, ["integer", "null"]);
  assert.deepEqual(metric.properties.lastErrorStatus.type, ["integer", "null"]);

  const topology = spec.components.schemas.ProviderMetricsTopology;
  assert.deepEqual(topology.required, ["providers", "lastProvider", "errorProvider"]);
  assert.equal(topology.properties.providers.items.type, "string");
  assert.equal(topology.properties.lastProvider.type, "string");
  assert.equal(topology.properties.errorProvider.type, "string");

  assert.match(callLogStatsSource, /export interface ProviderMetricRow/);
  for (const field of [
    "provider: string",
    "totalRequests: number",
    "totalSuccesses: number",
    "avgLatencyMs: number | null",
    "lastRequestAt: string | null",
    "lastErrorAt: string | null",
    "lastStatus: number | null",
    "lastErrorStatus: number | null",
  ]) {
    assert.ok(callLogStatsSource.includes(field), `ProviderMetricRow is missing ${field}`);
  }
  assert.match(metricsRouteSource, /successRate: totalRequests > 0/);
  assert.match(metricsRouteSource, /providers: Object\.keys\(metrics\)/);
  assert.match(metricsRouteSource, /lastProvider,/);
  assert.match(metricsRouteSource, /errorProvider,/);
});

test("provider stats 200 types DB rows and in-memory metric sections", () => {
  assert.equal(
    responseSchema("/api/provider-stats").$ref,
    "#/components/schemas/ProviderStatsResponse"
  );

  const response = spec.components.schemas.ProviderStatsResponse;
  assert.deepEqual(response.required, [
    "providers",
    "models",
    "comboMetrics",
    "telemetry",
    "toolLatency",
  ]);
  assert.equal(
    response.properties.providers.items.$ref,
    "#/components/schemas/ProviderStatsProviderRow"
  );
  assert.equal(response.properties.models.items.$ref, "#/components/schemas/ProviderStatsModelRow");
  assert.equal(response.properties.additionalProperties, undefined);
  assert.deepEqual(response.properties.comboMetrics.additionalProperties.oneOf, [
    { $ref: "#/components/schemas/ProviderStatsComboMetrics" },
    { type: "null" },
  ]);
  assert.deepEqual(response.properties.telemetry.oneOf, [
    { $ref: "#/components/schemas/ProviderStatsTelemetrySummary" },
    { $ref: "#/components/schemas/ProviderStatsTelemetryEmpty" },
  ]);
  assert.equal(
    response.properties.toolLatency.additionalProperties.$ref,
    "#/components/schemas/ProviderStatsToolLatency"
  );
  assert.equal(response.additionalProperties, false);

  const provider = spec.components.schemas.ProviderStatsProviderRow;
  assert.deepEqual(provider.required, [
    "provider",
    "nodeName",
    "totalRequests",
    "successfulRequests",
    "avgLatencyMs",
    "totalTokensIn",
    "totalTokensOut",
  ]);
  assert.deepEqual(provider.properties.nodeName.type, ["string", "null"]);
  assert.deepEqual(provider.properties.avgLatencyMs.type, ["number", "null"]);
  assert.deepEqual(provider.properties.totalTokensIn.type, ["number", "null"]);
  assert.deepEqual(provider.properties.totalTokensOut.type, ["number", "null"]);

  const model = spec.components.schemas.ProviderStatsModelRow;
  assert.deepEqual(model.required, [
    "provider",
    "nodeName",
    "model",
    "requests",
    "avgLatencyMs",
    "successfulRequests",
  ]);
  assert.deepEqual(model.properties.nodeName.type, ["string", "null"]);
  assert.deepEqual(model.properties.avgLatencyMs.type, ["number", "null"]);

  const combo = spec.components.schemas.ProviderStatsComboMetrics;
  assert.deepEqual(combo.required, [
    "totalRequests",
    "totalSuccesses",
    "totalFailures",
    "totalFallbacks",
    "totalLatencyMs",
    "strategy",
    "lastUsedAt",
    "intentCounts",
    "byModel",
    "byTarget",
    "productionTraffic",
    "avgLatencyMs",
    "successRate",
    "fallbackRate",
    "shadow",
  ]);
  assert.equal(
    combo.properties.byModel.additionalProperties.$ref,
    "#/components/schemas/ProviderStatsComboModelMetrics"
  );
  assert.equal(
    combo.properties.byTarget.additionalProperties.$ref,
    "#/components/schemas/ProviderStatsComboTargetMetrics"
  );
  assert.equal(
    combo.properties.shadow.$ref,
    "#/components/schemas/ProviderStatsComboShadowMetrics"
  );
  assert.equal(combo.properties.successRate.maximum, 100);
  assert.equal(combo.properties.fallbackRate.maximum, 100);
  assert.equal(combo.properties.avgLatencyMs.type, "integer");

  const comboShadow = spec.components.schemas.ProviderStatsComboShadowMetrics;
  assert.deepEqual(comboShadow.required, [
    "totalRequests",
    "totalSuccesses",
    "totalFailures",
    "totalLatencyMs",
    "lastUsedAt",
    "byModel",
    "byTarget",
    "avgLatencyMs",
    "successRate",
  ]);
  assert.equal(comboShadow.properties.avgLatencyMs.type, "integer");

  const comboModel = spec.components.schemas.ProviderStatsComboModelMetrics;
  assert.deepEqual(comboModel.required, [
    "requests",
    "successes",
    "failures",
    "totalLatencyMs",
    "lastStatus",
    "lastUsedAt",
    "avgLatencyMs",
    "successRate",
  ]);
  assert.deepEqual(comboModel.properties.lastStatus.type, ["string", "null"]);
  assert.deepEqual(comboModel.properties.lastUsedAt.type, ["string", "null"]);
  assert.equal(comboModel.properties.avgLatencyMs.type, "integer");

  const comboTarget = spec.components.schemas.ProviderStatsComboTargetMetrics;
  assert.deepEqual(comboTarget.required, [
    "executionKey",
    "stepId",
    "model",
    "provider",
    "providerId",
    "connectionId",
    "label",
    "requests",
    "successes",
    "failures",
    "totalLatencyMs",
    "lastStatus",
    "lastUsedAt",
    "avgLatencyMs",
    "successRate",
  ]);
  for (const field of ["stepId", "provider", "providerId", "connectionId", "label"]) {
    assert.deepEqual(comboTarget.properties[field].type, ["string", "null"]);
  }
  assert.equal(comboTarget.properties.avgLatencyMs.type, "integer");

  const telemetry = spec.components.schemas.ProviderStatsTelemetrySummary;
  assert.deepEqual(telemetry.required, ["count", "avg", "p50", "p95", "p99", "phaseBreakdown"]);
  assert.deepEqual(Object.keys(telemetry.properties.phaseBreakdown.properties).sort(), [
    "finalize",
    "parse",
    "policy",
    "provider_wait",
    "resolve",
    "stream",
    "validate",
  ]);
  assert.equal(telemetry.properties.phaseBreakdown.additionalProperties, false);
  const telemetryPhase = spec.components.schemas.ProviderStatsTelemetryPhase;
  assert.deepEqual(telemetryPhase.required, ["count", "p50", "p95", "avg"]);
  assert.equal(spec.components.schemas.ProviderStatsTelemetryEmpty.maxProperties, 0);
  assert.equal(spec.components.schemas.ProviderStatsTelemetryEmpty.additionalProperties, false);

  const toolLatency = spec.components.schemas.ProviderStatsToolLatency;
  assert.deepEqual(toolLatency.required, [
    "avgTtftAfterToolMs",
    "avgGapAfterToolMs",
    "measurementCount",
  ]);
  assert.equal(toolLatency.properties.avgTtftAfterToolMs.type, "integer");
  assert.equal(toolLatency.properties.avgGapAfterToolMs.type, "integer");
  assert.equal(toolLatency.additionalProperties, false);

  assert.match(providerStatsSource, /export interface ProviderCallStat/);
  assert.match(providerStatsSource, /export interface ModelCallStat/);
  for (const field of [
    "provider: string",
    "nodeName: string | null",
    "totalRequests: number",
    "successfulRequests: number",
    "totalTokensIn: number | null",
    "totalTokensOut: number | null",
    "model: string",
    "requests: number",
  ]) {
    assert.ok(providerStatsSource.includes(field), `provider stats DB types are missing ${field}`);
  }
  assert.match(comboMetricsSource, /interface ComboMetricsView extends ComboMetricsEntry/);
  assert.match(comboMetricsSource, /interface ComboTargetMetricsView extends ComboTargetMetrics/);
  assert.match(comboMetricsSource, /Record<string, ComboMetricsView \| null>/);
  assert.match(statsRouteSource, /const providerStats = getProviderCallStats\(\)/);
  assert.match(statsRouteSource, /const modelStats = getModelCallStats\(\)/);
  assert.match(statsRouteSource, /resolveName\(p\.provider, p\.nodeName\)/);
  assert.match(statsRouteSource, /resolveName\(m\.provider, m\.nodeName\)/);
  for (const phase of [
    "parse",
    "validate",
    "policy",
    "resolve",
    "provider_wait",
    "stream",
    "finalize",
  ]) {
    assert.ok(telemetrySource.includes(`"${phase}"`), `request telemetry is missing ${phase}`);
  }
  assert.match(telemetrySource, /p99: percentile\(totals, 99\)/);
  assert.match(
    telemetrySource,
    /return \{ count: 0, avg: 0, p50: 0, p95: 0, p99: 0, phaseBreakdown: \{\} \}/
  );
  assert.match(toolLatencySource, /avgTtftAfterToolMs: number/);
  assert.match(toolLatencySource, /avgGapAfterToolMs: number/);
  assert.match(toolLatencySource, /measurementCount: number/);
  assert.match(
    statsRouteSource,
    /return NextResponse\.json\(\{ providers, models, comboMetrics, telemetry, toolLatency \}\)/
  );
  assert.match(statsRouteSource, /let comboMetrics: Record<string, unknown> = \{\}/);
  assert.match(statsRouteSource, /let telemetry: Record<string, unknown> = \{\}/);
  assert.match(statsRouteSource, /let toolLatency: Record<string, unknown> = \{\}/);
});
