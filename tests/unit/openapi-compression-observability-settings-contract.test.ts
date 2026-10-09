import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omni-openapi-compression-observability-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, any>>;
  components: { schemas: Record<string, any> };
};

const coreDb = await import("../../src/lib/db/core.ts");
const ccMetrics = await import("../../src/lib/db/ccDiscoveryMetrics.ts");
const telemetry = await import("../../src/lib/db/compressionRunTelemetry.ts");
const ccMetricsRoute = await import("../../src/app/api/settings/cc-discovery-metrics/route.ts");
const compressionRulesRoute = await import("../../src/app/api/settings/compression/rules/route.ts");
const compressionTelemetryRoute =
  await import("../../src/app/api/settings/compression/run-telemetry/route.ts");

function operation(path: string, method: string): Record<string, any> {
  const result = spec.paths[path]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${path}`);
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

test("Claude Code discovery alias metrics match their live aggregated counters", async () => {
  ccMetrics.incrementCcAliasRequestCount("openai/gpt-6.1-sol");
  ccMetrics.incrementCcAliasRequestCount("openai/gpt-6.1-sol");
  ccMetrics.incrementCcDiscoveryHitCount();

  const response = await ccMetricsRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/settings/cc-discovery-metrics")
  );
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    aliasRequests: 2,
    discoveryHits: 1,
    byModel: { "openai/gpt-6.1-sol": 2 },
  });
  assert.equal(
    operation("/api/settings/cc-discovery-metrics", "get").responses["200"].content[
      "application/json"
    ].schema.$ref,
    "#/components/schemas/CcDiscoveryMetricsResponse"
  );
});

test("compression rules alias and run telemetry report their documented helper outputs", async () => {
  const rulesResponse = await compressionRulesRoute.GET(
    await makeManagementSessionRequest("http://localhost/api/settings/compression/rules")
  );
  const rulesBody = await rulesResponse.json();
  assert.equal(rulesResponse.status, 200);
  assert.deepEqual(Object.keys(rulesBody), ["rules"]);
  assert.ok(Array.isArray(rulesBody.rules));
  assert.equal(
    operation("/api/settings/compression/rules", "get").responses["200"].content["application/json"]
      .schema.$ref,
    "#/components/schemas/CompressionRuleListResponse"
  );

  telemetry.insertCompressionRunTelemetryRow({
    requestId: "openapi-telemetry-test",
    model: "gpt-test",
    provider: "openai",
    source: "unit-test",
    tokensBefore: 180,
    tokensAfter: 80,
    ratio: 0.45,
    outputStyles: [{ id: "trim-repeated", level: "lite" }],
    outputTokens: 12,
  });
  const telemetryResponse = await compressionTelemetryRoute.GET(
    new Request("http://localhost/api/settings/compression/run-telemetry", {
      headers: await (
        await makeManagementSessionRequest(
          "http://localhost/api/settings/compression/run-telemetry"
        )
      ).headers,
    }) as never
  );
  const telemetryBody = await telemetryResponse.json();
  assert.equal(telemetryResponse.status, 200);
  assert.equal(telemetryBody.totalRuns, 1);
  assert.equal(telemetryBody.totalTokensSaved, 100);
  assert.equal(telemetryBody.runsWithStyles, 1);
  assert.equal(telemetryBody.appliedStyleCounts["trim-repeated"], 1);
  assert.deepEqual(
    Object.keys(telemetryBody).sort(),
    Object.keys(spec.components.schemas.CompressionRunTelemetrySummary.properties).sort()
  );
});

test("compression observability settings routes declare their real conditional auth and status codes", () => {
  for (const [path, method] of [
    ["/api/settings/cc-discovery-metrics", "get"],
    ["/api/settings/compression/rules", "get"],
    ["/api/settings/compression/run-telemetry", "get"],
  ] as const) {
    const op = operation(path, method);
    assert.ok(op.security?.some((entry: object) => Object.hasOwn(entry, "BearerAuth")));
    assert.ok(op.security?.some((entry: object) => Object.hasOwn(entry, "ManagementSessionAuth")));
    assert.ok(op.security?.some((entry: object) => Object.keys(entry).length === 0));
    assert.ok(op.responses["401"]);
    assert.ok(op.responses["403"]);
    assert.ok(op.responses["503"]);
  }
});
