import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const fixtureRoot = fs.mkdtempSync(path.join(root, ".tmp-openapi-generator-regression-"));

test.after(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("OpenAPI module generator marks anonymous security alternatives as optional", () => {
  const generatorPath = path.join(fixtureRoot, "scripts/docs/gen-openapi-module.mjs");
  fs.mkdirSync(path.dirname(generatorPath), { recursive: true });
  fs.copyFileSync(path.join(root, "scripts/docs/gen-openapi-module.mjs"), generatorPath);
  fs.mkdirSync(path.join(fixtureRoot, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(fixtureRoot, "docs/openapi.yaml"),
    `openapi: 3.1.0
info:
  title: Generator regression fixture
  version: 0.0.0
paths:
  /api/v1/optional-auth:
    get:
      summary: Optional auth
      security:
        - BearerAuth: []
        - {}
  /api/v1/required-auth:
    get:
      summary: Required auth
      security:
        - BearerAuth: []
  /api/v1/no-security:
    get:
      summary: No security
`,
    "utf8"
  );

  execFileSync(process.execPath, [generatorPath], {
    cwd: fixtureRoot,
    encoding: "utf8",
    timeout: 10_000,
  });

  const generated = fs.readFileSync(
    path.join(fixtureRoot, "src/app/docs/lib/openapi.generated.ts"),
    "utf8"
  );
  const generatedRequiresAuth = (routePath: string): boolean => {
    const routeMarker = `path: ${JSON.stringify(routePath)},\n    method: "GET"`;
    const start = generated.indexOf(routeMarker);
    assert.notEqual(start, -1, `generated endpoint ${routePath} exists`);
    const end = generated.indexOf("\n  },", start);
    const endpoint = generated.slice(start, end);
    const match = endpoint.match(/requiresAuth: (true|false)/);
    assert.ok(match, `generated endpoint ${routePath} includes requiresAuth`);
    return match[1] === "true";
  };

  assert.equal(generatedRequiresAuth("/api/v1/optional-auth"), false);
  assert.equal(generatedRequiresAuth("/api/v1/required-auth"), true);
  assert.equal(generatedRequiresAuth("/api/v1/no-security"), false);
});
