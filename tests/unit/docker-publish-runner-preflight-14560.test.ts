import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/docker-publish.yml", import.meta.url),
  "utf8"
);
const shouldPromoteLatestScript = fileURLToPath(
  new URL("../../scripts/ci/should-promote-latest.sh", import.meta.url)
);

function job(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = lines.findIndex((line, index) => index > start && /^  [a-z][a-z-]*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

function shouldPromote(version: string, tags: string[]): string {
  return execFileSync("bash", [shouldPromoteLatestScript, version], {
    input: tags.join("\n") + (tags.length ? "\n" : ""),
    encoding: "utf8",
  }).trim();
}

test("offline omni-build pool fails preflight with actionable recovery steps", () => {
  const preflight = job("runner-preflight");
  assert.match(preflight, /gh api --paginate/);
  assert.match(preflight, /select\(\.status == "online"\)/);
  assert.match(preflight, /select\(\.name == "omni-build"\)/);
  assert.match(preflight, /No online self-hosted runner has the omni-build label/);
  assert.match(preflight, /Restart the self-hosted runner listener/);
  assert.match(preflight, /USE_VPS_RUNNER=false/);
  assert.match(preflight, /::error title=No online omni-build runner::\$MESSAGE/);
  assert.match(preflight, /exit 1/);
});

test("VPS preflight fails closed on missing token or runner API/auth/parse failure", () => {
  const preflight = job("runner-preflight");
  assert.match(preflight, /vars\.USE_VPS_RUNNER == 'true'/);
  assert.match(preflight, /GH_TOKEN: \$\{\{ secrets\.RUNNER_STATUS_TOKEN \}\}/);
  assert.doesNotMatch(preflight, /github\.token/);
  assert.match(
    preflight,
    /if \[ -z "\$\{GH_TOKEN:-\}" \][\s\S]*?repository Administration: read permission[\s\S]*?exit 1/
  );
  assert.match(
    preflight,
    /if ! ONLINE_RUNNERS=\$\(gh api --paginate[\s\S]*?then[\s\S]*?Could not query or parse Actions runners[\s\S]*?repository Administration: read permission[\s\S]*?exit 1/
  );
  assert.doesNotMatch(preflight, /allowing publish to continue|exit 0/);
});

test("schedule alerts without building or publishing; publish jobs explicitly skip schedule", () => {
  const prepare = job("prepare");
  const preflight = job("runner-preflight");
  const build = job("build");
  const merge = job("merge");
  const alert = job("runner-alert");
  assert.match(workflow, /schedule:\n    - cron: "41 4 \* \* \*"/);
  assert.match(
    workflow,
    /concurrency:\n  group: docker-publish-\$\{\{ github\.event_name == 'schedule' && 'runner-alert' \|\| github\.ref \}\}\n  cancel-in-progress: \$\{\{ github\.event_name != 'schedule' \}\}/
  );
  assert.match(alert, /concurrency:\n      group: runner-alert\n      cancel-in-progress: false/);
  assert.match(
    alert,
    /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/
  );
  for (const section of [prepare, preflight, build, merge]) {
    assert.match(section, /github\.event_name != 'schedule'/);
  }
  assert.doesNotMatch(alert, /docker\/build-push-action|packages:\s*write|docker (?:build|push)/);
  assert.match(build, /timeout-minutes: 350/);
  assert.match(build, /does not bound runner queue time/);
});

test("runner alert dedupes offline issue, posts fresh evidence, and closes on recovery", () => {
  const alert = job("runner-alert");
  assert.match(alert, /permissions:\n      issues: write/);
  assert.match(alert, /state=all&per_page=100/);
  assert.match(
    alert,
    /select\(\.pull_request == null and \.title == "\[Runner Alert\] omni-build runner pool offline"\)/
  );
  assert.match(alert, /Fresh Actions API evidence at \$TIMESTAMP/);
  assert.match(
    alert,
    /if \[ -n "\$OPEN_ISSUES" \][\s\S]*?gh issue comment[\s\S]*?else[\s\S]*?gh issue create/
  );
  assert.match(
    alert,
    /omni-build runner pool recovered[\s\S]*?Fresh Actions API evidence[\s\S]*?gh api --method PATCH[\s\S]*?state=closed/
  );
});

test("manual :latest promotion is opt-in and limited to the highest stable tag", () => {
  const prepare = job("prepare");
  const dispatchPromotion = prepare.match(
    /elif \[ "\$EVENT_NAME" = "workflow_dispatch" \]; then([\s\S]*?)\n          else/
  );
  assert.ok(dispatchPromotion, "workflow_dispatch promotion guard must exist");
  assert.match(
    dispatchPromotion[1],
    /if \[ "\$\{PROMOTE_INPUT:-false\}" = "true" \]; then/
  );
  assert.match(
    dispatchPromotion[1],
    /PROMOTE=\$\(git tag -l 'v\[0-9\]\*' \| bash scripts\/ci\/should-promote-latest\.sh "\$VERSION"\)/
  );

  // Exercise the exact semver helper the workflow calls with visible tag history.
  assert.equal(shouldPromote("3.8.50", ["v3.8.50", "v3.9.0"]), "false");
  assert.equal(shouldPromote("3.9.0", ["v3.8.50", "v3.9.0"]), "true");
});
