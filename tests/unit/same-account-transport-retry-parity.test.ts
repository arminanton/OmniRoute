import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldRetrySameAccountTransport } from "../../src/sse/services/sameAccountTransportRetry.ts";
import {
  markUncertainGenerationAcceptance,
  noteGenerationDispatchPhase,
} from "../../open-sse/services/generationDispatchEvidence.ts";

interface RetryVector {
  name: string;
  input: {
    status: number;
    attempt: number;
    hasForcedConnection?: boolean;
    hasEmittedOutput?: boolean;
    dispatchPhase?: string;
    requestStarted?: boolean | null;
    uncertainAcceptance?: boolean;
    errorCode?: string;
    errorType?: string;
    errorText?: string;
  };
  expected: boolean;
}

test("production same-account retry gate matches the Rust parity vectors", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../benchmarks/runtime-proxy/fixtures/same-account-transport-retry-v1.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as {
    schemaVersion: number;
    vectors: RetryVector[];
    uncoveredCases: Array<{ name: string; reason: string }>;
  };
  assert.equal(fixture.schemaVersion, 1);
  assert.ok(fixture.vectors.length >= 20);

  for (const { name, input, expected } of fixture.vectors) {
    let originalError: Error | undefined;
    if (input.dispatchPhase !== undefined || input.uncertainAcceptance) {
      originalError = new Error(input.errorText ?? "synthetic transport fixture");
      if (input.dispatchPhase !== undefined) {
        noteGenerationDispatchPhase(
          originalError,
          input.dispatchPhase,
          input.requestStarted ?? null
        );
      }
      if (input.uncertainAcceptance) markUncertainGenerationAcceptance(originalError);
    }

    assert.equal(
      shouldRetrySameAccountTransport({
        status: input.status,
        errorText: input.errorText,
        errorCode: input.errorCode,
        errorType: input.errorType,
        originalError,
        attempt: input.attempt,
        hasForcedConnection: input.hasForcedConnection,
        hasEmittedOutput: input.hasEmittedOutput,
      }),
      expected,
      name
    );
  }

  assert.ok(
    fixture.uncoveredCases.some(
      (entry) =>
        entry.name === "verified-proxy-fetch-exhaustion-object-identity" &&
        entry.reason.includes("private WeakSet object-identity brand")
    ),
    "the fixture must not claim synthetic JSON can represent the verified proxyFetch brand"
  );
});
