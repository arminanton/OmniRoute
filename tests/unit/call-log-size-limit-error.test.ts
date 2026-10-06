import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { useDecollidedMigrationsDir } from "./helpers/decollidedMigrationsDir.ts";

useDecollidedMigrationsDir();
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-call-log-size-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { writeCallArtifact, readCallArtifact } =
  await import("../../src/lib/usage/callLogArtifacts.ts");

const OMITTED = "[omitted: call log artifact size limit exceeded]";
const TRUNCATED = "[truncated: call log artifact size limit exceeded]";

// The reported shape: a request body large enough to trip the 512KB cap on its
// own, next to an error small enough that keeping it costs nothing.
const HUGE_BODY = "x".repeat(900 * 1024);
const REAL_ERROR = "[504]: Fetch timeout after 110000ms on https://provider.example/v1/messages";

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 5 as const,
    summary: {
      id: `size-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(),
      method: "POST",
      path: "/v1/messages",
      status: 504,
      model: "opencode-go",
      requestedModel: null,
    },
    requestBody: HUGE_BODY,
    responseBody: null,
    error: REAL_ERROR,
    ...overrides,
  } as never;
}

function roundTrip(input: ReturnType<typeof artifact>) {
  const relativePath = `size-limit/${(input as { summary: { id: string } }).summary.id}.json`;
  assert.ok(writeCallArtifact(input, relativePath), "artifact should be written");
  const { artifact: stored, state } = readCallArtifact(relativePath);
  assert.equal(state, "ready");
  assert.ok(stored, "artifact should be readable");
  return stored as unknown as Record<string, unknown>;
}

test("a size-limited row keeps the error that says why the request failed", () => {
  const stored = roundTrip(artifact());

  // The bodies are what tripped the cap; they are still dropped.
  assert.equal(stored.requestBody, OMITTED);
  // The error is the only field that distinguishes a provider outage from a
  // local timeout from an upstream 400. It survives.
  assert.equal(stored.error, REAL_ERROR);
});

test("an oversized error is truncated, not discarded", () => {
  const stored = roundTrip(artifact({ error: "e".repeat(64 * 1024) }));

  const error = stored.error as string;
  assert.equal(typeof error, "string");
  assert.ok(error.startsWith("eeee"), "the beginning of the error is kept");
  assert.ok(error.endsWith(TRUNCATED), "and it says it was cut");
  assert.ok(
    Buffer.byteLength(error, "utf8") <= 4 * 1024 + TRUNCATED.length + 1,
    `truncated error should stay near the 4KB budget, got ${Buffer.byteLength(error, "utf8")}`
  );
});

test("truncation does not split a multi-byte character", () => {
  // Every character is 3 bytes, so a byte-aligned cut lands mid-sequence.
  const stored = roundTrip(artifact({ error: "验".repeat(8 * 1024) }));

  const error = stored.error as string;
  assert.ok(!error.includes("�"), "no replacement character should appear");
  assert.ok(error.endsWith(TRUNCATED));
});

test("a request with no error still stores null rather than a marker", () => {
  const stored = roundTrip(artifact({ error: null }));

  assert.equal(stored.requestBody, OMITTED);
  assert.equal(stored.error, null);
});

test("a non-string error is preserved as its own value when it fits", () => {
  const structured = { status: 504, provider: "opencode-go", detail: "upstream timeout" };
  const stored = roundTrip(artifact({ error: structured }));

  assert.deepEqual(stored.error, structured);
});

test("size-limited pipeline retains compact upstream error diagnostics without the request snapshot", () => {
  const stored = roundTrip(
    artifact({
      pipeline: {
        error: {
          error: "Too many concurrent requests",
          statusCode: 429,
          retryAfterMs: 3000,
          requestBody: { input: HUGE_BODY },
        },
        providerResponse: {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": "3",
            "X-Request-ID": "synthetic-upstream-id",
            authorization: "synthetic-secret",
          },
          body: { detail: "Too many concurrent requests" },
        },
        providerRequest: { body: { input: HUGE_BODY } },
      },
    })
  );
  const pipeline = stored.pipeline as {
    error: Record<string, unknown>;
    providerResponse: { body: { detail: string }; headers: Record<string, string> };
  };
  assert.equal(pipeline.error.error, "Too many concurrent requests");
  assert.equal(pipeline.error.retryAfterMs, 3000);
  assert.equal(pipeline.error.requestBody, undefined);
  assert.equal(pipeline.providerResponse.body.detail, "Too many concurrent requests");
  assert.equal(pipeline.providerResponse.headers["retry-after"], "3");
  assert.equal(pipeline.providerResponse.headers["x-request-id"], "synthetic-upstream-id");
  assert.equal(pipeline.providerResponse.headers.authorization, undefined);
});

test("oversized pipeline preserves safe transport correlation and last attempts while dropping arbitrary fields", () => {
  const id = "9f720aae-cfc4-4c34-bcd6-9f7a9a78001c";
  for (const giantSummary of [false, true]) {
    const base = artifact();
    if (giantSummary) (base as unknown as { summary: { model: string } }).summary.model = HUGE_BODY;
    const stored = roundTrip(
      artifact({
        ...base,
        pipeline: {
          providerRequest: { body: HUGE_BODY },
          transportTelemetry: {
            schema: "omni-transport-telemetry/v1",
            id,
            closure: "error",
            authorization: "private-secret",
            attempts: Array.from({ length: 24 }, () => ({
              transport: "http",
              headersMs: 45,
              firstByteMs: 50,
              status: 504,
              closure: "error",
              closedMs: 15000,
              terminalObservedIdleMs: 14950,
              requestBody: "private-secret",
            })),
          },
        },
      })
    );
    const pipeline = stored.pipeline as {
      transportTelemetry: { id: string; attempts: { status: number }[]; omittedAttempts: number };
    };
    assert.equal(pipeline.transportTelemetry.id, id);
    assert.equal(pipeline.transportTelemetry.attempts.length, 4);
    assert.equal(pipeline.transportTelemetry.attempts[0].status, 504);
    assert.equal(pipeline.transportTelemetry.omittedAttempts, 20);
    assert.ok(!JSON.stringify(pipeline).includes("private-secret"));
  }
});
