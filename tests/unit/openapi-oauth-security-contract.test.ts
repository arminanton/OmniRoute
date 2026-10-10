import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const SPEC_PATH = path.join(ROOT, "docs/openapi.yaml");
const PUBLIC_SPEC_PATH = path.join(ROOT, "public/openapi.yaml");
const spec = parse(fs.readFileSync(SPEC_PATH, "utf8"));
const publicSpec = parse(fs.readFileSync(PUBLIC_SPEC_PATH, "utf8"));
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head"]);

function oauthOperations(document: typeof spec) {
  return Object.entries(document.paths ?? {}).flatMap(([route, pathItem]) =>
    route.startsWith("/api/oauth/")
      ? Object.entries(pathItem ?? {})
          .filter(([method]) => HTTP_METHODS.has(method))
          .map(([method, operation]) => ({ route, method, operation }))
      : []
  );
}

function sourceOAuthOperations() {
  const root = apiRoot(ROOT);
  const operations = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (!relativeFile.startsWith("src/app/api/oauth/")) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    const routePaths = toApiUrlPaths(path.dirname(absoluteFile), root);
    for (const route of routePaths) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        operations.add(`${method.toLowerCase()} ${route}`);
      }
    }
  }
  return operations;
}

test("OAuth OpenAPI operations match source and declare the conditional management auth contract", () => {
  const operations = oauthOperations(spec);
  const actual = new Set(operations.map(({ route, method }) => `${method} ${route}`));
  const implemented = sourceOAuthOperations();

  assert.deepEqual(
    [...actual].sort(),
    [...implemented].sort(),
    "documented OAuth operations must exactly match src/app/api/oauth handlers"
  );
  assert.equal(operations.length, 20);

  for (const { route, method, operation } of operations) {
    const security = operation.security ?? [];
    assert.ok(
      security.some((requirement) => "BearerAuth" in requirement),
      `${method.toUpperCase()} ${route} must accept management bearer credentials`
    );
    assert.ok(
      security.some((requirement) => "ManagementSessionAuth" in requirement),
      `${method.toUpperCase()} ${route} must accept the dashboard session`
    );
    assert.ok(
      security.some((requirement) => Object.keys(requirement).length === 0),
      `${method.toUpperCase()} ${route} must reflect the configured requireLogin=false bypass`
    );
    for (const status of ["401", "403", "503"]) {
      assert.ok(
        operation.responses?.[status],
        `${method.toUpperCase()} ${route} must document management-auth ${status}`
      );
    }
  }

  assert.equal(spec.paths["/api/oauth/cursor/auto-import"]?.get?.["x-local-only"], true);
  assert.equal(spec.paths["/api/oauth/kiro/auto-import"]?.get?.["x-local-only"], true);

  const oauthTag = spec.tags?.find((tag) => tag.name === "OAuth");
  assert.match(oauthTag?.description ?? "", /requireLogin/);
  assert.match(oauthTag?.description ?? "", /LOCAL_ONLY/);
  assert.doesNotMatch(oauthTag?.description ?? "", /loopback-only/);
});

test("public Codex ticket and OIDC callback flows remain public and mirrored", () => {
  assert.ok(spec.paths["/api/codex/connect/{token}"]?.get);
  assert.ok(spec.paths["/api/codex/connect/{token}"]?.post);
  assert.ok(spec.paths["/api/auth/oidc/callback"]?.get);

  for (const operation of [
    spec.paths["/api/codex/connect/{token}"].get,
    spec.paths["/api/codex/connect/{token}"].post,
    spec.paths["/api/auth/oidc/callback"].get,
  ]) {
    assert.deepEqual(operation?.security ?? [], []);
  }

  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror the canonical document");
});

test("Kiro social device authorization is a JSON response rather than an HTTP redirect", () => {
  const operation = spec.paths["/api/oauth/kiro/social-authorize"]?.get;
  assert.ok(operation?.responses?.["200"]?.content?.["application/json"]?.schema);
  assert.equal(operation?.responses?.["302"], undefined);
});
