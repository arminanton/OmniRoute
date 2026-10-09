import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { classifyRoute } from "../../src/server/authz/classify.ts";
import { inferRequiredScope } from "../../src/server/authz/accessScopes.ts";
import { isAlwaysProtectedPath } from "../../src/server/authz/routeGuard.ts";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "../../scripts/check/lib/apiRoutes.mjs";

const ROOT = process.cwd();
const spec = parse(fs.readFileSync(path.join(ROOT, "docs/openapi.yaml"), "utf8")) as any;
const publicSpec = parse(fs.readFileSync(path.join(ROOT, "public/openapi.yaml"), "utf8")) as any;
const ROUTE = "/api/cli-tools/detect";
const ROUTE_FILE = "src/app/api/cli-tools/detect/route.ts";

function sourceOperations() {
  const root = apiRoot(ROOT);
  const result = new Set<string>();
  for (const relativeFile of collectApiRouteFiles(ROOT)) {
    if (relativeFile !== ROUTE_FILE) continue;
    const absoluteFile = path.join(ROOT, relativeFile);
    for (const apiPath of toApiUrlPaths(path.dirname(absoluteFile), root)) {
      for (const method of collectApiRouteMethods(absoluteFile)) {
        result.add(`${method.toLowerCase()} ${apiPath}`);
      }
    }
  }
  return result;
}

test("CLI detect is an always-protected, admin-token route whose OAS has no anonymous alternative", () => {
  assert.deepEqual([...sourceOperations()], [`get ${ROUTE}`]);
  const op = spec.paths?.[ROUTE]?.get;
  assert.ok(op, `missing GET ${ROUTE}`);
  assert.equal(classifyRoute(ROUTE, "GET").routeClass, "MANAGEMENT");
  assert.equal(isAlwaysProtectedPath(ROUTE), true);
  assert.equal(inferRequiredScope("GET", ROUTE), "admin");
  assert.equal(op["x-always-protected"], true);
  assert.match(
    op.description ?? "",
    /returns each readable configuration file as verbatim `configContents`/
  );
  assert.match(op.description ?? "", /must have `admin` scope/);
  assert.match(op.description ?? "", /always-protected.*requireLogin=false/s);

  for (const scheme of [
    "BearerAuth",
    "ManagementSessionAuth",
    "LocalCliTokenAuth",
    "InternalServiceTokenAuth",
  ]) {
    assert.ok(op.security?.some((alternative: Record<string, unknown>) => scheme in alternative));
  }
  assert.ok(
    !op.security?.some(
      (alternative: Record<string, unknown>) => Object.keys(alternative).length === 0
    ),
    "detect must not advertise anonymous access"
  );
  assert.equal(op.responses?.["200"]?.["x-sensitive"], true);
  assert.equal(
    op.responses?.["200"]?.content?.["application/json"]?.schema?.$ref,
    "#/components/schemas/CliToolsDetectResponse"
  );
  const detected = spec.components.schemas.CliToolDetectedTool;
  assert.equal(detected.properties.configContents["x-sensitive"], true);
  assert.match(
    detected.properties.configContents.description,
    /API keys, tokens, or other secrets/
  );
});

test("CLI detect source actually reads and returns unfiltered local config contents", () => {
  const routeSource = fs.readFileSync(path.join(ROOT, ROUTE_FILE), "utf8");
  assert.ok(routeSource.includes("detectTool(toolId)"));
  assert.ok(routeSource.includes("detectAllTools()"));
  assert.ok(routeSource.includes("return NextResponse.json(tool)"));

  const detectorSource = fs.readFileSync(
    path.join(ROOT, "src/lib/cli-helper/tool-detector.ts"),
    "utf8"
  );
  assert.ok(detectorSource.includes("const configContents = await readConfigFile(configPath)"));
  assert.ok(detectorSource.includes("configContents: configContents ?? undefined"));
  assert.ok(detectorSource.includes('execFileImpl(binary, ["--version"]'));
  assert.ok(detectorSource.includes('return readFileSync(expanded, "utf-8")'));

  assert.deepEqual(publicSpec, spec, "public OpenAPI artifact must mirror canonical docs");
});
