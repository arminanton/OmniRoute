import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

test("minimal webpack replacements resolve all privileged stubs from project root, regardless of importer", () => {
  const projectRoot = process.cwd();
  const source = fs.readFileSync(path.join(projectRoot, "next.config.mjs"), "utf8");
  const start = source.indexOf("      const replacements = [");
  const end = source.indexOf("\n    }\n\n    return config;", start);
  assert.ok(start > 0 && end > start);
  const plugins = [];
  class NormalModuleReplacementPlugin {
    constructor(pattern, callback) {
      this.pattern = pattern;
      this.callback = callback;
    }
  }
  // Execute the production plugin registration against the same callback interface webpack uses.
  // Only trusted checked-in config code is evaluated; no application/request input is involved.
  vm.runInNewContext(source.slice(start, end), {
    projectRoot,
    resolve: path.resolve,
    config: { plugins },
    webpack: { NormalModuleReplacementPlugin },
  });
  const expected = new Map([
    ["@/mitm/cert/install", "src/mitm/cert/install.stub.ts"],
    ["@/lib/zed-oauth/keychain-reader", "src/lib/zed-oauth/keychain-reader.stub.ts"],
    ["@/lib/cloudSync", "src/lib/cloudSync.stub.ts"],
    ["@/lib/services/installers/ninerouter", "src/lib/services/installers/ninerouter.stub.ts"],
  ]);
  assert.equal(plugins.length, expected.size);
  for (const [request, stub] of expected) {
    const plugin = plugins.find((p) => p.pattern.test(request));
    assert.ok(plugin, request);
    for (const context of [
      "src/app/api/providers/id/test",
      "src/lib/usage",
      "src/app/api/cloud/models/alias",
    ]) {
      const resource = { request, context: path.join(projectRoot, context) };
      plugin.callback(resource);
      assert.equal(resource.request, path.join(projectRoot, stub));
      assert.equal(path.isAbsolute(resource.request), true);
      assert.equal(fs.existsSync(resource.request), true);
      assert.ok(!resource.request.includes("better-sqlite3.stub"));
    }
  }
});
