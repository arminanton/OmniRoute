import assert from "node:assert/strict";
import test from "node:test";
import {
  clearCompletedDetails,
  getCompletedDetails,
  storeCompletedDetail,
} from "../../src/lib/usage/completedRequestDetails.ts";

test.afterEach(() => clearCompletedDetails());

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
