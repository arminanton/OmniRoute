/** #6700: a scripts-denied install must still ship a working SQLite binding.
 * SQLite13 now packages GNU N-API prebuilts; its old gyp step is stamp-only.
 * Replace that step with strict offline load/query gates, never broad hooks.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

const docker = fs.readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const logical = docker
  .split(/\r?\n/)
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n")
  .replace(/\\\r?\n\s*/g, " ")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
function stage(name: string) {
  const start = logical.findIndex((line) => new RegExp(`^FROM \\S+ AS ${name}$`, "i").test(line));
  assert.ok(start >= 0, `missing ${name} stage`);
  const next = logical.findIndex((line, index) => index > start && /^FROM /i.test(line));
  return logical.slice(start, next < 0 ? undefined : next);
}
const lock = JSON.parse(
  fs.readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8")
);

test("#6700 locked SQLite13 and wreq3.2 require an offline native load gate after scripts-denied ci", () => {
  const deps = stage("dependencies");
  const ci = deps.findIndex((line) => /^RUN .*npm ci\b/.test(line));
  const gate = deps.indexOf(
    "RUN --network=none node scripts/build/verify-docker-native-deps.mjs --project-root=/app --node-root=/usr/local"
  );
  assert.ok(ci >= 0 && gate > ci);
  for (const flag of ["--ignore-scripts", "--include=optional", "--legacy-peer-deps"])
    assert.ok(deps[ci].includes(flag));
  assert.doesNotMatch(
    deps.join("\n"),
    /npm rebuild|npx|node-gyp\.js.*rebuild|--ignore-scripts=false|--omit=optional/
  );
  assert.ok(
    deps.some((line) => /^COPY scripts\/build\/verify-docker-native-deps\.mjs /.test(line))
  );
  for (const [name, version] of [
    ["better-sqlite3", "13.0.3"],
    ["wreq-js", "3.2.0"],
  ]) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry.version, version);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
  }
});

test("#6700 final SQLite package and UID1000 memory query are independent of optional hook policy", () => {
  const runner = stage("runner-base");
  const copy = runner.indexOf(
    "COPY --from=builder --chown=node:node /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3"
  );
  const user = runner.indexOf("USER node");
  const smoke = runner.findIndex(
    (line) =>
      /^RUN --network=none node -e /.test(line) &&
      line.includes("require('better-sqlite3')(':memory:')")
  );
  assert.ok(copy >= 0 && copy < user && user < smoke);
  assert.match(runner[smoke], /better-sqlite3\/package\.json.*13\.0\.3/);
  assert.match(runner[smoke], /SELECT 1 AS ok/);
  assert.match(runner[smoke], /db\.close\(\)/);
  assert.doesNotMatch(runner[smoke], /\|\||process\.exit\(0\)/);
  const builder = stage("builder").join("\n");
  assert.match(
    builder,
    /cp -a \/app\/node_modules\/better-sqlite3 \/app\/\.build\/next\/standalone\/node_modules\/better-sqlite3.*--require-tproxy --standalone-root=/
  );
});
