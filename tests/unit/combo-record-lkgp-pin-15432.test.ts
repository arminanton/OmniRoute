import { test } from "node:test";
import assert from "node:assert/strict";
import { recordLkgpPin } from "../../open-sse/services/combo/recordLkgpPin.ts";

test("missing combo id writes only one combo-level pin", async () => {
  const calls: unknown[][] = [];
  await recordLkgpPin({
    comboName: "combo-a",
    executionKey: "model-a",
    provider: "openai",
    setLKGP: async (...args) => {
      calls.push(args);
    },
  });
  assert.deepEqual(calls, [["combo-a", "combo-a", "openai", undefined]]);
});

test("combo id equal to name writes only one combo-level pin", async () => {
  const calls: unknown[][] = [];
  await recordLkgpPin({
    comboName: "combo-a",
    comboId: "combo-a",
    executionKey: "model-a",
    provider: "openai",
    setLKGP: async (...args) => {
      calls.push(args);
    },
  });
  assert.deepEqual(calls, [["combo-a", "combo-a", "openai", undefined]]);
});

test("distinct combo id retains execution and combo-level pins", async () => {
  const calls: unknown[][] = [];
  await recordLkgpPin({
    comboName: "combo-a",
    comboId: "combo-id-a",
    executionKey: "model-a",
    provider: "openai",
    connectionId: "conn-1",
    setLKGP: async (...args) => {
      calls.push(args);
    },
  });
  assert.deepEqual(calls, [
    ["combo-a", "model-a", "openai", "conn-1"],
    ["combo-a", "combo-id-a", "openai", "conn-1"],
  ]);
});
