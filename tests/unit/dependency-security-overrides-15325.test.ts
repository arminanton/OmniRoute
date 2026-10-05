import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const rootPackage = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));

test("IBM Cloud SDK resolves the patched root axios instead of vulnerable nested 1.18.0", () => {
  assert.equal(rootPackage.overrides.axios, "^1.20.0");
  assert.equal(lock.packages["node_modules/axios"].version, "1.20.0");
  assert.equal(lock.packages["node_modules/ibm-cloud-sdk-core/node_modules/axios"], undefined);
});
