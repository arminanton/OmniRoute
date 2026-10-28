import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  runIdleGcIfEligible,
  startIdleGcScheduler,
  stopIdleGcScheduler,
} from "../../../src/lib/memory/idleGc.ts";
import { trackRequest } from "../../../src/lib/gracefulShutdown.ts";

describe("idleGc scheduler", () => {
  afterEach(() => {
    stopIdleGcScheduler();
  });

  it("skips GC when in-flight requests > 0", () => {
    const done = trackRequest();
    try {
      const result = runIdleGcIfEligible();
      assert.equal(result.ran, false);
      assert.equal(result.reclaimedBytes, 0);
    } finally {
      done();
    }
  });

  it("skips GC when memory is below the 2 GB threshold", () => {
    const result = runIdleGcIfEligible();
    // In typical unit test environment, heap is well under 2 GB
    assert.equal(result.ran, false);
  });

  it("starts and stops scheduler cleanly", () => {
    startIdleGcScheduler(100_000);
    // Double start is idempotent
    startIdleGcScheduler(100_000);
    stopIdleGcScheduler();
  });
});
