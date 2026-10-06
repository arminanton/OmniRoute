import test from "node:test";
import assert from "node:assert/strict";
import {
  projectGoogleError,
  projectErrorHeaders,
} from "../../open-sse/utils/googleErrorDiagnostics.ts";

test("Google projection bounds and allowlists RPC details without secrets or identity", () => {
  const result = projectGoogleError({
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Authorization: Bearer synthetic-secret",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "RATE_LIMIT_EXCEEDED",
        domain: "googleapis.com",
        metadata: {
          consumer: "private-project",
          quota_metric: "generate_requests",
          model: "Bearer synthetic-secret",
        },
      },
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: Array.from({ length: 100 }, () => ({
          subject: "private-project",
          description: "验".repeat(10000),
          quotaMetric: "q".repeat(128),
          quotaDimensions: { model: "gemini-test", consumer: "private-project" },
        })),
      },
      { "@type": "type.googleapis.com/google.rpc.DebugInfo", stackEntries: ["private-history"] },
    ],
  });
  assert.ok(result);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
  assert.ok(!JSON.stringify(result).includes("private-project"));
  assert.ok(!JSON.stringify(result).includes("private-history"));
  assert.equal((result.details as Record<string, unknown>[])[1].omittedViolations, 97);
});

test("unrecognized Google shapes and arbitrary headers are omitted", () => {
  for (const value of [
    null,
    [],
    { code: "429", status: "RESOURCE_EXHAUSTED" },
    { code: 429, status: "private-secret" },
    { code: -1, status: "INTERNAL" },
  ])
    assert.equal(projectGoogleError(value), undefined);
  assert.deepEqual(
    projectErrorHeaders({
      "Retry-After": "30",
      "X-Goog-Request-ID": "synthetic-id",
      authorization: "secret",
      "set-cookie": "secret",
      "x-request-id": "Bearer synthetic-secret",
      traceparent: "bad\nheader",
    }),
    { "retry-after": "30", "x-goog-request-id": "synthetic-id" }
  );
});

test("compacting previously projected evidence retains explicit omitted counts", () => {
  const first = projectGoogleError({
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: Array.from({ length: 20 }, () => ({ quotaMetric: "generate_requests" })),
      },
    ],
  });
  const second = projectGoogleError(first);
  assert.deepEqual(second, first);
});
