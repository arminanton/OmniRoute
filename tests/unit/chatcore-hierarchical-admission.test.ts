import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(
  new URL("../../open-sse/handlers/chatCore.ts", import.meta.url),
  "utf8"
);

test("chatCore acquires cumulative gates immediately before withRateLimit", () => {
  const acquire = source.indexOf("await acquireConcurrencyGates(");
  const rateLimit = source.indexOf("await withRateLimit(", acquire);
  assert.ok(acquire >= 0, "hierarchical admission must be present");
  assert.ok(rateLimit > acquire, "hierarchical admission must precede withRateLimit");

  const admission = source.slice(acquire, rateLimit);
  assert.match(admission, /key: "global"/);
  assert.match(admission, /key: `provider:\$\{canonicalProviderKey\}`/);
  assert.match(admission, /key: accountSemaphoreKey/);
  assert.match(admission, /globalConcurrentRequests/);
  assert.match(admission, /providerConcurrency/);
  assert.match(admission, /maxWaitMs/);
  assert.match(admission, /maxQueueDepth/);
});

test("each rotated account attempt acquires and releases a fresh composite slot", () => {
  // The retired antigravity BYOP rotation flag no longer extends this loop.
  // Bound every search to the attempt body so a release in a later unrelated
  // function cannot satisfy the safety contract.
  const attemptLoop = source.indexOf("while (attempts < maxAttempts) {");
  const attemptEnd = source.indexOf("\n          }\n        })();", attemptLoop);
  assert.ok(attemptLoop >= 0 && attemptEnd > attemptLoop, "per-attempt loop must exist");
  const attempt = source.slice(attemptLoop, attemptEnd);
  const acquire = attempt.indexOf("await acquireConcurrencyGates(");
  const retryRelease = attempt.indexOf("releaseAccountSemaphore();");
  const retryContinue = attempt.indexOf("continue;", retryRelease);

  assert.ok(acquire >= 0, "each rotated account attempt must acquire a fresh composite slot");
  assert.ok(
    retryRelease > acquire && retryContinue > retryRelease,
    "retry must release the prior account before rotating"
  );
  assert.match(
    attempt,
    /finalize: releaseAccountSemaphore/,
    "successful streaming responses must release on stream completion"
  );
  assert.match(
    attempt,
    /wrapReadableStreamWithFinalize\(\s*originalBody,\s*releaseAccountSemaphore/,
    "ordinary successful streams must release on drain or cancel"
  );
  assert.match(
    attempt,
    /_accountSemaphoreRelease: releaseAccountSemaphore/,
    "non-streaming responses must transfer the release to the body reader"
  );
  assert.match(
    attempt,
    /catch \(error\) \{\s*releaseAccountSemaphore\(\);\s*throw error;/,
    "errors must release the acquired slot"
  );
  const afterAttempt = source.slice(attemptEnd, source.indexOf("\n    };", attemptEnd));
  assert.match(
    afterAttempt,
    /releaseRawResultAccountSemaphore\(\);/,
    "non-streaming response parsing must release the transferred slot"
  );
});
