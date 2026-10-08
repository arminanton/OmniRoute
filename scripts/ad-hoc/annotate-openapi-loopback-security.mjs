#!/usr/bin/env node
// Keep OpenAPI's x-loopback-only operation annotations aligned with routeGuard.
// Dry-run by default; pass --apply to insert missing annotations into docs/openapi.yaml.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_PATH = path.join(ROOT, "docs", "openapi.yaml");
const APPLY = process.argv.includes("--apply");
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

// routeGuard imports server modules that can initialize SQLite. Keep this documentation tool
// isolated from the operator's real database, even when run on the live host.
const temporaryDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-openapi-loopback-"));
process.env.DATA_DIR = temporaryDataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.on("exit", () => {
  fs.rmSync(temporaryDataDir, { recursive: true, force: true });
});

const { isLocalOnlyPath } = await import("../../src/server/authz/routeGuard.ts");
const specText = fs.readFileSync(SPEC_PATH, "utf8");
const spec = yaml.load(specText);
const paths = spec?.paths ?? {};
const missing = new Set();

for (const [pathTemplate, pathItem] of Object.entries(paths)) {
  if (!pathTemplate.startsWith("/api/") || !pathItem || typeof pathItem !== "object") continue;
  const concretePath = pathTemplate.replace(/\{[^}]+\}/g, "loopback-segment");
  if (!isLocalOnlyPath(concretePath)) continue;
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!METHODS.has(method.toLowerCase()) || !operation || typeof operation !== "object") continue;
    if (operation["x-loopback-only"] !== true) {
      missing.add(`${method.toLowerCase()} ${pathTemplate}`);
    }
  }
}

const lines = specText.split("\n");
const output = [];
let currentPath = null;
let insidePaths = false;
let inserted = 0;
for (const line of lines) {
  if (line === "paths:") insidePaths = true;
  if (insidePaths && line === "components:") insidePaths = false;
  const pathMatch = insidePaths ? /^ {2}(\/[^\s:]+):\s*$/.exec(line) : null;
  if (pathMatch) currentPath = pathMatch[1];
  output.push(line);
  const methodMatch = insidePaths ? /^ {4}(get|put|post|delete|options|head|patch|trace):\s*$/.exec(line) : null;
  if (!currentPath || !methodMatch) continue;
  const key = `${methodMatch[1]} ${currentPath}`;
  if (!missing.has(key)) continue;
  output.push("      x-loopback-only: true");
  inserted++;
}

console.log(`OpenAPI operations classified loopback-only and missing annotation: ${missing.size}`);
if (!APPLY) {
  for (const operation of [...missing].sort().slice(0, 12)) console.log(`  - ${operation}`);
  if (missing.size > 12) console.log(`  … ${missing.size - 12} more`);
  console.log("(dry-run) pass --apply to update docs/openapi.yaml");
  process.exit(0);
}

if (inserted !== missing.size) {
  throw new Error(`Refusing partial update: found ${missing.size} operations but inserted ${inserted}`);
}
fs.writeFileSync(SPEC_PATH, output.join("\n"));
console.log(`Annotated ${inserted} operations in docs/openapi.yaml`);
