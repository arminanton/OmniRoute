import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = readFileSync(
  new URL("../../.github/workflows/docker-publish.yml", import.meta.url),
  "utf8"
);

function job(name: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = lines.findIndex((line, index) => index > start && /^  [a-z][a-z-]*:$/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
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
  assert.match(workflow, /schedule:[\s\S]*?cron:/);
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
