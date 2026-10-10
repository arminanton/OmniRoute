import test from "node:test";
import assert from "node:assert/strict";
import {
  _cgroupIoCountersDeltaForTest,
  _cgroupProcessIoCountersDeltaForTest,
  _parseClientDiagnosticsForTest,
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
  assert.equal(_cgroupIoCountersDeltaForTest(null, null), null);
});

test("process I/O counters provide a fallback when cgroup io.stat is unavailable", () => {
  const delta = _cgroupProcessIoCountersDeltaForTest(
    { processCount: 2, counters: { read_bytes: 100, write_bytes: 200, syscw: 4 } },
    { processCount: 1, counters: { read_bytes: 300, write_bytes: 800, syscw: 12 } }
  );

  assert.deepEqual(delta, { read_bytes: 200, write_bytes: 600, syscw: 8 });
  assert.equal(_cgroupProcessIoCountersDeltaForTest(null, null), null);
});

test("benchmark parses the latest payload-free client timing diagnostics", () => {
  const diagnostics = _parseClientDiagnosticsForTest(
    [
      "request finished",
      'ANTIGRAVITY_CLIENT_DIAGNOSTICS {"completedRequests":10,"eventLoopDelayP95Ms":4}',
      'ANTIGRAVITY_CLIENT_DIAGNOSTICS {"completedRequests":20,"eventLoopDelayP95Ms":8}',
    ].join("\n")
  );

  assert.deepEqual(diagnostics, { completedRequests: 20, eventLoopDelayP95Ms: 8 });
  assert.equal(_parseClientDiagnosticsForTest("no diagnostics"), null);
});
