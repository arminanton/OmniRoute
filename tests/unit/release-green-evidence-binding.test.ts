import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { verifyReleaseGreenEvidence } = await import("../../scripts/quality/validate-release-green.mjs");
const sha = "a".repeat(40);
const runId = "123456789";

function report(overrides = {}) {
  return {
    schemaVersion: 1,
    candidateSha: sha,
    profile: "full",
    runId,
    releaseGreen: true,
    hardFailures: [],
    checks: [
      { id: "unit", kind: "hard", ok: true },
      { id: "ratchet", kind: "drift", ok: false },
    ],
    ...overrides,
  };
}

function verify(evidence = report(), exit = "0", candidate = sha, event = "schedule", run = runId) {
  return verifyReleaseGreenEvidence(evidence, exit, candidate, event, run);
}

test("accepts complete full evidence bound to the current commit and run", () => {
  assert.deepEqual(verify(), {
    exit: 0,
    verdict: "PASS",
    evidenceState: "COMPLETE",
    reason: "Validated report",
  });
});

test("keeps drift non-blocking", () => {
  assert.equal(verify().exit, 0);
});

test("rejects missing, stale, or mismatched release-target evidence", () => {
  for (const result of [
    verify(null),
    verify(report({ candidateSha: undefined })),
    verify(report({ candidateSha: "b".repeat(40) })),
    verify(report(), "0", "b".repeat(40)),
  ]) {
    assert.equal(result.exit, 1);
    assert.equal(result.evidenceState, "INCOMPLETE");
  }
});

test("rejects stale commit, stale run, quick evidence for a full run, and unknown events", () => {
  for (const result of [
    verify(report(), "0", "b".repeat(40)),
    verify(report({ runId: "987654321" })),
    verify(report({ profile: "quick" })),
    verify(report(), "0", sha, "repository_dispatch"),
  ]) {
    assert.equal(result.exit, 1);
    assert.equal(result.evidenceState, "INCOMPLETE");
  }
});

test("rejects missing or contradictory report evidence", () => {
  for (const result of [
    verify(null),
    verify(report({ schemaVersion: undefined })),
    verify(report({ checks: [] })),
    verify(report(), "1"),
    verify(report({ releaseGreen: false }), "0"),
    verify(report({ hardFailures: [{ id: "unit" }] }), "0"),
  ]) {
    assert.equal(result.exit, 1);
    assert.equal(result.evidenceState, "INCOMPLETE");
  }
});

test("reports consistent hard failures as a complete red verdict", () => {
  const red = report({
    releaseGreen: false,
    hardFailures: [{ id: "unit" }],
    checks: [
      { id: "unit", kind: "hard", ok: false },
      { id: "ratchet", kind: "drift", ok: false },
    ],
  });
  assert.deepEqual(verify(red, "1"), {
    exit: 1,
    verdict: "FAIL",
    evidenceState: "COMPLETE",
    reason: "Required validation failed",
  });
});

test("CLI rejects missing or malformed report files", () => {
  const validatorPath = fileURLToPath(
    new URL("../../scripts/quality/validate-release-green.mjs", import.meta.url)
  );
  const missingReport = `/tmp/release-green-missing-${process.pid}.json`;
  for (const reportPath of [missingReport, "/dev/null"]) {
    const result = spawnSync(
      process.execPath,
      [validatorPath, "--verify-evidence", reportPath, "0", sha, "schedule", runId],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 1);
  }
});

