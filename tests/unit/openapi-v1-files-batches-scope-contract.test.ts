import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const spec = yaml.load(
  fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")
) as any;

const securedOperations: Array<[string, string]> = [
  ["/api/v1/files", "get"],
  ["/api/v1/files", "post"],
  ["/api/v1/files/{id}", "get"],
  ["/api/v1/files/{id}", "delete"],
  ["/api/v1/files/{id}/content", "get"],
  ["/api/v1/batches", "get"],
  ["/api/v1/batches", "post"],
  ["/api/v1/batches/{id}", "get"],
  ["/api/v1/batches/{id}", "delete"],
  ["/api/v1/batches/{id}/cancel", "post"],
  ["/api/v1/batches/delete-completed", "delete"],
];

function operation(route: string, method: string): any {
  const result = spec.paths[route]?.[method];
  assert.ok(result, `missing ${method.toUpperCase()} ${route}`);
  return result;
}

test("files and batches require identity and describe owner-scoped visibility", () => {
  assert.equal(securedOperations.length, 11);
  for (const [route, method] of securedOperations) {
    const op = operation(route, method);
    const security = op.security ?? [];
    for (const scheme of [
      "BearerAuth",
      "ClientApiKeyAuth",
      "GoogleApiKeyAuth",
      "ManagementSessionAuth",
    ]) {
      assert.ok(
        security.some((requirement: Record<string, unknown>) => scheme in requirement),
        `${method.toUpperCase()} ${route} must allow ${scheme}`
      );
    }
    assert.equal(
      security.some(
        (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
      ),
      false,
      `${method.toUpperCase()} ${route} must not allow anonymous access`
    );
    assert.equal(
      op.responses?.["401"]?.$ref,
      "#/components/responses/V1ResourceAuthenticationRequired"
    );
    assert.equal(
      op.responses?.["503"]?.$ref,
      "#/components/responses/V1ResourceAuthenticationUnavailable"
    );
  }

  assert.match(
    operation("/api/v1/files", "get").description,
    /only files owned by that exact key/i
  );
  assert.match(operation("/api/v1/files", "get").description, /unowned files are excluded/i);
  assert.match(
    operation("/api/v1/files", "get").description,
    /sessions see files across all owners/i
  );
  assert.match(operation("/api/v1/files/{id}", "get").description, /unowned file/i);
  assert.match(
    operation("/api/v1/files/{id}", "get").description,
    /another key are hidden as not found/i
  );
  assert.match(operation("/api/v1/batches", "get").description, /exact key/i);
  assert.match(
    operation("/api/v1/batches", "get").description,
    /dashboard session lists across all owners/i
  );
  assert.match(operation("/api/v1/batches/{id}", "get").description, /unowned batch/i);
  assert.match(
    operation("/api/v1/batches/{id}", "get").description,
    /another API key are hidden as not found/i
  );
  assert.match(
    operation("/api/v1/batches", "post").description,
    /unowned or owned by the same API key/i
  );

  const cleanup = operation("/api/v1/batches/delete-completed", "delete");
  assert.match(cleanup.description, /across all owners.*dashboard session/i);
  assert.match(cleanup.description, /exact API key/i);
  assert.match(cleanup.description, /no remaining batch references/i);
  assert.equal(
    cleanup.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/V1BatchCleanupResponse"
  );

  assert.match(
    spec.components.responses.V1ResourceAuthenticationRequired.content["application/json"].schema
      .$ref,
    /ApiErrorResponse$/
  );
  assert.match(
    spec.components.responses.V1ResourceAuthenticationUnavailable.content["application/json"].schema
      .$ref,
    /ApiErrorResponse$/
  );
});

test("translator step-four response is a redacted display preview, separate from send", () => {
  const translate = operation("/api/translator/translate", "post");
  const security = translate.security ?? [];
  assert.ok(security.some((requirement: Record<string, unknown>) => "BearerAuth" in requirement));
  assert.ok(
    security.some((requirement: Record<string, unknown>) => "ManagementSessionAuth" in requirement)
  );
  assert.ok(
    security.some((requirement: Record<string, unknown>) => Object.keys(requirement).length === 0)
  );
  assert.equal(
    translate.responses?.["401"]?.$ref,
    "#/components/responses/ManagementAuthenticationRequired"
  );
  assert.equal(translate.responses?.["403"]?.$ref, "#/components/responses/ManagementInvalidToken");
  assert.equal(
    translate.responses?.["503"]?.$ref,
    "#/components/responses/ManagementAuthUnavailable"
  );
  const requestSchema = translate.requestBody?.content?.["application/json"]?.schema;
  assert.equal(requestSchema?.$ref, "#/components/schemas/TranslatorTranslateRequest");
  assert.deepEqual(spec.components.schemas.TranslatorTranslateRequest.required, ["step", "body"]);
  assert.equal(
    spec.components.schemas.TranslatorTranslateRequest.properties.step.oneOf[0].minimum,
    1
  );
  assert.equal(
    spec.components.schemas.TranslatorTranslateRequest.properties.step.oneOf[1].const,
    "direct"
  );
  assert.deepEqual(spec.components.schemas.TranslatorTranslateRequest.allOf[0].then.required, [
    "provider",
  ]);
  assert.equal(
    translate.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/TranslatorTranslateResponse"
  );
  assert.match(translate.description, /display-only outbound request preview/i);
  assert.match(translate.description, /redacted as `\[REDACTED\]`/);
  assert.match(translate.description, /does not send the request upstream/i);

  const preview = spec.components.schemas.TranslatorProviderRequestPreview;
  assert.deepEqual(preview.required, ["timestamp", "url", "headers", "body"]);
  assert.match(preview.description, /credential header values are sanitized/i);
  assert.match(preview.properties.url.description, /sensitive query fields.*redacted/i);
  assert.match(preview.properties.headers.description, /credential-bearing values redacted/i);
  assert.match(preview.properties.body.description, /not sent by the preview operation/i);

  const send = operation("/api/translator/send", "post");
  assert.match(send.responses?.["200"]?.description, /provider response/i);
  assert.doesNotMatch(send.description ?? "", /redact/i);
});
