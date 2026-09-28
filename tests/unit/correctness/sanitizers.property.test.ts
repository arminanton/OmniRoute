import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { configureProperties } from "../../helpers/propertyConfig.ts";
import { sanitizeErrorMessage } from "../../../open-sse/utils/error.ts";
import { containsStrongCredentialToken } from "../../../open-sse/utils/errorSanitization.ts";

configureProperties();

test("sanitizeErrorMessage never leaks a file path / stack frame", () => {
  // sanitizeErrorMessage takes only the FIRST LINE of input (observed real behavior:
  // it splits on \n and processes only the part before the first newline).
  // Stack frames are on subsequent lines and thus already stripped.
  // The invariant we test: single-line content containing "at /path/file.ts" has the
  // absolute path replaced with "<path>", so the output never contains "at /".
  const firstLineWithPath = fc
    .string()
    .map((s) => s.replace(/\n/g, " ")) // ensure single line
    .chain((prefix) =>
      fc
        .string()
        .map((s) => s.replace(/\n/g, " "))
        .map((suffix) => `${prefix} at /home/app/open-sse/foo.ts:42:10 ${suffix}`)
    );

  fc.assert(
    fc.property(firstLineWithPath, (input) => {
      const out = sanitizeErrorMessage(input);
      assert.ok(!out.includes("at /"), `leaked path in: ${JSON.stringify(out)}`);
    })
  );
});

test("strong-token detection stays fast without weakening prefixed-key redaction", () => {
  for (const credential of [
    "abcsk-12345678",
    "12345sk_abcdefghij",
    "a".repeat(4000) + "sk-12345678",
  ]) {
    assert.ok(containsStrongCredentialToken(credential), "prefixed key must be detected");
    assert.equal(sanitizeErrorMessage(`Error ${credential}`), "Error [REDACTED]");
  }

  // A missing `sk-` must not make the unbounded detector retry a greedy
  // alphanumeric prefix at each input offset (unlike sanitized output, this
  // detector does not truncate its input).
  const adversarial = "a".repeat(20_000);
  const startCpu = process.cpuUsage();
  assert.equal(containsStrongCredentialToken(adversarial), false);
  const usedCpu = process.cpuUsage(startCpu);
  const cpuMs = (usedCpu.user + usedCpu.system) / 1000;
  assert.ok(cpuMs < 250, `too slow: ${cpuMs}ms CPU for len=${adversarial.length}`);
});

test("sanitizeErrorMessage terminates on long adversarial input (ReDoS guard)", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1000, max: 20000 }), (len) => {
      const start = process.hrtime.bigint();
      sanitizeErrorMessage("a".repeat(len) + "@" + "b".repeat(len) + ".com " + "1".repeat(len));
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 250, `too slow: ${ms}ms for len=${len}`);
    })
  );
});
