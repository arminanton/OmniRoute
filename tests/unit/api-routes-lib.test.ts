/**
 * Shared API route collector — locks path normalization used by openapi + docs gates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  collectApiRouteFiles,
  collectApiRouteDefinitions,
  collectApiRouteUrlPaths,
  toApiUrlPath,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

test("toApiUrlPath maps [id] and [...slug] to OpenAPI-style braces", () => {
  const apiRoot = path.join("C:", "repo", "src", "app", "api");
  assert.equal(
    toApiUrlPath(path.join(apiRoot, "providers", "[id]", "models"), apiRoot).replace(/\\/g, "/"),
    "/api/providers/{id}/models"
  );
  assert.equal(
    toApiUrlPath(path.join(apiRoot, "files", "[...path]"), apiRoot).replace(/\\/g, "/"),
    "/api/files/{path}"
  );
});

test("optional catch-all routes expose both the base and suffixed OpenAPI paths", () => {
  const apiRoot = path.join("C:", "repo", "src", "app", "api");
  assert.deepEqual(
    toApiUrlPaths(
      path.join(apiRoot, "v1", "vscode", "combos", "[token]", "[[...slug]]"),
      apiRoot
    ).map((url) => url.replace(/\\/g, "/")),
    ["/api/v1/vscode/combos/{token}", "/api/v1/vscode/combos/{token}/{slug}"]
  );
});

test("live repo has route files and matching URL paths", () => {
  const files = collectApiRouteFiles();
  const urls = collectApiRouteUrlPaths();
  assert.ok(files.size > 50, `expected many route files, got ${files.size}`);
  assert.ok(urls.length > 50, `expected many url paths, got ${urls.length}`);
  assert.ok(urls.length >= files.size, "optional catch-all routes may yield two URL paths");
  assert.ok([...files].every((f) => f.startsWith("src/app/api/") && /route\.tsx?$/.test(f)));
  assert.ok(urls.every((u) => u.startsWith("/api")));
  assert.ok(urls.includes("/api/v1/vscode/combos/{token}"));
  assert.ok(urls.includes("/api/v1/vscode/combos/{token}/{slug}"));
});

test("live route inventory includes explicit HEAD and mutation methods", () => {
  const routes = collectApiRouteDefinitions();
  assert.deepEqual(routes.get("/api/v1/models"), ["GET", "HEAD"]);
  assert.deepEqual(routes.get("/api/v1/models/{model}"), ["GET", "HEAD"]);
  assert.deepEqual(routes.get("/api/usage/diagnostic-overflow"), ["GET", "HEAD"]);
  assert.ok(routes.get("/api/providers")?.includes("PATCH"));
  assert.ok(routes.get("/api/providers")?.includes("DELETE"));
});
