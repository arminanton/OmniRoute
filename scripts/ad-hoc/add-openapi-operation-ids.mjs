#!/usr/bin/env node
// Generate deterministic, route-derived OpenAPI operation IDs.
// Dry-run by default; pass --apply to insert IDs into docs/openapi.yaml.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { operationIdFor } from "../check/lib/openapiOperationIds.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_PATH = path.join(ROOT, "docs", "openapi.yaml");
const APPLY = process.argv.includes("--apply");
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

const source = fs.readFileSync(SPEC_PATH, "utf8");
const lines = source.split("\n");
const operations = [];
let inPaths = false;
let currentPath = null;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (line === "paths:") {
    inPaths = true;
    continue;
  }
  if (line === "components:") {
    inPaths = false;
    currentPath = null;
    continue;
  }
  if (!inPaths) continue;

  const pathMatch = /^ {2}(\/[^\s:]+):\s*$/.exec(line);
  if (pathMatch) {
    currentPath = pathMatch[1];
    continue;
  }
  const methodMatch = /^ {4}(get|put|post|delete|options|head|patch|trace):\s*$/i.exec(line);
  if (!currentPath || !methodMatch || !METHODS.has(methodMatch[1].toLowerCase())) continue;

  let hasOperationId = false;
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (/^ {2}(?:\/[^\s:]+|components):\s*$/.test(lines[cursor])) break;
    if (/^ {4}(get|put|post|delete|options|head|patch|trace):\s*$/i.test(lines[cursor])) break;
    if (/^ {6}operationId:\s*\S/.test(lines[cursor])) {
      hasOperationId = true;
      break;
    }
  }
  operations.push({
    path: currentPath,
    method: methodMatch[1].toLowerCase(),
    lineIndex: index,
    operationId: hasOperationId ? null : operationIdFor(methodMatch[1], currentPath),
  });
}

const ids = operations.map((operation) => operation.operationId).filter(Boolean);
const counts = new Map();
for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
const collisions = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
if (collisions.length) {
  throw new Error(`Generated operationId collision(s): ${collisions.join(", ")}`);
}

console.log(`OpenAPI operations: ${operations.length}; missing IDs: ${ids.length}; generated collisions: 0`);
if (!APPLY) {
  for (const operation of operations.filter((item) => item.operationId).slice(0, 12)) {
    console.log(`  ${operation.method.toUpperCase()} ${operation.path} → ${operation.operationId}`);
  }
  if (ids.length > 12) console.log(`  … ${ids.length - 12} more`);
  console.log("(dry-run) pass --apply to update docs/openapi.yaml");
  process.exit(0);
}

const generatedByLine = new Map(
  operations.filter((operation) => operation.operationId).map((operation) => [operation.lineIndex, operation.operationId])
);
const output = [];
for (let index = 0; index < lines.length; index += 1) {
  output.push(lines[index]);
  const operationId = generatedByLine.get(index);
  if (operationId) output.push(`      operationId: ${operationId}`);
}
fs.writeFileSync(SPEC_PATH, output.join("\n"));
console.log(`Inserted ${ids.length} operation IDs into docs/openapi.yaml`);
