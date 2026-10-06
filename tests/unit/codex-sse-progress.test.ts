import test from "node:test";
import assert from "node:assert/strict";
import { inspectCodexSsePrefix } from "../../open-sse/executors/codex/ssePrefix.ts";
const patterns = ["at capacity", "server_is_overloaded"];
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

test("creation, reasoning and tool events promptly release a healthy SSE prefix", () => {
  for (const type of [
    "response.created",
    "response.reasoning_summary_text.delta",
    "response.function_call_arguments.delta",
  ]) {
    assert.equal(inspectCodexSsePrefix(frame({ type }), patterns).ready, true);
  }
});
test("generated content mentioning capacity is not an upstream error", () => {
  const inspected = inspectCodexSsePrefix(
    frame({ type: "response.output_text.delta", delta: "The server is at capacity" }),
    patterns
  );
  assert.equal(inspected.matched, null);
  assert.equal(inspected.ready, true);
});
test("structured errors are classified only after a complete frame", () => {
  const text = frame({
    type: "response.failed",
    response: { error: { message: "Selected model is at capacity" } },
  });
  assert.equal(inspectCodexSsePrefix(text.slice(0, -2), patterns).matched, null);
  assert.equal(inspectCodexSsePrefix(text, patterns).matched, "at capacity");
});
