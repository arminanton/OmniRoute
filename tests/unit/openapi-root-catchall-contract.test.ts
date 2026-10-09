import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<string, Record<string, { responses?: Record<string, { content?: unknown }> }>>;
};

test("root API catch-all methods document only the JSON 404 returned by the handler", () => {
  const item = spec.paths["/api/{omnirouteApiCatchAll}"];
  for (const method of ["delete", "get", "patch", "post", "put"]) {
    assert.ok(item[method]?.responses?.["404"]?.content, `${method.toUpperCase()} JSON 404`);
    assert.equal(
      item[method]?.responses?.["200"],
      undefined,
      `${method.toUpperCase()} has no false 200`
    );
  }
  assert.equal(item.head?.responses?.["404"]?.content, undefined, "HEAD remains bodyless");
});
