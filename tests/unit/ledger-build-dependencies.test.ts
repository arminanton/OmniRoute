import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyResolvedBuild } from "../../scripts/build/verify-resolved-build.mjs";

test("source lock and resolved framework are pinned together, drift fails before building", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-build-proof-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        dependencies: { next: "16.3.8" },
        devDependencies: { "eslint-config-next": "16.3.8" },
      })
    );
    const packages = {
      "node_modules/next": { version: "16.3.8", integrity: "sha512-synthetic" },
      "node_modules/eslint-config-next": { version: "16.3.8", integrity: "sha512-synthetic" },
      "node_modules/@next/swc-linux-arm64-gnu": { version: "16.3.8" },
    };
    fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages }));
    for (const name of ["next", "eslint-config-next"]) {
      fs.mkdirSync(path.join(root, "node_modules", name), { recursive: true });
      fs.writeFileSync(
        path.join(root, "node_modules", name, "package.json"),
        JSON.stringify({ version: "16.3.8" })
      );
    }
    assert.equal(verifyResolvedBuild(root).next, "16.3.8");
    fs.writeFileSync(
      path.join(root, "node_modules/next/package.json"),
      JSON.stringify({ version: "16.3.3" })
    );
    assert.throws(() => verifyResolvedBuild(root), /drift/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("repository lock framework and platform entries match the reviewed installed version", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  assert.equal(verifyResolvedBuild(root).next, "16.3.8");
});
