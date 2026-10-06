import fs from "node:fs";
import path from "node:path";

/** Reject source/lock/installed build drift before compilation, never silently use another Next. */
export function verifyResolvedBuild(projectRoot) {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, "package-lock.json"), "utf8"));
  const dependencies = ["next", "eslint-config-next"];
  for (const name of dependencies) {
    const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
    const pinned = lock.packages?.[`node_modules/${name}`];
    const installed = JSON.parse(
      fs.readFileSync(path.join(projectRoot, "node_modules", name, "package.json"), "utf8")
    );
    if (
      !/^\d+\.\d+\.\d+$/.test(declared ?? "") ||
      pinned?.version !== declared ||
      installed.version !== declared ||
      typeof pinned.integrity !== "string"
    )
      throw new Error(
        `Build dependency drift: ${name}; require exact matching source, lock and installed artifact.`
      );
  }
  const version = pkg.dependencies.next;
  for (const [name, value] of Object.entries(lock.packages ?? {})) {
    if (name.startsWith("node_modules/@next/swc-") && value.version !== version)
      throw new Error("Next platform binary lock differs from framework version.");
  }
  return {
    schema: "omni-build-dependencies/v1",
    next: version,
    eslintConfigNext: pkg.devDependencies["eslint-config-next"],
  };
}
