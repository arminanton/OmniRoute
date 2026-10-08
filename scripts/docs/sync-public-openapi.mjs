#!/usr/bin/env node

/**
 * Keep the statically served `/openapi.yaml` identical to the canonical
 * `docs/openapi.yaml` used by the API explorer, agent-skill parser, and docs
 * checks. Run with `--write` to update the public copy or `--check` to fail on
 * drift. No YAML parsing or re-serialization is done, so comments and formatting
 * remain byte-for-byte preserved.
 */
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const canonicalPath = path.join(root, "docs", "openapi.yaml");
const publicPath = path.join(root, "public", "openapi.yaml");
const write = process.argv.includes("--write");
const check = process.argv.includes("--check");

if (write === check) {
  console.error("Usage: node scripts/docs/sync-public-openapi.mjs --check|--write");
  process.exit(2);
}

if (!fs.existsSync(canonicalPath)) {
  console.error(`[openapi-sync] canonical spec missing: ${path.relative(root, canonicalPath)}`);
  process.exit(1);
}

const canonical = fs.readFileSync(canonicalPath);
if (write) {
  fs.writeFileSync(publicPath, canonical);
  console.log(`[openapi-sync] copied docs/openapi.yaml to public/openapi.yaml (${canonical.length} bytes)`);
  process.exit(0);
}

if (!fs.existsSync(publicPath) || !fs.readFileSync(publicPath).equals(canonical)) {
  console.error("[openapi-sync] public/openapi.yaml differs from canonical docs/openapi.yaml; run the --write form");
  process.exit(1);
}

console.log(`[openapi-sync] public/openapi.yaml matches docs/openapi.yaml (${canonical.length} bytes)`);
