import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

type Media = { schema?: { $ref?: string }; [key: string]: unknown };
type Response = {
  content?: Record<string, Media>;
  headers?: Record<string, unknown>;
  description?: string;
};
type Operation = {
  description?: string;
  requestBody?: { content?: Record<string, Media> };
  responses?: Record<string, Response>;
  security?: Array<Record<string, string[]>>;
};
type Spec = {
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, { name?: string; in?: string; type?: string; scheme?: string }>;
  };
};

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const spec = yaml.load(readFileSync(`${ROOT}docs/openapi.yaml`, "utf8")) as Spec;

const relayPaths = ["/api/v1/relay/chat/completions", "/api/v1/relay/chat/completions/bifrost"];

function hasSecurityPair(op: Operation, relayScheme: string, outerScheme?: string): boolean {
  return (op.security ?? []).some(
    (alternative) => relayScheme in alternative && (!outerScheme || outerScheme in alternative)
  );
}

test("relay completion routes document their request, layered auth, and response formats", () => {
  for (const pathname of relayPaths) {
    const op = spec.paths[pathname]?.post;
    assert.ok(op, `missing POST ${pathname}`);
    assert.ok(op.description?.includes("REQUIRE_API_KEY"));
    const expectedRequestSchema = pathname.endsWith("/bifrost")
      ? "#/components/schemas/BifrostChatCompletionRequest"
      : "#/components/schemas/ChatCompletionRequest";
    assert.equal(
      op.requestBody?.content?.["application/json"]?.schema?.$ref,
      expectedRequestSchema
    );
    assert.ok(op.responses?.["200"]?.content?.["application/json"]);
    assert.ok(op.responses?.["200"]?.content?.["text/event-stream"]);
    for (const status of ["400", "401", "403", "413", "429"]) {
      assert.ok(op.responses?.[status], `${pathname} must describe ${status}`);
      assert.equal(
        op.responses?.[status]?.content?.["application/json"]?.schema?.$ref,
        "#/components/schemas/RelayErrorResponse"
      );
    }

    assert.ok(hasSecurityPair(op, "RelayTokenHeaderAuth", "BearerAuth"));
    assert.ok(hasSecurityPair(op, "RelayTokenHeaderAuth", "ClientApiKeyAuth"));
    assert.ok(hasSecurityPair(op, "RelayTokenHeaderAuth", "GoogleApiKeyAuth"));
    assert.ok(hasSecurityPair(op, "RelayTokenHeaderAuth", "ManagementSessionAuth"));
    assert.ok(hasSecurityPair(op, "RelayTokenHeaderAuth"));
    assert.ok(hasSecurityPair(op, "RelayTokenBearerAuth"));

    // Both bearer schemes map to Authorization. The same header cannot carry
    // both relay and OmniRoute API-key credentials, so the spec must not claim
    // a single request can satisfy both simultaneously.
    assert.equal(
      (op.security ?? []).some(
        (alternative) => "RelayTokenBearerAuth" in alternative && "BearerAuth" in alternative
      ),
      false
    );
  }
});

test("relay auth schemes match the handler's bearer and X-Relay-Token extraction", () => {
  assert.deepEqual(spec.components.securitySchemes.RelayTokenBearerAuth, {
    type: "http",
    scheme: "bearer",
    bearerFormat: "relay token",
    description:
      "Dedicated relay token for the relay-completions endpoints. When the outer REQUIRE_API_KEY policy is enabled, Authorization is consumed by the OmniRoute API-key gate first; use X-Relay-Token for the relay token in that configuration.",
  });
  assert.equal(spec.components.securitySchemes.RelayTokenHeaderAuth.type, "apiKey");
  assert.equal(spec.components.securitySchemes.RelayTokenHeaderAuth.in, "header");
  assert.equal(spec.components.securitySchemes.RelayTokenHeaderAuth.name, "X-Relay-Token");
  assert.ok("RelayErrorResponse" in spec.components.schemas);
});

test("Bifrost relay docs include its unavailable, upstream, and fallback response behavior", () => {
  const op = spec.paths[relayPaths[1]].post;
  for (const status of ["500", "502", "503", "504", "default"]) {
    assert.ok(op.responses?.[status], `Bifrost relay must document ${status}`);
  }
  assert.ok(op.responses?.["429"]?.headers?.["Retry-After"]);
  assert.ok(op.responses?.["503"]?.headers?.["X-Bifrost-Fallback"]);
  assert.ok(op.responses?.["504"]?.headers?.["X-Bifrost-Fallback"]);

  const requestSchema = spec.components.schemas.BifrostChatCompletionRequest as {
    allOf?: Array<{
      $ref?: string;
      properties?: {
        model?: { minLength?: number };
        messages?: { minItems?: number };
      };
    }>;
  };
  assert.equal(requestSchema.allOf?.[0]?.$ref, "#/components/schemas/ChatCompletionRequest");
  assert.equal(requestSchema.allOf?.[1]?.properties?.model?.minLength, 1);
  assert.equal(requestSchema.allOf?.[1]?.properties?.messages?.minItems, 1);
});
