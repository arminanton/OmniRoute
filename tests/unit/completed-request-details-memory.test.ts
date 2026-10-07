import assert from "node:assert/strict";
import test from "node:test";
import {
  clearCompletedDetails,
  getCompletedDetails,
  projectCompletedArtifactPreview,
  storeCompletedDetail,
} from "../../src/lib/usage/completedRequestDetails.ts";

test.afterEach(() => clearCompletedDetails());

test("artifact enrichment retains a sanitized bounded preview instead of full payloads", () => {
  const preview = projectCompletedArtifactPreview({
    authorization: "Bearer completed-artifact-secret",
    content: "x".repeat(2_000_000),
  }) as { authorization: string; content: string };

  assert.equal(preview.content.length, 1203);
  assert.doesNotMatch(JSON.stringify(preview), /completed-artifact-secret/);
  assert.ok(JSON.stringify(preview).length < 2_000);
});

test("completed-detail stream excerpts have a 64 MiB aggregate memory ceiling", () => {
  // Reuse one backing value so the test exercises weighted accounting without
  // allocating 64 MiB of fixture strings. Production requests own independent chunks.
  const chunk = "x".repeat(256 * 1024);
  const details = getCompletedDetails();

  for (let index = 0; index < 128; index++) {
    storeCompletedDetail({
      id: `stream-${index}`,
      model: "gpt-test",
      provider: "openai",
      connectionId: "connection-test",
      startedAt: 0,
      streamChunks: { provider: [chunk] },
    });
  }

  assert.ok(details.size < 128, "old stream-heavy details should be evicted at the byte ceiling");
  assert.equal(details.has("stream-0"), false);
  assert.equal(
    details.has("stream-127"),
    true,
    "the newest completed detail should remain available"
  );
});
