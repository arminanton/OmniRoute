/**
 * Shared filesystem inventory of Next.js App Router API routes.
 *
 * Existence reason: openapi-routes (spec→route), docs-symbols (prose→route),
 * and openapi-coverage (route→spec %) all need the same walk of src/app/api.
 * One collector keeps path normalization consistent and avoids triple walks
 * when a combined gate runs them together.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} [root] repo root
 * @returns {string} absolute path to src/app/api
 */
export function apiRoot(root = process.cwd()) {
  return path.join(root, "src", "app", "api");
}

/**
 * Convert a directory under src/app/api (the folder that contains route.ts)
 * to its OpenAPI-style /api/... path templates.
 * Dynamic segments: [id] → {id}, [...slug] → {slug}. An optional catch-all
 * ([[...slug]]) maps to both its zero-segment and one-or-more-segment forms.
 *
 * @param {string} routeDir absolute directory containing route.ts
 * @param {string} apiRootAbs absolute src/app/api
 * @returns {string}
 */
function normalizeRouteSegment(segment) {
  const optionalCatchAll = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
  if (optionalCatchAll) return `{${optionalCatchAll[1]}}`;
  const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/);
  if (catchAll) return `{${catchAll[1]}}`;
  const dynamic = segment.match(/^\[([^\]]+)\]$/);
  if (dynamic) return `{${dynamic[1]}}`;
  return segment;
}

export function toApiUrlPaths(routeDir, apiRootAbs) {
  const rel = path.relative(apiRootAbs, routeDir).replace(/\\/g, "/");
  if (!rel || rel === ".") return ["/api"];
  const segments = rel.split("/");
  const optionalIndex = segments.findIndex((segment) => /^\[\[\.\.\.[^\]]+\]\]$/.test(segment));
  if (optionalIndex >= 0) {
    if (optionalIndex !== segments.length - 1) {
      throw new Error(`Optional catch-all route segment must be last: ${rel}`);
    }
    const prefix = segments.slice(0, optionalIndex).map(normalizeRouteSegment).join("/");
    const parameter = normalizeRouteSegment(segments[optionalIndex]);
    const base = prefix ? `/api/${prefix}` : "/api";
    return [base, `${base}/${parameter}`];
  }
  return [`/api/${segments.map(normalizeRouteSegment).join("/")}`];
}

/** Backward-compatible single path accessor; optional catch-alls return the suffixed form. */
export function toApiUrlPath(routeDir, apiRootAbs) {
  return toApiUrlPaths(routeDir, apiRootAbs).at(-1);
}

/**
 * Walk src/app/api for route.ts(x) → OpenAPI-style URL paths.
 * @param {string} [root]
 * @returns {string[]}
 */
export function collectApiRouteUrlPaths(root = process.cwd()) {
  const API = apiRoot(root);
  if (!fs.existsSync(API)) return [];
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /^route\.tsx?$/.test(entry.name)) {
        out.push(...toApiUrlPaths(path.dirname(full), API));
      }
    }
  }
  walk(API);
  return [...new Set(out)];
}

/**
 * Walk src/app/api → relative repo paths to route.ts (docs-symbols resolver).
 * @param {string} [root]
 * @returns {Set<string>}
 */
export function collectApiRouteFiles(root = process.cwd()) {
  const API = apiRoot(root);
  const out = new Set();
  if (!fs.existsSync(API)) return out;
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /^route\.tsx?$/.test(entry.name)) {
        out.add(path.relative(root, full).replace(/\\/g, "/"));
      }
    }
  }
  walk(API);
  return out;
}

const ROUTE_METHOD_RE =
  /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s+const\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|export\s*\{[^}]*\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b[^}]*\}/g;

/** Extract explicitly exported HTTP methods; OPTIONS is handled by shared CORS middleware. */
export function collectApiRouteMethods(routeFile) {
  const source = fs.readFileSync(routeFile, "utf8");
  const methods = new Set();
  for (const match of source.matchAll(ROUTE_METHOD_RE)) {
    const direct = match[1] || match[2];
    if (direct) methods.add(direct);
    if (match[3]) {
      for (const inner of match[0].matchAll(/\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) {
        methods.add(inner[1]);
      }
    }
  }
  methods.delete("OPTIONS");
  return [...methods].sort();
}

/** Map each documented URL template to the explicit methods exported by its route file. */
export function collectApiRouteDefinitions(root = process.cwd()) {
  const apiRootAbs = apiRoot(root);
  const routes = new Map();
  for (const relativeFile of collectApiRouteFiles(root)) {
    const absoluteFile = path.join(root, relativeFile);
    const methods = collectApiRouteMethods(absoluteFile);
    for (const url of toApiUrlPaths(path.dirname(absoluteFile), apiRootAbs)) {
      const merged = new Set([...(routes.get(url) ?? []), ...methods]);
      routes.set(url, [...merged].sort());
    }
  }
  return routes;
}
