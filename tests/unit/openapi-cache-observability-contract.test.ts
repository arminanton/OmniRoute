import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { LRUCache } from "../../src/lib/cacheLayer.ts";
import { getCacheStats, getMemoryCacheStats } from "../../src/lib/semanticCache.ts";
import { getIdempotencyStats } from "../../src/lib/idempotencyLayer.ts";
import { getCacheMetrics, getCacheTrend } from "../../src/lib/db/settings/cacheMetrics.ts";
import { getMemoStats } from "../../open-sse/services/compression/resultMemo.ts";

type Schema = {
  $ref?: string;
  type?: string | string[];
  pattern?: string;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  additionalProperties?: boolean | Schema;
};

type Operation = {
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: Schema;
  }>;
  responses?: Record<
    string,
    {
      headers?: Record<string, { schema?: Schema }>;
      content?: Record<string, { schema?: Schema }>;
    }
  >;
};

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Schema> };
};

function operation(pathTemplate: string, method: string): Operation {
  const result = spec.paths[pathTemplate]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${pathTemplate}`);
  return result;
}

function success(pathTemplate: string, method: string, status = "200"): Schema {
  const schema = operation(pathTemplate, method).responses?.[status]?.content?.["application/json"]
    ?.schema;
  assert.ok(schema, `missing ${status} schema for ${method.toUpperCase()} ${pathTemplate}`);
  return schema;
}

function assertConditionalManagementAuth(op: Operation): void {
  const alternatives = op.security ?? [];
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "BearerAuth")));
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
  assert.ok(alternatives.some((entry) => Object.keys(entry).length === 0));
}

test("cache routes declare typed read, eviction, in-memory stats, and cache-memo metrics", async () => {
  for (const [pathTemplate, method] of [
    ["/api/cache", "get"],
    ["/api/cache", "delete"],
    ["/api/cache/stats", "get"],
    ["/api/cache/stats", "delete"],
    ["/api/monitoring/compression", "get"],
  ] as const) {
    assertConditionalManagementAuth(operation(pathTemplate, method));
  }

  assert.equal(success("/api/cache", "get").$ref, "#/components/schemas/CacheOverviewResponse");
  assert.equal(success("/api/cache/stats", "get").$ref, "#/components/schemas/MemoryCacheStats");
  assert.equal(
    success("/api/cache/stats", "delete").$ref,
    "#/components/schemas/MemoryCacheClearResponse"
  );
  assert.equal(
    success("/api/monitoring/compression", "get").$ref,
    "#/components/schemas/CompressionMemoMonitoringResponse"
  );
  assert.equal(
    operation("/api/monitoring/compression", "get").responses?.["200"]?.headers?.["Cache-Control"]
      ?.schema?.const,
    "no-store, no-cache, must-revalidate"
  );

  const trendHours = operation("/api/cache", "get").parameters?.find(
    (parameter) => parameter.name === "trendHours"
  );
  assert.equal(trendHours?.schema?.default, "24");
  assert.match(operation("/api/cache", "get").description ?? "", /clamped to 1–720/);
});

test("cache response schemas match the live cache, history, idempotency, and memo objects", async () => {
  const semantic = getCacheStats();
  const memory = getMemoryCacheStats();
  const prompt = await getCacheMetrics();
  const trend = await getCacheTrend(24);
  const idempotency = await getIdempotencyStats();
  const memo = getMemoStats();

  assert.deepEqual(
    Object.keys(semantic).sort(),
    Object.keys(spec.components.schemas.CacheSemanticStats.properties ?? {}).sort()
  );
  assert.deepEqual(
    Object.keys(memory).sort(),
    Object.keys(spec.components.schemas.MemoryCacheStats.properties ?? {}).sort()
  );
  assert.deepEqual(
    Object.keys(prompt).sort(),
    Object.keys(spec.components.schemas.CachePromptMetrics.properties ?? {}).sort()
  );
  assert.deepEqual(
    Object.keys(
      trend[0] ?? {
        timestamp: "",
        requests: 0,
        cachedRequests: 0,
        inputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      }
    ).sort(),
    Object.keys(spec.components.schemas.CacheTrendPoint.properties ?? {}).sort()
  );
  assert.deepEqual(
    Object.keys(idempotency).sort(),
    Object.keys(spec.components.schemas.IdempotencyCacheStats.properties ?? {}).sort()
  );
  assert.deepEqual(
    Object.keys(memo).sort(),
    Object.keys(spec.components.schemas.CompressionMemoStats.properties ?? {}).sort()
  );
  assert.deepEqual(
    Object.keys(new LRUCache().getStats()).sort(),
    Object.keys(spec.components.schemas.MemoryCacheStats.properties ?? {}).sort()
  );
  assert.deepEqual(Object.keys(memo.windows).sort(), ["1h", "1m", "15m", "5m"].sort());
});

test("cache invalidation is mutually exclusive and documents every result scope", () => {
  const remove = operation("/api/cache", "delete");
  const parameters = remove.parameters ?? [];
  assert.deepEqual(parameters.map((parameter) => parameter.name).sort(), [
    "model",
    "signature",
    "staleMs",
  ]);
  const response = spec.components.schemas.CacheInvalidationResponse;
  const scopes = (response.oneOf ?? []).map((variant) => variant.properties?.scope.const).sort();
  assert.deepEqual(scopes, ["all", "model", "signature", "stale"]);
  assert.equal(
    parameters.find((parameter) => parameter.name === "staleMs")?.schema?.type,
    "string"
  );
});
