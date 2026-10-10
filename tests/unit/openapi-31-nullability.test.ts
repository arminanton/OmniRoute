import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const spec = parse(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  openapi: string;
  components: {
    schemas: Record<string, { properties?: Record<string, { type?: unknown; enum?: unknown[] }> }>;
  };
};

function findNullableKeywords(
  value: unknown,
  currentPath = "$",
  seen = new Set<object>()
): string[] {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);

  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as const)
    : Object.entries(value);
  const paths = entries.flatMap(([key, entry]) =>
    findNullableKeywords(entry, `${currentPath}.${key}`, seen)
  );
  if (!Array.isArray(value) && Object.hasOwn(value, "nullable")) {
    paths.push(`${currentPath}.nullable`);
  }
  return paths;
}

test("OpenAPI 3.1 uses JSON Schema null types instead of the legacy nullable keyword", () => {
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(findNullableKeywords(spec), []);

  assert.deepEqual(spec.components.schemas.MemoryEntry.properties?.sessionId?.type, [
    "string",
    "null",
  ]);
  assert.deepEqual(spec.components.schemas.InMemoryLogDetailResponse.properties?.error?.type, [
    "string",
    "null",
  ]);
  assert.equal(
    spec.components.schemas.InspectorSession.properties?.profile?.enum?.includes(null),
    true
  );
});
