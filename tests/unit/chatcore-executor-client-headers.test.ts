// tests/unit/chatcore-executor-client-headers.test.ts
// Characterization of buildExecutorClientHeaders — the executor client-header normalizer extracted
// from handleChatCore (chatCore god-file decomposition, #3501). Locks: Headers and plain-object
// normalization, non-string value skipping, User-Agent backfill (both casings, only when absent),
// and the null-when-empty return.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildExecutorClientHeaders } from "../../open-sse/handlers/chatCore/executorClientHeaders.ts";
import { isForbiddenUpstreamHeaderName } from "../../src/shared/constants/upstreamHeaders.ts";
import {
  admitChatRequest,
  readRecordedBodyBytes,
  RECORDED_BODY_BYTES_HEADER,
} from "../../src/shared/middleware/chatBodyAdmission.ts";

test("returns null for empty / nullish inputs", () => {
  assert.equal(buildExecutorClientHeaders(null), null);
  assert.equal(buildExecutorClientHeaders(undefined), null);
  assert.equal(buildExecutorClientHeaders({}), null);
});

test("normalizes a Headers instance", () => {
  const h = new Headers({ "X-Test": "1", "content-type": "application/json" });
  const out = buildExecutorClientHeaders(h);
  assert.equal(out?.["content-type"], "application/json");
  assert.equal(out?.["x-test"], "1");
});

test("normalizes a plain object and skips non-string values", () => {
  const out = buildExecutorClientHeaders({ a: "1", b: 2, c: null } as Record<string, unknown>);
  assert.deepEqual(out, { a: "1" });
});

test("drops forged measured-byte headers case-insensitively", () => {
  const mixedCaseHeader = "X-OmniRoute-Recorded-Body-Bytes";
  const out = buildExecutorClientHeaders({ [mixedCaseHeader]: "999", "x-session-id": "keep" });
  assert.deepEqual(out, { "x-session-id": "keep" });
  assert.equal(buildExecutorClientHeaders(new Headers({ [mixedCaseHeader]: "999" })), null);
});

test("shared upstream denylist rejects the private recorded-byte header case-insensitively", () => {
  const mixedCaseHeader = RECORDED_BODY_BYTES_HEADER.replace("x-omniroute", "X-OmniRoute");
  assert.equal(isForbiddenUpstreamHeaderName(mixedCaseHeader), true);
});

test("backfills the User-Agent in both casings when absent", () => {
  const out = buildExecutorClientHeaders({ a: "1" }, "  MyAgent/1.0  ");
  assert.equal(out?.["user-agent"], "MyAgent/1.0");
  assert.equal(out?.["User-Agent"], "MyAgent/1.0");
});

test("does not overwrite an existing user-agent header", () => {
  const out = buildExecutorClientHeaders({ "user-agent": "Existing/9" }, "MyAgent/1.0");
  assert.equal(out?.["user-agent"], "Existing/9");
  assert.equal(out?.["User-Agent"], undefined);
});

test("a trimmed-empty user agent does not create headers on its own", () => {
  assert.equal(buildExecutorClientHeaders({}, "   "), null);
});

test("internal hard-lease control headers never reach an executor", () => {
  const out = buildExecutorClientHeaders({
    "X-OmniRoute-Lease-Owner": `vlo_${"A".repeat(43)}`,
    "x-omniroute-lease-generation": "7",
    "x-session-id": "routing-session-remains-independent",
  });

  assert.deepEqual(out, { "x-session-id": "routing-session-remains-independent" });
});

test("measured body-byte stamps stay private and are not sent to executors", async () => {
  const body = JSON.stringify({ message: "measured" });
  const request = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [RECORDED_BODY_BYTES_HEADER]: "1",
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  const admission = await admitChatRequest(request);
  assert.equal(admission.admit, true);
  if (!admission.admit) return;

  assert.equal(readRecordedBodyBytes(admission.request), Buffer.byteLength(body));
  const executorHeaders = buildExecutorClientHeaders(admission.request.headers);
  assert.equal(executorHeaders?.[RECORDED_BODY_BYTES_HEADER], undefined);
});
