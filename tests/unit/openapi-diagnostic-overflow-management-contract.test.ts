import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const routes = [
  "/api/usage/diagnostic-overflow",
  "/api/usage/diagnostic-overflow/{traceId}",
  "/api/usage/diagnostic-overflow/{traceId}/client-request",
  "/api/usage/diagnostic-overflow/{traceId}/{attemptId}/{kind}",
] as const;
const routeFiles = [
  "src/app/api/usage/diagnostic-overflow/route.ts",
  "src/app/api/usage/diagnostic-overflow/[traceId]/route.ts",
  "src/app/api/usage/diagnostic-overflow/[traceId]/client-request/route.ts",
  "src/app/api/usage/diagnostic-overflow/[traceId]/[attemptId]/[kind]/route.ts",
];
const authSchemes = [
  "ManagementSessionAuth",
  "BearerAuth",
  "LocalCliTokenAuth",
  "InternalServiceTokenAuth",
];

function sourceOperations() {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (!routeFiles.includes(relativeFile)) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const apiPath of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${apiPath}`);
      }
    }
  }
  return result;
}

test("diagnostic-overflow OAS operations match the private GET/HEAD route tree", () => {
  const documented = new Set<string>();
  for (const route of routes) {
    for (const method of ["get", "head"] as const) {
      const operation = spec.paths?.[route]?.[method];
      assert.ok(operation, `missing ${method.toUpperCase()} ${route}`);
      documented.add(`${method} ${route}`);
      assert.equal(classifyRoute(route, method.toUpperCase()).routeClass, "MANAGEMENT");
      assert.equal(inferRequiredScope(method.toUpperCase(), route), "admin");
      for (const scheme of authSchemes) {
        assert.ok(
          operation.security?.some((alternative: Record<string, unknown>) => scheme in alternative),
          `${method.toUpperCase()} ${route} must document ${scheme}`
        );
      }
      assert.ok(
        !operation.security?.some(
          (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
        ),
        `${method.toUpperCase()} ${route} is always authenticated, including requireLogin=false`
      );
      for (const status of ["401", "403", "503"]) {
        assert.ok(operation.responses?.[status], `${method.toUpperCase()} ${route} ${status}`);
      }
    }
  }
  assert.deepEqual([...documented].sort(), [...sourceOperations()].sort());
});

test("diagnostic-overflow contracts describe sensitive manifests, gzip bytes, and read states", () => {
  const list = spec.paths[routes[0]].get;
  assert.match(list.description, /always authenticated.*requireLogin=false/s);
  assert.match(list.description, /admin-scoped `oma_live_`/);
  assert.equal(list.responses["200"]["x-sensitive"], true);
  assert.equal(list.responses["200"].headers["Cache-Control"].schema.const, "private, no-store");
  assert.equal(list.responses["200"].headers["X-Content-Type-Options"].schema.const, "nosniff");
  assert.match(list.responses["200"].description, /empty list/);

  const manifest = spec.paths[routes[1]].get;
  assert.equal(manifest.responses["200"]["x-sensitive"], true);
  assert.match(manifest.responses["200"].description, /sensitive/);
  assert.match(manifest.responses["404"].description, /normalized to 404|no readable manifest/);
  assert.equal(
    spec.components.schemas.DiagnosticOverflowManifest.properties.attempts.items.properties.headers
      .additionalProperties.type,
    "string"
  );
  assert.deepEqual(spec.components.schemas.DiagnosticOverflowFile.properties.representation.enum, [
    "parsed_json_reserialized_utf8",
    "serialized_provider_request_utf8",
    "decoded_upstream_bytes",
  ]);

  for (const route of routes.slice(2)) {
    const download = spec.paths[route].get;
    assert.equal(download.responses["200"]["x-sensitive"], true);
    assert.deepEqual(Object.keys(download.responses["200"].content), ["application/gzip"]);
    assert.equal(download.responses["200"].content["application/gzip"].schema.format, "binary");
    assert.deepEqual(download.responses["200"].headers["X-Diagnostic-Capture-State"].schema.enum, [
      "complete",
      "incomplete",
    ]);
    assert.deepEqual(
      download.responses["200"].headers["X-Diagnostic-Capture-Complete"].schema.enum,
      ["true", "false"]
    );
    assert.equal(
      download.responses["200"].headers["Cache-Control"].schema.const,
      "private, no-store"
    );
    assert.equal(
      download.responses["200"].headers["X-Content-Type-Options"].schema.const,
      "nosniff"
    );
    assert.equal(
      download.responses["404"].content["application/json"].schema.$ref,
      "#/components/schemas/DiagnosticOverflowFileMissingResponse"
    );
    assert.equal(
      download.responses["409"].content["application/json"].schema.$ref,
      "#/components/schemas/DiagnosticOverflowFileUnavailableResponse"
    );
    assert.match(download.description, /gzip SHA-256.*64 KiB chunks.*backpressure/s);
  }
  assert.equal(
    spec.components.schemas.DiagnosticOverflowFileMissingResponse.properties.state.const,
    "missing"
  );
  assert.deepEqual(
    spec.components.schemas.DiagnosticOverflowFileUnavailableResponse.properties.state.enum,
    ["capturing", "corrupt"]
  );
  assert.equal(
    spec.components.schemas.DiagnosticOverflowFileUnavailableResponse.properties.metadata.$ref,
    "#/components/schemas/DiagnosticOverflowFile"
  );

  for (const route of routes) {
    const head = spec.paths[route].head;
    assert.equal(head.responses["405"].headers.Allow.schema.const, "GET");
    assert.equal(head.responses["405"].headers["Cache-Control"].schema.const, "private, no-store");
    assert.equal(head.responses["405"].headers["X-Content-Type-Options"].schema.const, "nosniff");
  }

  const management = fs.readFileSync(
    path.join(ROOT, "src/lib/usage/diagnosticOverflowManagement.ts"),
    "utf8"
  );
  assert.match(management, /requireManagementAuth\(request,\s*\{\s*alwaysRequireAuth:\s*true/);
  assert.match(management, /"Content-Type":\s*"application\/gzip"/);
  assert.match(management, /highWaterMark:\s*64\s*\*\s*1024/);
  const store = fs.readFileSync(path.join(ROOT, "src/lib/usage/diagnosticOverflow.ts"), "utf8");
  assert.match(store, /stat\.size !== metadata\.compressedBytes/);
  assert.match(store, /metadata\.gzipSha256/);
  assert.match(store, /hash\.digest\("hex"\) !== metadata\.gzipSha256/);
  assert.match(store, /return \{ state: "corrupt"/);

  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
