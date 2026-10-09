import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

type Schema = {
  $ref?: string;
  enum?: unknown[];
  format?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  "x-sensitive"?: boolean;
};

type Operation = {
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema }>;
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
  [key: string]: unknown;
};

type PathItem = Record<string, Operation> & {
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: Schema }>;
};

type Spec = {
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, Schema> };
};

const spec = yaml.load(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")
) as Spec;

function assertResponse(pathname: string, method: string, status: string, schemaName: string) {
  const schema =
    spec.paths[pathname]?.[method]?.responses?.[status]?.content?.["application/json"]?.schema;
  assert.equal(schema?.$ref, `#/components/schemas/${schemaName}`);
  assert.ok(spec.components.schemas[schemaName], `${schemaName} is defined`);
}

function assertRequest(pathname: string, method: string, schemaName: string) {
  const schema = spec.paths[pathname]?.[method]?.requestBody?.content?.["application/json"]?.schema;
  assert.equal(schema?.$ref, `#/components/schemas/${schemaName}`);
  assert.ok(spec.components.schemas[schemaName], `${schemaName} is defined`);
}

test("Volcengine Plan connect flows describe requests, session states, and outcomes", () => {
  const root = "/api/providers/volcengine-plan/connect";
  const session = `${root}/{sessionId}`;

  assertRequest(root, "post", "VolcenginePlanConnectRequest");
  assertResponse(root, "post", "200", "VolcenginePlanConnectResponse");
  assertRequest(`${session}/code`, "post", "VolcenginePlanCodeRequest");
  assertRequest(`${session}/identity`, "post", "VolcenginePlanIdentityRequest");
  assertResponse(`${session}/code`, "post", "200", "VolcenginePlanSessionResponse");
  assertResponse(`${session}/identity`, "post", "200", "VolcenginePlanSessionResponse");
  assertResponse(`${session}/cancel`, "post", "200", "VolcenginePlanSessionResponse");
  assertResponse(`${session}/resend`, "post", "200", "VolcenginePlanSessionResponse");
  assertResponse(`${session}/status`, "get", "200", "VolcenginePlanSessionResponse");

  const phases = spec.components.schemas.VolcenginePlanLoginSession.properties?.phase?.enum;
  assert.deepEqual(phases, [
    "starting",
    "sending_code",
    "waiting_code",
    "captcha_required",
    "submitting",
    "mfa_waiting",
    "identity_required",
    "success",
    "error",
    "timeout",
    "cancelled",
    "fallback_manual",
  ]);
  assert.equal(spec.components.schemas.VolcenginePlanCodeRequest.required?.[0], "code");
  assert.equal(spec.components.schemas.VolcenginePlanIdentityRequest.required?.[0], "index");
  assert.equal(
    spec.components.schemas.VolcenginePlanLoginSession.properties?.credentials?.["x-sensitive"],
    true,
    "raw console cookies must be identified as sensitive credential material"
  );
  assert.equal(
    spec.paths[`${session}/status`]?.parameters?.find((parameter) => parameter.name === "sessionId")
      ?.schema?.format,
    "uuid"
  );

  for (const [pathname, method] of [
    [root, "post"],
    [`${session}/cancel`, "post"],
    [`${session}/code`, "post"],
    [`${session}/identity`, "post"],
    [`${session}/resend`, "post"],
    [`${session}/status`, "get"],
  ]) {
    assert.equal(spec.paths[pathname]?.[method]?.["x-loopback-only"], true);
  }
});
