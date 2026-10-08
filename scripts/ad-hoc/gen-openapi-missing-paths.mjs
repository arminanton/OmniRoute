#!/usr/bin/env node
// One-shot generator (2026-08-31 docs audit follow-up nº 3): append a minimal,
// honest OpenAPI entry for every real route that docs/openapi.yaml does not
// document yet. Enumerates routes with the SAME lib the check:api-docs-refs
// gate uses, so the generated set can never diverge from the gate's universe.
// Minimal by design: real methods (parsed from each route.ts's exports), path
// parameters, a neutral summary and a default response. Rich schemas stay
// hand-curated until verified against each handler.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectApiRouteDefinitions } from "../check/lib/apiRoutes.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC = path.join(ROOT, "docs", "openapi.yaml");
const APPLY = process.argv.includes("--apply");

// Importing routeGuard reaches modules that initialize SQLite. Keep this
// one-shot documentation tool hermetic even when it runs on a host with a
// real ~/.omniroute database configured.
const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-openapi-gen-"));
process.env.DATA_DIR = temporaryDataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.on("exit", () => {
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
});

const { isLocalOnlyPath, ALWAYS_PROTECTED_API_PATHS } = await import(
  "../../src/server/authz/routeGuard.ts"
);

const normalizeParams = (p) => p.replace(/\{[^}]+\}/g, "{}");

// --- real routes + their explicitly exported HTTP methods ---------------------
const routes = collectApiRouteDefinitions(ROOT);

// --- paths already in the spec -------------------------------------------------
const spec = fs.readFileSync(SPEC, "utf8");
const specPaths = new Set();
for (const m of spec.matchAll(/^ {2}(\/[^\s:]+):\s*$/gm)) specPaths.add(normalizeParams(m[1]));

const missing = [...routes.entries()]
  .filter(([url]) => !specPaths.has(normalizeParams(url)))
  .filter(([, methods]) => methods.length > 0)
  .sort(([a], [b]) => a.localeCompare(b));

// --- tag + summary derivation --------------------------------------------------
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function groupTag(url) {
  const seg = url.replace(/^\/api\//, "").split("/");
  if (seg[0] === "v1") return seg[1] ? `V1 ${cap(seg[1].replace(/\{|\}/g, ""))}` : "V1";
  return cap(seg[0].replace(/\{|\}/g, "").replace(/-/g, " "));
}
function summaryFor(url, method) {
  const tail = url
    .replace(/^\/api\/(v1\/)?/, "")
    .replace(/\{([^}]+)\}/g, "<$1>")
    .replace(/[/]/g, " › ")
    .replace(/-/g, " ");
  return `${method} ${tail}`;
}

// --- emit YAML -----------------------------------------------------------------
const existingTags = new Set(
  [...spec.matchAll(/^ {2}- name: (.+)$/gm)].map((m) => m[1].trim().toLowerCase())
);
const newTags = new Map();
const lines = [];
lines.push("");
lines.push("  # --- Generated route inventory (docs audit follow-up) -----------------------");
lines.push("  # These entries document implemented paths/methods; request and response");
lines.push("  # schemas remain intentionally unspecified until verified from each handler.");
lines.push("  # Regenerate with: node --import tsx/esm scripts/ad-hoc/gen-openapi-missing-paths.mjs --apply");
for (const [url, methods] of missing) {
  const tag = groupTag(url);
  if (!existingTags.has(tag.toLowerCase()) && !newTags.has(tag))
    newTags.set(tag, `${tag} endpoints (generated route coverage)`);
  lines.push(`  ${url}:`);
  const pathParameters = [...url.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
  if (pathParameters.length > 0) {
    lines.push("    parameters:");
    for (const name of pathParameters) {
      lines.push(`      - name: ${name}`);
      lines.push("        in: path");
      lines.push("        required: true");
      lines.push("        schema:");
      lines.push("          type: string");
    }
  }
  const loopbackOnly = isLocalOnlyPath(url);
  const alwaysProtected = ALWAYS_PROTECTED_API_PATHS.includes(url);
  for (const method of methods.sort()) {
    lines.push(`    ${method.toLowerCase()}:`);
    lines.push(`      tags:`);
    lines.push(`        - ${tag}`);
    lines.push(`      summary: "${summaryFor(url, method)}"`);
    lines.push("      description: Route is implemented; detailed request/response schema has not been verified yet.");
    if (loopbackOnly || isLocalOnlyPath(url, method)) lines.push(`      x-loopback-only: true`);
    if (alwaysProtected) lines.push(`      x-always-protected: true`);
    lines.push(`      responses:`);
    lines.push(`        default:`);
    lines.push(`          description: Route-specific response; inspect the handler for status and body details.`);
  }
}

const tagLines = [...newTags.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, description]) => `  - name: ${name}\n    description: ${description}`)
  .join("\n");

console.log(
  `real routes: ${routes.size} · already in spec: ${specPaths.size} · missing with methods: ${missing.length} · new tags: ${newTags.size}`
);
if (!APPLY) {
  console.log("(dry-run) pass --apply to write docs/openapi.yaml");
  process.exit(0);
}

let out = spec;
// append new tags right after the last existing tag entry (before `paths:`)
if (tagLines) out = out.replace(/\npaths:\n/, `\n${tagLines}\n\npaths:\n`);
// insert generated paths right before the components section
out = out.replace(/\ncomponents:\n/, `\n${lines.join("\n")}\n\ncomponents:\n`);
fs.writeFileSync(SPEC, out);
console.log(`wrote ${missing.length} paths + ${newTags.size} tags to docs/openapi.yaml`);