test("main incident closure validates exact evidence before upload or closure", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/nightly-release-green.yml", import.meta.url),
    "utf8"
  );
  const mainJob = workflow.slice(workflow.indexOf("  main-green:"), workflow.indexOf("  # ── Banking lane"));
  const closeStart = mainJob.indexOf("      - name: Close tracking issue");
  const uploadStart = mainJob.indexOf("      - name: Upload report artifact");
  const closeStep = mainJob.slice(closeStart, uploadStart);
  const uploadStep = mainJob.slice(uploadStart);
  const validationIndex = mainJob.indexOf("node scripts/quality/validate-release-green.mjs --verify-evidence");

  assert.match(mainJob, /ref: \$\{\{ github\.event_name == 'push' && github\.sha \|\| 'main' \}\}/);
  assert.doesNotMatch(mainJob, /ref: main\b/);
  assert.ok(validationIndex >= 0);
  assert.ok(validationIndex < mainJob.indexOf("      - name: Open / update tracking issue"));
  assert.ok(validationIndex < closeStart);
  assert.ok(validationIndex < uploadStart);
  assert.match(mainJob, /main-green\.json "\$validation_exit" "\$VALIDATED_SHA" "\$EVENT_NAME" "\$GITHUB_RUN_ID"/);
  assert.match(closeStep, /if: steps\.validate\.outputs\.exit == '0'/);
  assert.doesNotMatch(closeStep, /github\.event_name/);
  assert.match(closeStep, /CURRENT_SHA=\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)/);
  assert.match(closeStep, /\[ "\$CURRENT_SHA" != "\$VALIDATED_SHA" \]/);
  assert.match(uploadStep, /if-no-files-found: error/);
  assert.doesNotMatch(uploadStep, /if-no-files-found: (ignore|warn)/);
});

test("every issue closure requires verified evidence bound to its live target SHA", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/nightly-release-green.yml", import.meta.url),
    "utf8"
  );
  const releaseJob = workflow.slice(workflow.indexOf("  release-green:"), workflow.indexOf("  main-green:"));
  const mainJob = workflow.slice(workflow.indexOf("  main-green:"), workflow.indexOf("  # ── Banking lane"));
  const closure = (job) => {
    const closeStart = job.indexOf("      - name: Close tracking issue");
    const uploadStart = job.indexOf("      - name: Upload report artifact", closeStart);
    assert.ok(closeStart >= 0);
    assert.ok(uploadStart > closeStart);
    return { close: job.slice(closeStart, uploadStart), uploadStart };
  };
  const release = closure(releaseJob);
  const main = closure(mainJob);
  const releaseUpload = releaseJob.slice(release.uploadStart);
  const mainUpload = mainJob.slice(main.uploadStart);

  assert.equal([...workflow.matchAll(/gh issue close/g)].length, 2);
  const releaseVerifier = releaseJob.indexOf("node scripts/quality/validate-release-green.mjs --verify-evidence");
  assert.match(releaseJob, /git checkout "\$TARGET"/);
  assert.match(releaseJob, /run: echo "sha=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"/);
  assert.match(releaseJob, /VALIDATED_SHA: \$\{\{ steps\.revision\.outputs\.sha \}\}/);
  assert.ok(releaseVerifier >= 0);
  assert.ok(releaseVerifier < releaseJob.indexOf("      - name: Close tracking issue"));
  assert.match(releaseJob, /release-green\.json "\$validation_exit" "\$VALIDATED_SHA" "\$EVENT_NAME" "\$GITHUB_RUN_ID"/);
  assert.match(release.close, /if: steps\.validate\.outputs\.exit == '0'/);
  assert.match(release.close, /CURRENT_SHA=\$\(git ls-remote origin "refs\/heads\/\$\{TARGET\}" \| cut -f1\)/);
  assert.match(release.close, /\[ -z "\$CURRENT_SHA" \] \|\| \[ "\$CURRENT_SHA" != "\$VALIDATED_SHA" \]/);

  const mainVerifier = mainJob.indexOf("node scripts/quality/validate-release-green.mjs --verify-evidence");
  assert.ok(mainVerifier >= 0);
  assert.ok(mainVerifier < mainJob.indexOf("      - name: Close tracking issue"));
  assert.match(main.close, /CURRENT_SHA=\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)/);
  assert.match(main.close, /\[ "\$CURRENT_SHA" != "\$VALIDATED_SHA" \]/);
  assert.ok(release.uploadStart > releaseVerifier);
  assert.ok(main.uploadStart > mainVerifier);
  assert.match(releaseUpload, /if-no-files-found: error/);
  assert.match(mainUpload, /if-no-files-found: error/);
});
