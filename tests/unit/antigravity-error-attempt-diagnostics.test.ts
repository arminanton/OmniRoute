import test from "node:test";
import assert from "node:assert/strict";

import {
  projectGoogleAttemptError,
  projectGoogleAttemptTransportError,
} from "../../open-sse/utils/googleErrorDiagnostics.ts";
import {
  createPreparedRequestLogger,
  runWithCapture,
} from "../../open-sse/utils/providerRequestLogging.ts";
import { readAntigravityErrorBody } from "../../open-sse/executors/antigravity/lifecycle.ts";
import {
  sendAntigravityRequest,
  toSafeAntigravityLog,
} from "../../open-sse/executors/antigravity/executeAttempt.ts";

const google429 = JSON.stringify({
  error: {
    code: 429,
    status: "RESOURCE_EXHAUSTED",
    message: "Quota exceeded for this model.",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "RATE_LIMIT_EXCEEDED",
        domain: "googleapis.com",
        metadata: {
          service: "cloudcode-pa.googleapis.com",
          quota_metric: "generate_requests",
          consumer: "private-project-id",
        },
      },
    ],
  },
});

test("bounded Google attempt diagnostics retain quota evidence but omit raw identity and body", () => {
  const diagnostic = projectGoogleAttemptError({
    url: "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    status: 429,
    statusText: "Too Many Requests",
    headers: {
      "retry-after": "30",
      "x-goog-request-id": "synthetic-request-id",
      authorization: "Bearer private-token",
      "set-cookie": "private-cookie",
    },
    body: google429,
    bodyBytes: Buffer.byteLength(google429),
    bodyTruncated: false,
  });
  const serialized = JSON.stringify(diagnostic);

  assert.equal(diagnostic.status, 429);
  assert.equal(
    diagnostic.url,
    "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent"
  );
  assert.equal(diagnostic.bodyFormat, undefined);
  assert.ok(serialized.includes("RESOURCE_EXHAUSTED"));
  assert.ok(serialized.includes("RATE_LIMIT_EXCEEDED"));
  assert.ok(serialized.includes("generate_requests"));
  assert.ok(!serialized.includes("private-project-id"));
  assert.ok(!serialized.includes("private-token"));
  assert.ok(!serialized.includes("private-cookie"));
  assert.ok(!serialized.includes(google429));
  assert.ok(Buffer.byteLength(serialized) < 6144);
});

test("reading an Antigravity error body records a bounded attempt without changing the body", async () => {
  const attempts: Record<string, unknown>[] = [];
  const capture = createPreparedRequestLogger(
    {
      logTargetRequest() {},
      logProviderAttempt(value) {
        attempts.push(value);
      },
    },
    { id: null, model: "gemini-3.8-flash-high", provider: "antigravity", connectionId: null }
  );
  const response = new Response(google429, {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "content-type": "application/json", "x-goog-request-id": "synthetic-request-id" },
  });

  const body = await runWithCapture(capture, () => readAntigravityErrorBody(response));

  assert.equal(body, google429);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].kind, "http_error");
  assert.equal(attempts[0].status, 429);
  assert.ok(JSON.stringify(attempts[0]).includes("RATE_LIMIT_EXCEEDED"));
  assert.ok(!JSON.stringify(attempts[0]).includes("private-project-id"));
  assert.ok(!JSON.stringify(attempts[0]).includes(google429));
});

test("403 project-header fallback records the rejected attempt before retry succeeds", async () => {
  const originalFetch = globalThis.fetch;
  const attempts: Record<string, unknown>[] = [];
  let calls = 0;
  const capture = createPreparedRequestLogger(
    {
      logTargetRequest() {},
      logProviderAttempt(value) {
        attempts.push(value);
      },
    },
    { id: null, model: "gemini-3.8-flash-high", provider: "antigravity", connectionId: null }
  );
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? new Response(
          JSON.stringify({
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "Project is not enabled.",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "SERVICE_DISABLED",
                  domain: "googleapis.com",
                },
              ],
            },
          }),
          { status: 403, headers: { "content-type": "application/json" } }
        )
      : new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
  };

  try {
    const result = await runWithCapture(capture, () =>
      sendAntigravityRequest(
        "antigravity",
        "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
        "gemini-3.8-flash-high",
        { "x-goog-user-project": "synthetic-project" },
        { project: "synthetic-project", request: {}, model: "gemini-3.8-flash-high" },
        { accessToken: "synthetic-token", projectId: "synthetic-project" },
        true,
        null,
        toSafeAntigravityLog(null),
        0
      )
    );

    assert.equal(result.response.status, 200);
    assert.equal(calls, 2);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].status, 403);
    const serialized = JSON.stringify(attempts[0]);
    assert.ok(serialized.includes("PERMISSION_DENIED"));
    assert.ok(serialized.includes("SERVICE_DISABLED"));
    assert.ok(!serialized.includes("synthetic-token"));
    assert.ok(!serialized.includes("synthetic-project"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("transport attempt projection retains the failure class without URL query data", () => {
  const diagnostic = projectGoogleAttemptTransportError(
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse&token=secret",
    Object.assign(new TypeError("fetch failed"), {
      code: "UND_ERR_HEADERS_OVERFLOW",
      cause: Object.assign(new Error("header overflow"), { code: "UND_ERR_HEADERS_OVERFLOW" }),
    })
  );

  assert.equal(diagnostic.kind, "transport_error");
  assert.equal(
    diagnostic.url,
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent"
  );
  assert.equal(diagnostic.code, "UND_ERR_HEADERS_OVERFLOW");
  assert.ok(!JSON.stringify(diagnostic).includes("token=secret"));

  const customCode = projectGoogleAttemptTransportError(
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    Object.assign(new TypeError("fetch failed"), { code: "PRIVATE_SECRET_VALUE" })
  );
  assert.equal(customCode.code, undefined);
  assert.ok(!JSON.stringify(customCode).includes("PRIVATE_SECRET_VALUE"));
});
