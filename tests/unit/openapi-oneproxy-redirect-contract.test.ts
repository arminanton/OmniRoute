import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import * as yaml from "js-yaml";

const spec = yaml.load(fs.readFileSync(path.join(process.cwd(), "docs/openapi.yaml"), "utf8")) as {
  paths: Record<
    string,
    Record<
      string,
      {
        security?: unknown[];
        responses?: Record<
          string,
          {
            headers?: Record<string, { schema?: { const?: string } }>;
            content?: unknown;
          }
        >;
      }
    >
  >;
};

test("legacy OneProxy aliases describe their authenticated empty permanent redirects", () => {
  const cases = [
    ["/api/settings/oneproxy", "delete", "/api/settings/free-proxies"],
    ["/api/settings/oneproxy", "get", "/api/settings/free-proxies"],
    ["/api/settings/oneproxy", "post", "/api/settings/free-proxies/sync"],
    ["/api/settings/oneproxy/rotate", "post", "/api/settings/free-proxies/sync"],
  ] as const;

  for (const [pathname, method, location] of cases) {
    const operation = spec.paths[pathname][method];
    assert.equal(operation.responses?.["200"], undefined, `${method.toUpperCase()} ${pathname}`);
    assert.equal(
      operation.responses?.["308"]?.headers?.Location?.schema?.const,
      location,
      `${method.toUpperCase()} ${pathname} redirect target`
    );
    assert.equal(operation.responses?.["308"]?.content, undefined, "redirect has no response body");
    assert.deepEqual(operation.security, [{ BearerAuth: [] }, { ManagementSessionAuth: [] }, {}]);
  }
});
