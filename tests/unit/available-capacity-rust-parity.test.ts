import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  _clearAccountRequestOccupancyForTest,
  reserveAccountRequest,
  selectAvailableCapacityConnection,
} from "../../open-sse/services/accountRequestOccupancy.ts";

interface CandidateVector {
  id: string;
  priority?: number | null;
  maxConcurrent?: number | null;
  inFlight: number;
}

interface SelectionStep {
  strategy: string;
  provider: string;
  candidates: CandidateVector[];
  expected: string | null;
}

interface SelectionVector {
  name: string;
  steps: SelectionStep[];
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../benchmarks/runtime-proxy/fixtures/available-capacity-selection-v1.json",
      import.meta.url
    ),
    "utf8"
  )
) as {
  schemaVersion: number;
  supportedStrategy: string;
  vectors: SelectionVector[];
};

test("TypeScript available-capacity selection matches Rust shared vectors", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.supportedStrategy, "available-capacity");
  assert.ok(fixture.vectors.length >= 10);

  for (const vector of fixture.vectors) {
    _clearAccountRequestOccupancyForTest();
    let releases: Array<() => void> = [];
    try {
      for (const step of vector.steps) {
        for (const release of releases) release();
        releases = [];

        for (const candidate of step.candidates) {
          assert.ok(Number.isSafeInteger(candidate.inFlight) && candidate.inFlight >= 0);
          for (let i = 0; i < candidate.inFlight; i++) {
            releases.push(reserveAccountRequest(candidate.id));
          }
        }

        assert.equal(step.strategy, fixture.supportedStrategy, "fixture stays on supported route");
        const selected = selectAvailableCapacityConnection(step.provider, step.candidates);
        assert.equal(selected?.id ?? null, step.expected, vector.name);
      }
    } finally {
      for (const release of releases) release();
      _clearAccountRequestOccupancyForTest();
    }
  }
});
