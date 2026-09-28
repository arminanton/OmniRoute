import assert from "node:assert/strict";
import test from "node:test";

const { sanitizeErrorMessage } = await import("../../open-sse/utils/error.ts");

test("sanitizeErrorMessage must not expose an unknown-root filesystem path followed by prose", () => {
  const message = sanitizeErrorMessage("Provider failed at /custom/internal secret directory");

  assert.doesNotMatch(
    message,
    /\/custom\/internal|secret directory/,
    `expected the unknown-root path to be redacted, got: ${message}`
  );
});

test("unknown-root path suffix cannot survive a following credential marker", () => {
  const message = sanitizeErrorMessage(
    "Provider failed at /custom/internal secret directory access_token=provider-secret"
  );

  assert.match(message, /<path> access_token=\[REDACTED\]$/);
  assert.doesNotMatch(message, /\/custom\/internal|secret directory|provider-secret/);
});

test("literal marker text cannot shield an ambiguous filesystem suffix", () => {
  for (const raw of [
    "Provider failed at /custom/internal secret directory [REDACTED]/private",
    "Provider failed at /custom/internal secret [REDACTED] directory",
  ]) {
    const message = sanitizeErrorMessage(raw);
    assert.equal(message, "Provider failed at <path>");
    assert.doesNotMatch(message, /\/custom|\/private|secret|directory/);
  }
});

test("sanitizeErrorMessage does not regress #13144 (trailing prose after a route survives)", () => {
  const message = sanitizeErrorMessage(
    "on /v1/chat/completions. Use POST /v1/images/generations instead."
  );

  assert.match(message, /Use POST \/v1\/images\/generations instead\.$/);
});
