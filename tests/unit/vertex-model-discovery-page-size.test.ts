import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";

test("Vertex model discovery respects Google page size limit", () => {
  const source = fs.readFileSync("src/app/api/providers/[id]/models/route.ts", "utf8");
  assert.match(source, /generativelanguage\.googleapis\.com\/v1beta\/models\?pageSize=300/);
  assert.match(
    source,
    /aiplatform\.googleapis\.com\/v1beta1\/publishers\/google\/models\?pageSize=300/
  );
  assert.doesNotMatch(source, /generativelanguage\.googleapis\.com\/v1beta\/models\?pageSize=1000/);
});
