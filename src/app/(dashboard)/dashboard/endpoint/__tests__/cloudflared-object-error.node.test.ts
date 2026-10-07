import assert from "node:assert/strict";
import test from "node:test";
import { extractApiErrorMessage } from "../../../../../shared/http/apiErrorMessage";

test("extracts the actionable message from a structured Cloudflare error", () => {
  assert.equal(
    extractApiErrorMessage(
      { error: { code: "TUNNEL_START_FAILED", message: "Check the Cloudflare tunnel token." } },
      "Tunnel update failed"
    ),
    "Check the Cloudflare tunnel token."
  );
});

test("preserves string API errors", () => {
  assert.equal(
    extractApiErrorMessage({ error: "Tunnel unavailable" }, "Tunnel update failed"),
    "Tunnel unavailable"
  );
});

test("uses the prior fallback when the API error has no message", () => {
  assert.equal(
    extractApiErrorMessage({ error: { code: "TUNNEL_START_FAILED" } }, "Tunnel update failed"),
    "Tunnel update failed"
  );
});

test("uses the status fallback for malformed Cloudflare error values", () => {
  const fallback = "Failed to load Cloudflare tunnel status";
  for (const error of [null, 42, true, [], { message: 42 }]) {
    assert.equal(extractApiErrorMessage({ error }, fallback), fallback);
  }
});
