#!/usr/bin/env node

/**
 * Verify that literal 4xx/5xx status codes in exported API route handlers are
 * declared by the corresponding OpenAPI operation. This is deliberately a
 * narrow source screen: it does not infer dynamic statuses, delegated/helper
 * response bodies, auth middleware outcomes, or schema/body equivalence.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as yaml from "js-yaml";
import {
  apiRoot,
  collectApiRouteFiles,
  collectApiRouteMethods,
  toApiUrlPaths,
} from "./lib/apiRoutes.mjs";

function getHandlerSource(source, method) {
  const exportPattern =
    /export\s+(?:async\s+)?(?:function\s+|const\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\b/g;
  const handlers = [...source.matchAll(exportPattern)];
  const handler = handlers.find((candidate) => candidate[1].toLowerCase() === method);
  if (!handler) return source;
  const next = handlers.find((candidate) => candidate.index > handler.index);
  return source.slice(handler.index, next?.index ?? source.length);
}

export function collectOpenApiLiteralErrorStatusGaps(root) {
  const spec = yaml.load(fs.readFileSync(path.join(root, "docs/openapi.yaml"), "utf8"));
  const gaps = [];

  for (const relativeFile of collectApiRouteFiles(root)) {
    const absoluteFile = path.join(root, relativeFile);
    const source = fs.readFileSync(absoluteFile, "utf8");
    const methods = collectApiRouteMethods(absoluteFile).map((method) => method.toLowerCase());

    for (const route of toApiUrlPaths(path.dirname(absoluteFile), apiRoot(root))) {
      for (const method of methods) {
        const operation = spec.paths?.[route]?.[method];
        if (!operation) continue; // The route-coverage gate reports missing operations.

        const handlerSource = getHandlerSource(source, method);
        const literalStatuses = new Set(
          [...handlerSource.matchAll(/\bstatus\s*:\s*([45]\d\d)\b/g)].map((match) => match[1])
        );
        const responses = operation.responses ?? {};

        for (const status of literalStatuses) {
          if (responses[status] || responses[`${status[0]}XX`] || responses.default) continue;
          gaps.push({ method: method.toUpperCase(), route, status, source: relativeFile });
        }
      }
    }
  }

  return gaps;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const gaps = collectOpenApiLiteralErrorStatusGaps(root);
  if (gaps.length > 0) {
    console.error(
      `[openapi-literal-errors] FAIL — ${gaps.length} literal handler status code(s) lack a response declaration`
    );
    for (const gap of gaps) {
      console.error(`  ${gap.method} ${gap.route} ${gap.status} (${gap.source})`);
    }
    process.exitCode = 1;
    return;
  }

  const routeFileCount = collectApiRouteFiles(root).size;
  console.log(
    `[openapi-literal-errors] PASS — no missing literal 4xx/5xx declarations across ${routeFileCount} route files`
  );
  console.log(
    "[openapi-literal-errors] NOTE — dynamic/helper/middleware responses and error-body schemas require separate semantic review."
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main();
