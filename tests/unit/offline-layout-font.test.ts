import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("root layout keeps its system-font stack without an unused build-time Google fetch", () => {
  const layout = readFileSync(new URL("../../src/app/layout.tsx", import.meta.url), "utf8");
  const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(layout, /next\/font\/google/);
  assert.match(layout, /className="font-sans antialiased"/);
  assert.doesNotMatch(css, /var\(--font-inter\)/);
  assert.match(css, /--font-sans:\s*-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif/);
});
