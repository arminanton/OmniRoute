import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const directory = path.dirname(fileURLToPath(import.meta.url));
const [host, outputDirectory] = process.argv.slice(2);
const hosts = JSON.parse(fs.readFileSync(path.join(directory, "hosts.json"), "utf8"));
if (!hosts[host] || !outputDirectory)
  throw new Error("Usage: node prepare-host.mjs <maria|devvm> <review-output-directory>");
// Generate reviewable artifacts only; this command never installs or reloads Prime.
const source = fs.readFileSync(path.join(directory, "index.ts"), "utf8");
const prepared = source.replace(
  'process.env.OMNI_PRIME_BASE_URL || "http://127.0.0.1:20129/v1"',
  `process.env.OMNI_PRIME_BASE_URL || ${JSON.stringify(hosts[host].OMNI_PRIME_BASE_URL)}`
);
if (prepared === source && host !== "maria") throw new Error("Endpoint template no longer matches");
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(outputDirectory, "index.ts"), prepared, { mode: 0o600, flag: "wx" });
console.log(
  JSON.stringify({
    host,
    endpoint: hosts[host].OMNI_PRIME_BASE_URL,
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    artifactSha256: createHash("sha256").update(prepared).digest("hex"),
  })
);
