import assert from "node:assert/strict";
import test from "node:test";
import { boundedCanaryProbe } from "../../src/lib/canaryProbe";

test("stalled and rejected component probes cannot hang or approve readiness", async () => {
  assert.equal(await boundedCanaryProbe(() => new Promise<boolean>(() => {}), false, 10), false);
  assert.equal(
    await boundedCanaryProbe(async () => {
      throw new Error("unavailable");
    }, false),
    false
  );
  assert.equal(await boundedCanaryProbe(async () => true, false), true);
});

test("a late positive result cannot overwrite a failed readiness deadline", async () => {
  let finish!: (value: boolean) => void;
  const value = await boundedCanaryProbe(
    () =>
      new Promise<boolean>((r) => {
        finish = r;
      }),
    false,
    10
  );
  finish(true);
  assert.equal(value, false);
});
