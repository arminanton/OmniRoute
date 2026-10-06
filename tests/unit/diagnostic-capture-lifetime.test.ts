import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getCanaryLifecycle } from "../../src/lib/canaryLifecycle.ts";
const original = fs.fsync;
let hold = false;
let enteredResolve: () => void = () => {};
let release: () => void = () => {};
fs.fsync = ((fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
  if (hold) {
    hold = false;
    enteredResolve();
    release = () => original(fd, callback);
  } else original(fd, callback);
}) as typeof fs.fsync;
const { createDiagnosticOverflowTrace, getDiagnosticOverflowActiveWork } =
  await import("../../src/lib/usage/diagnosticOverflow.ts");
const { bootstrapDiagnosticCaptureLifecycle } =
  await import("../../src/lib/usage/diagnosticCaptureLifecycle.ts");

test("enabledcold ownership is unknown; actual heldfsync blocksdrain until incomplete trace seals", async () => {
  const previous = process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
  try {
    delete process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
    assert.equal(await bootstrapDiagnosticCaptureLifecycle(), true);
    assert.equal(getCanaryLifecycle().diagnosticCaptureWork, 0);
    assert.equal(fs.existsSync(path.join(process.env.DATA_DIR!, "diagnostic_overflow")), false);
    process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "true";
    assert.equal(getDiagnosticOverflowActiveWork(), null);
    assert.equal(getCanaryLifecycle().diagnosticCaptureWork, null);
    assert.equal(await bootstrapDiagnosticCaptureLifecycle(), true);
    assert.equal(getCanaryLifecycle().diagnosticCaptureWork, 0);
    const trace = await createDiagnosticOverflowTrace({ eligible: true, provider: "agy" });
    assert.ok(trace);
    const attempt = await trace.beginAttempt({ requestBody: "{}" });
    await attempt.writeResponse(new TextEncoder().encode("partial"));
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    hold = true;
    const finish = trace.abort("abort");
    await entered;
    assert.equal(getCanaryLifecycle().diagnosticCaptureWork, 1);
    let settled = false;
    finish.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    release();
    await finish;
    assert.equal(trace.snapshot().state, "incomplete");
    assert.equal(getCanaryLifecycle().diagnosticCaptureWork, 0);
    await trace.finish();
    await trace.abort();
    assert.equal(getCanaryLifecycle().diagnosticCaptureWork, 0);
  } finally {
    fs.fsync = original;
    if (previous === undefined) delete process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
    else process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = previous;
  }
});
