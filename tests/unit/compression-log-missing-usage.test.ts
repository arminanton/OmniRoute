import { test } from "node:test";
import assert from "node:assert/strict";
import { getCompressionLogStats } from "../../src/shared/utils/compressionLogStats.ts";
test("failed request with no measured usage never reports 100% savings", () => {
  assert.equal(getCompressionLogStats(37157, 0), null);
  assert.equal(getCompressionLogStats(37157, NaN), null);
});
test("real measured savings retain their before/after ratio", () => {
  assert.deepEqual(getCompressionLogStats(80, 20), { from: 100, to: 20, percent: 80 });
  assert.equal(getCompressionLogStats(null, 20), null);
});
