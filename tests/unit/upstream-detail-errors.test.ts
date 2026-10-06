import { test } from "node:test";
import assert from "node:assert/strict";
import { createErrorResult, parseUpstreamError } from "../../open-sse/utils/error.ts";

test("ChatGPT detail errors retain the reason and Retry-After instead of generic status text", async () => {
  const parsed = await parseUpstreamError(
    new Response(
      JSON.stringify({ detail: "Too many concurrent requests. Please retry after 3s." }),
      { status: 429, headers: { "retry-after": "3" } }
    ),
    "codex"
  );
  assert.match(parsed.message, /concurrent requests/);
  assert.equal(parsed.retryAfterMs, 3000);
});

test("upstream access-verification detail remains distinct from account quota exhaustion", async () => {
  const parsed = await parseUpstreamError(
    new Response('{"detail":"Unable to verify Daybreak Blue access. Please try again."}', {
      status: 503,
    }),
    "codex"
  );
  assert.match(parsed.message, /verify.*access/);
  assert.equal(parsed.statusCode, 503);
});

test("Antigravity preserves an upstream Retry-After header without a textual retry hint", async () => {
  const parsed = await parseUpstreamError(
    new Response('{"error":{"message":"Rate limited"}}', {
      status: 429,
      headers: { "retry-after": "7" },
    }),
    "antigravity"
  );
  assert.equal(parsed.retryAfterMs, 7000);
  const result = createErrorResult(parsed.statusCode, parsed.message, parsed.retryAfterMs);
  assert.equal(result.response.headers.get("retry-after"), "7");
});
