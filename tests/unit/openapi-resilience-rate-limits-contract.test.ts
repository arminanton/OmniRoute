import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { toggleRateLimitSchema } from "../../src/shared/validation/schemas/misc.ts";
import {
  legacyResilienceProfileSchema,
  requestQueueSettingsSchema,
  updateResilienceSchema,
} from "../../src/shared/validation/schemas/settings.ts";
import {
  DEFAULT_RESILIENCE_SETTINGS,
  mergeResilienceSettings,
} from "../../src/lib/resilience/settings.ts";

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  additionalProperties?: boolean | Schema;
  allOf?: Schema[];
  minimum?: number;
  maximum?: number;
  minProperties?: number;
  minLength?: number;
  format?: string;
};

type Operation = {
  deprecated?: boolean;
  description?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<
    string,
    {
      $ref?: string;
      headers?: Record<string, { required?: boolean; schema?: Schema }>;
      content?: Record<string, { schema?: Schema }>;
    }
  >;
  [key: string]: unknown;
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
  assert.ok(schema, `missing ${status} body schema for ${method.toUpperCase()} ${pathTemplate}`);
  return schema;
}

function assertConditionalManagementAuth(op: Operation): void {
  const alternatives = op.security ?? [];
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "BearerAuth")));
  assert.ok(alternatives.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
  assert.ok(alternatives.some((entry) => Object.keys(entry).length === 0));
}

test("resilience PATCH keys and request-queue bounds match their strict Zod schemas", () => {
  const patch = spec.components.schemas.ResilienceSettingsUpdate;
  assert.deepEqual(
    Object.keys(patch.properties ?? {}).sort(),
    Object.keys(updateResilienceSchema.shape).sort()
  );
  assert.equal(patch.additionalProperties, false);
  assert.equal(patch.minProperties, 1);

  const queue = spec.components.schemas.ResilienceRequestQueuePatch;
  assert.deepEqual(
    Object.keys(queue.properties ?? {}).sort(),
    Object.keys(requestQueueSettingsSchema.shape).sort()
  );
  assert.equal(queue.properties?.globalConcurrentRequests.minimum, 0);
  assert.equal(queue.properties?.globalConcurrentRequests.maximum, 100000);
  assert.equal(
    updateResilienceSchema.safeParse({
      requestQueue: {
        globalConcurrentRequests: 32,
        maxQueueDepth: 0,
      },
    }).success,
    true
  );
  assert.equal(
    updateResilienceSchema.safeParse({ requestQueue: { globalConcurrentRequests: 100001 } })
      .success,
    false
  );

  const merged = mergeResilienceSettings(DEFAULT_RESILIENCE_SETTINGS, {
    requestQueue: { globalConcurrentRequests: 32 },
  });
  assert.equal(merged.requestQueue.globalConcurrentRequests, 32);
  const legacyUpdate = spec.components.schemas.ResilienceLegacyProfileUpdate;
  assert.deepEqual(
    Object.keys(legacyUpdate.properties ?? {}).sort(),
    Object.keys(legacyResilienceProfileSchema.shape).sort()
  );
});

test("rate-limit route contracts describe the legacy redirects and consolidated status/toggle API", () => {
  for (const method of ["get", "post"]) {
    const alias = operation("/api/rate-limit", method);
    assert.equal(alias.deprecated, true);
    assert.equal(alias.responses?.["308"]?.headers?.Location?.required, true);
    assert.equal(alias.responses?.["308"]?.headers?.Location?.schema?.format, "uri");
    assert.equal(
      alias.requestBody,
      undefined,
      "the deprecated route only redirects; it never reads a body"
    );
    assertConditionalManagementAuth(alias);
  }

  const list = operation("/api/rate-limits", "get");
  const toggle = operation("/api/rate-limits", "post");
  assertConditionalManagementAuth(list);
  assertConditionalManagementAuth(toggle);
  assert.equal(
    success("/api/rate-limits", "get").$ref,
    "#/components/schemas/RateLimitsStatusResponse"
  );
  assert.equal(
    toggle.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/RateLimitToggleRequest"
  );
  assert.equal(
    success("/api/rate-limits", "post").$ref,
    "#/components/schemas/RateLimitToggleResponse"
  );
  assert.deepEqual(
    Object.keys(spec.components.schemas.RateLimitToggleRequest.properties ?? {}).sort(),
    Object.keys(toggleRateLimitSchema.shape).sort()
  );
  assert.equal(
    spec.components.schemas.RateLimitsStatusResponse.properties?.connections.type,
    "array"
  );
  assert.equal(spec.components.schemas.RateLimitsStatusResponse.properties?.lockouts.type, "array");
});

test("resilience read/write/reset and local connection snapshots return typed state", () => {
  const get = operation("/api/resilience", "get");
  const patch = operation("/api/resilience", "patch");
  assertConditionalManagementAuth(get);
  assertConditionalManagementAuth(patch);
  assert.equal(
    success("/api/resilience", "get").$ref,
    "#/components/schemas/ResilienceSettingsResponse"
  );
  assert.equal(
    patch.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/ResilienceSettingsUpdate"
  );
  assert.equal(
    success("/api/resilience", "patch").$ref,
    "#/components/schemas/ResilienceSettingsPatchResponse"
  );
  assert.equal(
    spec.components.schemas.ResilienceSettingsResponse.properties?.streamRecovery,
    undefined
  );

  const connections = operation("/api/resilience/connections", "get");
  assert.equal(connections["x-loopback-only"], true);
  assertConditionalManagementAuth(connections);
  assert.equal(
    success("/api/resilience/connections", "get").$ref,
    "#/components/schemas/ResilienceConnectionsResponse"
  );
  assert.equal(
    connections.parameters?.find((parameter) => parameter.name === "windowMs")?.schema?.maximum,
    86400000
  );
  assert.equal(
    connections.parameters?.find((parameter) => parameter.name === "windowMs")?.schema?.default,
    3600000
  );

  const reset = operation("/api/resilience/reset", "post");
  assertConditionalManagementAuth(reset);
  assert.equal(
    success("/api/resilience/reset", "post").$ref,
    "#/components/schemas/ResilienceResetResponse"
  );
});
