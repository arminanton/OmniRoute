import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = process.argv[2];
const revision = process.argv[3];
if (!out || !revision || !/^[a-f0-9]{40}$/.test(revision))
  throw new Error("Usage: build-maintenance.mjs OUT IMAGE_REVISION");
await mkdir(out, { recursive: true });
const result = await build({
  absWorkingDir: root,
  entryPoints: ["scripts/deploy/canary/maintenance-entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node26",
  packages: "external",
  external: ["/app/server-ws.mjs", "@/*"],
  metafile: true,
  outfile: resolve(out, "maintenance-entry.cjs"),
  tsconfig: resolve(root, "tsconfig.json"),
  logLevel: "warning",
});
if (
  result.warnings.length ||
  Object.values(result.metafile.outputs).some((output) =>
    output.imports.some(
      (item) =>
        item.external && !item.path.startsWith("node:") && item.path !== "/app/server-ws.mjs"
    )
  )
)
  throw new Error("Unexpected maintenance bundle dependency or warning");
await copyFile(
  resolve(root, "scripts/deploy/canary/maintenance-loader.mjs"),
  resolve(out, "maintenance-loader.mjs")
);
const sha = async (name) =>
  createHash("sha256")
    .update(await readFile(resolve(out, name)))
    .digest("hex");
await writeFile(
  resolve(out, "maintenance-build.json"),
  JSON.stringify(
    {
      compiler: "esbuild",
      inputs: Object.keys(result.metafile.inputs).sort(),
      externals: Object.values(result.metafile.outputs).flatMap((output) =>
        output.imports.filter((item) => item.external).map((item) => item.path)
      ),
    },
    null,
    2
  ) + "\n"
);
await writeFile(
  resolve(out, "maintenance-entry.json"),
  JSON.stringify(
    {
      schema: "omni-maintenance-entry/v1",
      imageRevision: revision,
      entrySha256: await sha("maintenance-entry.cjs"),
      loaderSha256: await sha("maintenance-loader.mjs"),
    },
    null,
    2
  ) + "\n"
);
