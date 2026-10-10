import test from "node:test";
import assert from "node:assert/strict";
import {
  _callLogWriterHealthSummaryForTest,
  _cgroupIoCountersDeltaForTest,
} from "../../scripts/perf/bench-standalone-antigravity-tool-roundtrip.mjs";

test("cgroup I/O counters report nonnegative per-device deltas", () => {
  const delta = _cgroupIoCountersDeltaForTest(
    {
      "8:0": { rbytes: 100, wbytes: 200, rios: 5, wios: 8 },
      "8:16": { rbytes: 10 },
    },
    {
      "8:0": { rbytes: 350, wbytes: 500, rios: 9, wios: 7 },
      "8:32": { rbytes: 40 },
    }
  );

  assert.deepEqual(delta, {
    "8:0": { rbytes: 250, wbytes: 300, rios: 4, wios: 0 },
    "8:32": { rbytes: 40 },
  });
});

test("call-log writer health summary retains peaks and the last bounded snapshot", () => {
  const summary = _callLogWriterHealthSummaryForTest([
    { unavailable: true, status: 503 },
    {
      workerState: "running",
      activeJobs: 2,
      queuedArtifacts: 4,
      reservedArtifactBytes: 1_024,
      preparationRefusalsTotal: 1,
    },
    {
      workerState: "idle",
      activeJobs: 0,
      queuedArtifacts: 1,
      reservedArtifactBytes: 256,
      preparationRefusalsTotal: 3,
    },
  ]);

  assert.equal(summary.sampleCount, 2);
  assert.equal(summary.unavailableSamples, 1);
  assert.equal(summary.peak.activeJobs, 2);
  assert.equal(summary.peak.queuedArtifacts, 4);
  assert.equal(summary.peak.reservedArtifactBytes, 1_024);
  assert.equal(summary.peak.preparationRefusalsTotal, 3);
  assert.equal(summary.lastSnapshot.workerState, "idle");
  assert.equal(summary.lastSnapshot.reservedArtifactBytes, 256);
  assert.equal(Object.hasOwn(summary, "samples"), false);
});
