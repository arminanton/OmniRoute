import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";

const canonicalPath = path.join(process.cwd(), "docs/openapi.yaml");
const publicPath = path.join(process.cwd(), "public/openapi.yaml");
const document = yaml.load(fs.readFileSync(canonicalPath, "utf8")) as Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

test("the public OpenAPI artifact is synchronized with the canonical document", () => {
  assert.deepEqual(fs.readFileSync(publicPath), fs.readFileSync(canonicalPath));
});

test("all local OpenAPI JSON Pointer references resolve", () => {
  const unresolved: string[] = [];

  function walk(value: unknown, location: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${location}/${index}`));
      return;
    }
    if (!isObject(value)) return;

    const ref = value.$ref;
    if (typeof ref === "string" && ref.startsWith("#/")) {
      let target: unknown = document;
      const parts = ref
        .slice(2)
        .split("/")
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
      for (const part of parts) {
        if (Array.isArray(target)) {
          target = target[Number(part)];
        } else if (isObject(target)) {
          target = target[part];
        } else {
          target = undefined;
        }
      }
      if (target === undefined) unresolved.push(`${location}: ${ref}`);
    }

    for (const [key, child] of Object.entries(value)) walk(child, `${location}/${key}`);
  }

  walk(document, "#");
  assert.deepEqual(unresolved, []);
});
