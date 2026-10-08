import test from "node:test";
import assert from "node:assert/strict";

import { retainNoAuthCustomModel } from "../../src/lib/providers/noAuthCatalogPolicy.ts";

test("retainNoAuthCustomModel tolerates optional row IDs without retaining unmatched imports", () => {
  const liveModels = [{ id: "gemini-3.8-flash" }];

  assert.equal(retainNoAuthCustomModel({ source: "manual" }, liveModels), true);
  assert.equal(
    retainNoAuthCustomModel({ id: "gemini-3.8-flash", source: "imported" }, liveModels),
    true
  );
  assert.equal(retainNoAuthCustomModel({ id: "missing", source: "imported" }, liveModels), false);
  assert.equal(retainNoAuthCustomModel({ source: "imported" }, liveModels), false);
});
