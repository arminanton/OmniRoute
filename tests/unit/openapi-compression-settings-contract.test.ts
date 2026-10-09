import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import {
  compressionSettingsUpdateSchema,
  mcpAccessibilityConfigSchema,
} from "../../src/shared/validation/compressionConfigSchemas.ts";
import { MCP_ACCESSIBILITY_MIN_MAX_TEXT_CHARS } from "../../open-sse/services/compression/engines/mcpAccessibility/constants.ts";
import { getCompressionSettings, getMcpAccessibilityConfig } from "../../src/lib/db/compression.ts";

type Schema = {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  additionalProperties?: boolean | Schema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
};

type Operation = {
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema }>;
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { $ref?: string; content?: Record<string, { schema?: Schema }> }>;
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

test("global compression settings match the strict partial Zod update and normalized response", () => {
  const update = spec.components.schemas.CompressionSettingsUpdate;
  assert.deepEqual(
    Object.keys(update.properties ?? {}).sort(),
    Object.keys(compressionSettingsUpdateSchema.shape).sort()
  );
  assert.equal(update.additionalProperties, false);
  assert.equal(update.properties?.defaultMode.$ref, "#/components/schemas/CompressionMode");
  assert.deepEqual(spec.components.schemas.CompressionMode.enum, [
    "off",
    "lite",
    "standard",
    "aggressive",
    "ultra",
    "rtk",
    "codex-responses",
    "omniglyph",
    "stacked",
  ]);
  assert.equal(update.properties?.cacheMinutes.minimum, 1);
  assert.equal(update.properties?.cacheMinutes.maximum, 60);
  assert.equal(update.properties?.rtkConfig.$ref, "#/components/schemas/RtkConfigUpdate");
  assert.ok(
    spec.components.schemas.CompressionSettingsResponse.allOf?.[1].required?.includes(
      "enginesExplicit"
    )
  );

  for (const method of ["get", "put"]) {
    assertConditionalManagementAuth(operation("/api/settings/compression", method));
    assert.ok(success("/api/settings/compression", method).$ref);
  }
  assert.equal(
    operation("/api/settings/compression", "put").requestBody?.content?.["application/json"]?.schema
      ?.$ref,
    "#/components/schemas/CompressionSettingsUpdate"
  );
  assert.equal(
    success("/api/settings/compression", "get").$ref,
    "#/components/schemas/CompressionSettingsResponse"
  );
});

test("MCP accessibility updates match the Zod partial merge and output floor", () => {
  const update = spec.components.schemas.McpAccessibilityConfigUpdate;
  assert.deepEqual(
    Object.keys(update.properties ?? {}).sort(),
    Object.keys(mcpAccessibilityConfigSchema.shape).sort()
  );
  assert.equal(update.additionalProperties, false);
  assert.equal(
    spec.components.schemas.McpAccessibilityConfig.properties?.maxTextChars.minimum,
    MCP_ACCESSIBILITY_MIN_MAX_TEXT_CHARS
  );
  assert.deepEqual(spec.components.schemas.McpAccessibilityConfig.required, [
    "enabled",
    "maxTextChars",
    "collapseThreshold",
    "collapseKeepHead",
    "collapseKeepTail",
    "minLengthToProcess",
  ]);
  const put = operation("/api/settings/compression/mcp-accessibility", "put");
  assertConditionalManagementAuth(put);
  assert.equal(
    put.requestBody?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/McpAccessibilityConfigUpdate"
  );
  assert.equal(
    success("/api/settings/compression/mcp-accessibility", "put").$ref,
    "#/components/schemas/McpAccessibilityConfig"
  );
});

test("normalized compression read payloads expose exactly the documented required fields", async () => {
  const compression = await getCompressionSettings();
  const compressionResponseRequired =
    spec.components.schemas.CompressionSettingsResponse.allOf?.[1].required ?? [];
  assert.deepEqual(Object.keys(compression).sort(), [...compressionResponseRequired].sort());

  const mcp = await getMcpAccessibilityConfig();
  assert.deepEqual(
    Object.keys(mcp).sort(),
    [...(spec.components.schemas.McpAccessibilityConfig.required ?? [])].sort()
  );
});

test("compression preview, language-pack and rule catalogs document their current wire shapes", () => {
  const preview = operation("/api/compression/preview", "post");
  assertConditionalManagementAuth(preview);
  const request = preview.requestBody?.content?.["application/json"]?.schema;
  assert.equal(request?.$ref, "#/components/schemas/CompressionPreviewRequest");
  assert.deepEqual(spec.components.schemas.CompressionPreviewRequest.required, ["messages"]);
  assert.deepEqual(spec.components.schemas.CompressionPreviewRequest.properties?.mode.enum, [
    "off",
    "lite",
    "standard",
    "aggressive",
    "ultra",
    "rtk",
    "stacked",
    "caveman",
  ]);
  assert.equal(
    spec.components.schemas.CompressionPreviewRequest.properties?.mode.default,
    "stacked"
  );
  assert.equal(
    spec.components.schemas.CompressionPreviewRequest.properties?.config.$ref,
    "#/components/schemas/CompressionSettingsUpdate"
  );
  assert.equal(
    success("/api/compression/preview", "post").$ref,
    "#/components/schemas/CompressionPreviewResponse"
  );

  const languagePacks = operation("/api/compression/language-packs", "get");
  const rules = operation("/api/compression/rules", "get");
  assertConditionalManagementAuth(languagePacks);
  assertConditionalManagementAuth(rules);
  assert.equal(
    success("/api/compression/language-packs", "get").$ref,
    "#/components/schemas/CompressionLanguagePacksResponse"
  );
  assert.equal(
    success("/api/compression/rules", "get").$ref,
    "#/components/schemas/CompressionRuleListResponse"
  );
  assert.deepEqual(spec.components.schemas.CompressionRuleMetadata.properties?.context.enum, [
    "all",
    "user",
    "system",
    "assistant",
  ]);
});
