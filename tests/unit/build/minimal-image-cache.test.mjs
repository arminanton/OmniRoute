import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("minimal immutable builds avoid disk caches while normal builds retain their cache", () => {
  for (const [profile, expected] of [
    ["minimal", false],
    ["", "fixture-cache"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const webpack = require("next/dist/compiled/webpack/webpack").webpack;
      const { default: config } = await import("./next.config.mjs");
      const output = await config.webpack({
        context: process.cwd(), cache: "fixture-cache", plugins: [],
        optimization: {}, resolve: {alias: {}}, module: {rules: []},
      }, {dev: false, isServer: true, webpack, defaultLoaders: {babel: {loader: "fixture"}}});
      console.log(JSON.stringify({cache: output.cache}));
      process.exit(0);
    `,
      ],
      {
        env: { ...process.env, OMNIROUTE_BUILD_PROFILE: profile, NODE_ENV: "production" },
        encoding: "utf8",
        timeout: 20000,
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.split("\n").find((s) => s.startsWith('{"cache":'));
    assert.ok(line);
    assert.equal(JSON.parse(line).cache, expected);
  }
});
