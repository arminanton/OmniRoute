import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import type { AutoComboCandidateView } from "../../open-sse/handlers/autoComboCandidates.ts";
import { projectCombo } from "../../src/app/api/v1/combos/projectCombo.ts";

type Schema = {
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
  anyOf?: Schema[];
};

type Operation = {
  security?: Array<Record<string, unknown>>;
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
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

function successSchema(pathTemplate: string, method: string, status = "200"): Schema {
  const schema = operation(pathTemplate, method).responses?.[status]?.content?.["application/json"]
    ?.schema;
  assert.ok(schema, `missing ${status} JSON response for ${method.toUpperCase()} ${pathTemplate}`);
  return schema;
}

function assertClientApiSecurity(op: Operation): void {
  const security = op.security ?? [];
  assert.ok(security.some((entry) => Object.hasOwn(entry, "BearerAuth")));
  assert.ok(security.some((entry) => Object.hasOwn(entry, "ManagementSessionAuth")));
  assert.ok(security.some((entry) => Object.keys(entry).length === 0));
}

test("public combo response matches the privacy-filtered projection", () => {
  const op = operation("/api/v1/combos", "get");
  assertClientApiSecurity(op);
  assert.ok(op.security?.some((entry) => Object.hasOwn(entry, "GoogleApiKeyAuth")));
  assert.ok(!op.security?.some((entry) => Object.hasOwn(entry, "ClientApiKeyAuth")));
  assert.equal(
    successSchema("/api/v1/combos", "get").$ref,
    "#/components/schemas/V1PublicComboListResponse"
  );
  assert.ok(op.responses?.["401"]?.content?.["application/json"]?.schema);
  assert.ok(op.responses?.["500"]?.content?.["application/json"]?.schema);

  const response = projectCombo(
    {
      name: "example",
      strategy: "priority",
      description: "public description",
      context_cache_protection: true,
      models: [
        { kind: "model", model: "openai/gpt-6", providerId: "openai", connectionId: "secret" },
        { kind: "combo-ref", comboName: "nested", weight: 3 },
      ],
    },
    {
      includeCapabilities: true,
      resolveCapabilities: () => ({ supportsVision: true, reasoning: true }),
    }
  );
  assert.ok(response);
  assert.deepEqual(Object.keys(response).sort(), [
    "capabilities",
    "description",
    "models",
    "name",
    "strategy",
  ]);
  assert.deepEqual(response.models[0], {
    kind: "model",
    model: "openai/gpt-6",
    providerId: "openai",
    accountPinned: true,
  });
  assert.equal(response.capabilities?.caching, true);

  const list = spec.components.schemas.V1PublicComboListResponse;
  assert.deepEqual(list.required, ["object", "data"]);
  assert.equal(list.properties?.object.const, "list");
  assert.equal(list.properties?.data.items?.$ref, "#/components/schemas/V1PublicCombo");
  assert.deepEqual(spec.components.schemas.V1PublicCombo.required, [
    "name",
    "strategy",
    "models",
    "capabilities",
  ]);
});

test("auto-combo candidate response documents every source candidate field and error status", () => {
  const op = operation("/api/v1/auto-combo/{channel}/candidates", "get");
  assertClientApiSecurity(op);
  assert.ok(op.security?.some((entry) => Object.hasOwn(entry, "ClientApiKeyAuth")));
  assert.ok(op.security?.some((entry) => Object.hasOwn(entry, "GoogleApiKeyAuth")));
  assert.equal(
    successSchema("/api/v1/auto-combo/{channel}/candidates", "get").$ref,
    "#/components/schemas/V1AutoComboCandidatesResponse"
  );
  for (const status of ["400", "401", "404", "500"]) {
    assert.ok(op.responses?.[status]?.content?.["application/json"]?.schema, `missing ${status}`);
  }

  const sourceCandidate: AutoComboCandidateView = {
    provider: "openai",
    connectionId: "connection-id",
    model: "gpt-6",
    modelStr: "openai/gpt-6",
    excluded: false,
    reachable: true,
    breakerState: "closed",
    connectionCooldown: false,
    modelLocked: false,
    freeAccessExclusion: null,
  };
  const candidateSchema = spec.components.schemas.V1AutoComboCandidate;
  assert.deepEqual([...candidateSchema.required!].sort(), Object.keys(sourceCandidate).sort());
  assert.equal(
    spec.components.schemas.V1AutoComboCandidatesResponse.properties?.candidates.items?.$ref,
    "#/components/schemas/V1AutoComboCandidate"
  );
  assert.equal(candidateSchema.properties?.freeAccessExclusion.oneOf?.[1].type, "null");
});

test("API-key self-status describes scoped usage and optional account quota branches", () => {
  const op = operation("/api/v1/me/status", "get");
  assert.deepEqual(op.security, [{ BearerAuth: [] }]);
  assert.equal(
    successSchema("/api/v1/me/status", "get").$ref,
    "#/components/schemas/V1ApiKeySelfServiceStatus"
  );
  for (const status of ["401", "403", "500"]) {
    assert.equal(
      op.responses?.[status]?.content?.["application/json"]?.schema?.$ref,
      "#/components/schemas/V1ApiKeySelfServiceErrorResponse"
    );
  }

  const responseSchema = spec.components.schemas.V1ApiKeySelfServiceStatus;
  assert.deepEqual(responseSchema.required, ["apiKey", "usage"]);
  assert.ok(!responseSchema.required?.includes("accountQuota"));
  assert.ok(!responseSchema.required?.includes("accountQuotas"));
  assert.deepEqual(spec.components.schemas.V1ApiKeyCostStatus.required, [
    "period",
    "currency",
    "usedUsd",
    "limitUsd",
    "remainingUsd",
    "usedPercent",
    "warningThreshold",
    "resetAt",
    "periodStartAt",
  ]);
  assert.equal(
    spec.components.schemas.V1ApiKeyAccountQuota.oneOf?.length,
    2,
    "quota response must retain both successful and unavailable account outcomes"
  );
});

test("Muse model catalog matches the provider-specific CLI response", async () => {
  const op = operation("/api/v1/muse-code/models", "get");
  assertClientApiSecurity(op);
  assert.ok(op.security?.some((entry) => Object.hasOwn(entry, "ClientApiKeyAuth")));
  assert.ok(op.security?.some((entry) => Object.hasOwn(entry, "GoogleApiKeyAuth")));
  assert.equal(
    successSchema("/api/v1/muse-code/models", "get").$ref,
    "#/components/schemas/MuseCodeModelListResponse"
  );

  const route = await import("../../src/app/api/v1/muse-code/models/route.ts");
  const response = await route.GET();
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    object: string;
    data: Array<Record<string, unknown>>;
  };
  assert.equal(body.object, "list");
  assert.ok(body.data.length > 0);
  for (const model of body.data) {
    assert.deepEqual(Object.keys(model).sort(), [
      "created",
      "id",
      "metadata",
      "object",
      "owned_by",
    ]);
    assert.deepEqual(Object.keys(model.metadata as object).sort(), [
      "cost",
      "family",
      "limit",
      "modalities",
      "name",
      "reasoning",
      "tool_call",
    ]);
    assert.equal(model.object, "model");
    assert.equal(model.owned_by, "meta");
  }
});

test("shared API errors include the correlation identifier emitted by proxy authorization", () => {
  assert.equal(
    spec.components.schemas.ApiErrorResponse.properties?.error.properties?.correlation_id?.format,
    "uuid"
  );
});
