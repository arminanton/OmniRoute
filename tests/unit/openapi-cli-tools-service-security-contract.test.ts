import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { isLocalOnlyPath } from "../../src/server/authz/routeGuard.ts";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;

const AUTH_SCHEMES = [
  "BearerAuth",
  "ManagementSessionAuth",
  "LocalCliTokenAuth",
  "InternalServiceTokenAuth",
  "ManagementGoogleApiKeyAuth",
  "ManagementAnthropicApiKeyAuth",
] as const;

const LOCAL_SETTINGS = [
  "/api/cli-tools/forge-settings",
  "/api/cli-tools/grok-build-settings",
  "/api/cli-tools/jcode-settings",
  "/api/cli-tools/letta-settings",
  "/api/cli-tools/omp-settings",
  "/api/cli-tools/qwen-settings",
] as const;

const TARGETS: Record<string, { methods: readonly string[]; localOnly: boolean }> = {
  "/api/cli-tools/config": { methods: ["get", "post"], localOnly: false },
  ...Object.fromEntries(
    LOCAL_SETTINGS.map((route) => [route, { methods: ["get", "post", "delete"], localOnly: true }])
  ),
  "/api/cli-tools/openclaw/auto-order": { methods: ["get"], localOnly: false },
};

function sourceOperations(): Set<string> {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      if (!(route in TARGETS)) continue;
      const source = fs.readFileSync(absoluteFile, "utf8");
      assert.match(source, /requireCliToolsAuth/, `${relativeFile} must use the CLI-tools auth helper`);
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

function getOperation(route: string, method: string): Record<string, any> {
  const operation = spec.paths?.[route]?.[method];
  assert.ok(operation, `missing ${method.toUpperCase()} ${route} from OpenAPI`);
  return operation;
}

function isAnonymousAlternative(operation: Record<string, any>): boolean {
  return (
    Array.isArray(operation.security) &&
    operation.security.some(
      (requirement: Record<string, unknown>) => Object.keys(requirement).length === 0
    )
  );
}

function dereference(ref: string): unknown {
  if (!ref.startsWith("#/")) return null;
  return ref
    .slice(2)
    .split("/")
    .reduce((value: any, segment) => value?.[segment.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
}

const sensitivityDisclosure =
  /(?:may|can|contains?|includes?|returns?|exposes?|discloses?|unredacted|raw|full|plaintext).{0,100}(?:api[ _-]?keys?|credentials?|secrets?|tokens?|auth(?:entication|\.json)?|toml)|(?:api[ _-]?keys?|credentials?|secrets?|tokens?|auth(?:entication|\.json)?|toml).{0,100}(?:may be exposed|are exposed|included|returned|disclosed|unredacted|plaintext)/i;

function containsSensitivityAnnotation(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value as object)) return false;
  seen.add(value as object);
  const record = value as Record<string, any>;
  if (record["x-sensitive"] === true) return true;
  if (typeof record.description === "string" && sensitivityDisclosure.test(record.description)) {
    return true;
  }
  if (typeof record.$ref === "string") {
    const resolved = dereference(record.$ref);
    if (resolved && containsSensitivityAnnotation(resolved, seen)) return true;
  }
  return Object.values(record).some((child) => containsSensitivityAnnotation(child, seen));
}

function assertSensitiveResponse(route: string, method: string, responseStatus = "200"): void {
  const operation = getOperation(route, method);
  const response = operation.responses?.[responseStatus];
  assert.ok(response, `missing ${responseStatus} response for ${method.toUpperCase()} ${route}`);
  assert.ok(
    containsSensitivityAnnotation(response),
    `${method.toUpperCase()} ${route} ${responseStatus} returns local config/credential material and must mark it x-sensitive or explain that the response includes secrets/raw config`
  );
}

test("the 21 CLI-tools service routes document every central credential alternative", () => {
  const expected = new Set<string>();

  for (const [route, target] of Object.entries(TARGETS)) {
    assert.equal(classifyRoute(route, "GET").routeClass, "MANAGEMENT", `${route} classification`);

    for (const method of target.methods) {
      expected.add(`${method} ${route}`);
      const operation = getOperation(route, method);

      assert.ok(Array.isArray(operation.security), `${method.toUpperCase()} ${route} security`);
      for (const requirement of operation.security) {
        assert.ok(
          Object.keys(requirement).length <= 1,
          `${method.toUpperCase()} ${route} security entries must be alternatives, not combined credentials`
        );
      }
      for (const scheme of AUTH_SCHEMES) {
        assert.ok(
          operation.security.some((requirement: Record<string, unknown>) => scheme in requirement),
          `${method.toUpperCase()} ${route} must document ${scheme}`
        );
      }
      assert.ok(
        isAnonymousAlternative(operation),
        `${method.toUpperCase()} ${route} must document the conditional requireLogin=false / unlocked-management alternative`
      );
      assert.match(
        operation.description ?? "",
        /requireLogin\s*=\s*false/i,
        `${method.toUpperCase()} ${route} must explain when its empty security alternative applies`
      );
      assert.match(
        operation.description ?? "",
        /anonymous|unlocked|disabled/i,
        `${method.toUpperCase()} ${route} must label its conditional anonymous alternative`
      );
      assert.equal(
        operation["x-local-only"],
        target.localOnly ? true : undefined,
        `${method.toUpperCase()} ${route} local-only classification`
      );
      assert.equal(
        operation["x-loopback-only"],
        undefined,
        `${method.toUpperCase()} ${route} is not one of the strict-loopback Video Bridge operations`
      );
      assert.equal(
        isLocalOnlyPath(route, method.toUpperCase()),
        target.localOnly,
        `${method.toUpperCase()} ${route} must match the source route-guard locality policy`
      );
    }
  }

  assert.deepEqual([...sourceOperations()].sort(), [...expected].sort());
  assert.equal(expected.size, 21);
  assert.deepEqual(publicSpec, spec, "public OpenAPI must mirror the canonical CLI-tools security contract");
});

test("generated config and local CLI settings responses flag credential-bearing config as sensitive", () => {
  // Both generated-config responses include usable client config; the POST form
  // returns config text and the GET form returns configs for every supported tool.
  assertSensitiveResponse("/api/cli-tools/config", "get");
  assertSensitiveResponse("/api/cli-tools/config", "post");

  // These GETs return local files or settings derived from them. In particular,
  // Forge/JCode expose TOML, Letta exposes its auth JSON, and OMP exposes its key.
  for (const route of LOCAL_SETTINGS) {
    assertSensitiveResponse(route, "get");
  }
});
