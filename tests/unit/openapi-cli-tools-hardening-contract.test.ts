import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";
import { isAlwaysProtectedPath, isLocalOnlyPath } from "../../src/server/authz/routeGuard.ts";
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
];
const TARGETS: Record<string, Record<string, "read" | "write" | "admin">> = {
  "/api/cli-tools/all-statuses": { get: "read" },
  "/api/cli-tools/apply": { post: "admin" },
  "/api/cli-tools/backups": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/claude-settings": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/cline-settings": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/codewhale-settings": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/crush-settings": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/deepseek-tui-settings": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/droid-settings": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/guide-settings/{toolId}": { get: "read", post: "write" },
  "/api/cli-tools/hermes-agent-settings": { get: "read", post: "write" },
  "/api/cli-tools/kilo-settings": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/logs": { get: "read" },
  "/api/cli-tools/openclaw-settings": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/pi-settings": { get: "read", post: "write", delete: "write" },
  "/api/cli-tools/smelt-settings": { get: "read", post: "write", delete: "write" },
};

function sourceOperations() {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const route of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      if (!(route in TARGETS)) continue;
      const source = fs.readFileSync(absoluteFile, "utf8");
      assert.match(
        source,
        /requireCliToolsAuth/,
        `${relativeFile} must use the shared CLI auth helper`
      );
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return result;
}

test("all selected CLI config/log/restore operations are always-protected in source and OAS", () => {
  const expected = new Set<string>();
  for (const [route, methods] of Object.entries(TARGETS)) {
    assert.equal(classifyRoute(route, "GET").routeClass, "MANAGEMENT");
    assert.equal(isAlwaysProtectedPath(route), true, `${route} must be ALWAYS_PROTECTED`);
    for (const [method, scope] of Object.entries(methods)) {
      const operation = spec.paths?.[route]?.[method];
      assert.ok(operation, `missing ${method.toUpperCase()} ${route}`);
      expected.add(`${method} ${route}`);
      assert.equal(operation["x-always-protected"], true);
      assert.match(
        operation.description ?? "",
        /always-protected, including when requireLogin=false/
      );
      assert.equal(inferRequiredScope(method.toUpperCase(), route), scope);
      for (const scheme of AUTH_SCHEMES) {
        assert.ok(
          operation.security?.some((alternative: Record<string, unknown>) => scheme in alternative),
          `${method.toUpperCase()} ${route} must document ${scheme}`
        );
      }
      assert.ok(
        !operation.security?.some(
          (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
        ),
        `${method.toUpperCase()} ${route} must not allow anonymous access`
      );
      for (const status of ["401", "403", "503"]) {
        assert.ok(
          operation.responses?.[status],
          `${method.toUpperCase()} ${route} must document ${status}`
        );
      }
    }
  }
  assert.deepEqual([...sourceOperations()].sort(), [...expected].sort());

  // Keep the ordinary status surfaces and the generated caller-key config helper out of this gate.
  for (const route of [
    "/api/cli-tools/status",
    "/api/cli-tools/openclaw/auto-order",
    "/api/cli-tools/config",
  ]) {
    assert.equal(
      isAlwaysProtectedPath(route),
      false,
      `${route} remains outside this hardening slice`
    );
  }
  // Existing spawn-capable routes retain their LOCAL_ONLY classification.
  for (const route of [
    "/api/cli-tools/runtime/codex",
    "/api/cli-tools/forge-settings",
    "/api/cli-tools/grok-build-settings",
    "/api/cli-tools/jcode-settings",
    "/api/cli-tools/letta-settings",
    "/api/cli-tools/omp-settings",
    "/api/cli-tools/qwen-settings",
    "/api/cli-tools/antigravity-mitm",
  ]) {
    assert.equal(isLocalOnlyPath(route, "GET"), true, `${route} remains LOCAL_ONLY`);
  }
  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
