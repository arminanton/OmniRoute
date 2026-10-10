import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

const root = process.cwd();
const canonicalText = fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8");
const publicText = fs.readFileSync(path.join(root, "public/openapi.yaml"), "utf8");
const spec = yaml.load(canonicalText) as any;

const proxyOperations: Array<[string, string]> = [
  ["/api/v1/voices", "get"],
  ["/api/v1/speech-to-text", "post"],
  ["/api/v1/text-to-speech/{voiceId}", "post"],
];

test("ElevenLabs proxy operations document raw upstream and transport-error responses", () => {
  for (const [route, method] of proxyOperations) {
    const operation = spec.paths[route]?.[method];
    assert.ok(operation, `missing ${method.toUpperCase()} ${route}`);

    assert.ok(
      operation.responses?.["502"]?.content?.["*/*"]?.schema,
      `${method.toUpperCase()} ${route} documents the local transport failure and raw upstream 502`
    );
    assert.notEqual(
      operation.responses?.["500"]?.$ref,
      "#/components/responses/InternalError",
      `${method.toUpperCase()} ${route} does not constrain a relayed upstream 500 to OmniRoute's error shape`
    );
    assert.ok(
      operation.responses?.["500"]?.content?.["*/*"]?.schema,
      `${method.toUpperCase()} ${route} allows the upstream's unmodified 500 body`
    );
    assert.match(
      operation.responses?.default?.description ?? "",
      /upstream status and response body are relayed unchanged/i
    );
    assert.ok(
      operation.responses?.default?.content?.["*/*"]?.schema,
      `${method.toUpperCase()} ${route} permits arbitrary upstream response content`
    );
    for (const status of ["401", "429"]) {
      assert.ok(
        operation.responses?.[status]?.content?.["*/*"]?.schema,
        `${method.toUpperCase()} ${route} permits local and relayed HTTP ${status} bodies`
      );
    }
  }

  const voiceId = spec.paths["/api/v1/text-to-speech/{voiceId}"]?.post;
  assert.ok(voiceId.responses?.["400"]?.content?.["*/*"]?.schema);
  assert.equal(publicText, canonicalText);
});
