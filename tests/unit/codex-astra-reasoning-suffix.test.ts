import assert from "node:assert/strict";
import test from "node:test";
import { splitCodexReasoningSuffix } from "../../open-sse/executors/codex/reasoningSuffix.ts";

test("Codex Astra effort aliases route to the upstream base model", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"] as const) {
    assert.deepEqual(splitCodexReasoningSuffix(`gpt-6-astra-${effort}`), {
      baseModel: "gpt-6-astra",
      effort,
    });
  }
});
