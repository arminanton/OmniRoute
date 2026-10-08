import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { processPII } from "../../src/shared/utils/inputSanitizer.ts";

test("PII email detection stays bounded on a large email-free prompt", () => {
  // Match the agent-context shape: base64url text has frequent '-'/'_' word
  // boundaries but no '@', which made the former unbounded local-part regex
  // rescan the long input from many offsets.
  const context = randomBytes(196_608).toString("base64url").repeat(5);
  assert.equal(Buffer.byteLength(context), 1_310_720);
  assert.equal(context.includes("@"), false);

  const started = performance.now();
  const result = processPII(context);
  const elapsedMs = performance.now() - started;

  assert.deepEqual(result.detections, []);
  assert.equal(result.text, context);
  assert.ok(elapsedMs < 2_000, `1.31 MiB PII scan took ${elapsedMs.toFixed(1)} ms`);
});

test("bounded email detection still finds and redacts normal addresses", () => {
  const result = processPII("Contact john.doe+agent@example.co.uk for details", true);
  assert.deepEqual(result.detections, [{ type: "email", count: 1 }]);
  assert.equal(result.text, "Contact [EMAIL_REDACTED] for details");
});

test("overlong email local parts are rejected in bounded time", () => {
  const input = `${"a".repeat(65)}@example.com`;
  const started = performance.now();
  const result = processPII(input);
  const elapsedMs = performance.now() - started;

  assert.deepEqual(result.detections, []);
  assert.ok(elapsedMs < 100, `bounded email candidate took ${elapsedMs.toFixed(1)} ms`);
});
