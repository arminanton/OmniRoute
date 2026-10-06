import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack");
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("actual Next SWC/Webpack web graph imports shared Antigravity versions without Node ownership modules", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omni-version-client-"));
  try {
    const entry = path.join(root, "client.mjs");
    fs.writeFileSync(
      entry,
      '"use client";\n' +
        `import {getCachedAntigravityCliVersion,resolveAntigravityCliVersion} from ${JSON.stringify(path.join(source, "open-sse/services/antigravityVersion.ts"))};\nexport function fingerprint(){return getCachedAntigravityCliVersion();}\nexport function refresh(){return resolveAntigravityCliVersion();}\n`
    );
    await require("next/dist/build/swc").loadBindings();
    const compiler = webpack({
      mode: "production",
      target: "web",
      entry,
      devtool: false,
      cache: false,
      output: { path: path.join(root, "dist"), filename: "client.js" },
      optimization: { minimize: false },
      resolve: {
        extensions: [".mjs", ".js", ".ts", ".tsx"],
        alias: {
          "@": path.join(source, "src"),
          "@omniroute/open-sse": path.join(source, "open-sse"),
        },
      },
      module: {
        rules: [
          {
            test: /\.[cm]?[jt]sx?$/,
            use: {
              loader: require.resolve("next/dist/build/webpack/loaders/next-swc-loader"),
              options: {
                isServer: false,
                rootDir: source,
                pagesDir: path.join(root, "pages"),
                appDir: path.join(root, "app"),
                jsConfig: { compilerOptions: {} },
                nextConfig: { experimental: {} },
                supportedBrowsers: ["chrome 120"],
              },
            },
          },
        ],
      },
    });
    const stats = await new Promise((resolve, reject) =>
      compiler.run((error, stats) => (error ? reject(error) : resolve(stats)))
    );
    const result = stats.toJson({ all: false, errors: true, warnings: true, modules: true });
    await new Promise((resolve, reject) =>
      compiler.close((error) => (error ? reject(error) : resolve()))
    );
    assert.equal(stats.hasErrors(), false, JSON.stringify(result.errors));
    assert.equal(stats.hasWarnings(), false, JSON.stringify(result.warnings));
    const graph = JSON.stringify(result.modules);
    assert.ok(graph.includes("antigravityVersion.ts"), "version module must actually be compiled");
    assert.ok(
      graph.includes("controlPlaneRuntime.ts"),
      "browser-safe runtime facade must actually be compiled"
    );
    for (const forbidden of [
      "node:crypto",
      "node:async_hooks",
      "logicalRetryBudget.ts",
      "generationLifetime.ts",
    ])
      assert.ok(!graph.includes(forbidden), forbidden + " reached client graph");
    assert.ok(fs.statSync(path.join(root, "dist/client.js")).size > 0);
    console.log(
      JSON.stringify({
        compiler: "Next vendored Webpack + next-swc-loader",
        target: "web",
        nodeOwnershipModules: 0,
      })
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
