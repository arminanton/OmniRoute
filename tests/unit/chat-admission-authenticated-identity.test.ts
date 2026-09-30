import test from "node:test";
import assert from "node:assert/strict";
import {
  isInternalAdmissionBypass,
  resolveSelfLoopBearer,
  resolveSessionId,
} from "../../src/shared/middleware/chatAdmissionIdentity.ts";
import { resolveAdmissionTenantKey } from "../../src/sse/handlers/chatAdmission.ts";
import { createReasoningCacheKeyContext } from "../../open-sse/services/reasoningCacheContext.ts";

function request(headers: HeadersInit = {}, url = "http://localhost:20128/v1/chat/completions") {
  return new Request(url, { headers });
}

test("presented credentials and spoofed correlation headers do not create pre-auth lanes", () => {
  const headers = [
    "x-session-id",
    "x-conversation-id",
    "session-id",
    "conversation-id",
    "x-request-id",
    "authorization",
    "x-api-key",
    "x-goog-api-key",
  ];
  for (const name of headers) {
    assert.equal(resolveSessionId(request({ [name]: "attacker-one" })), "anonymous", name);
    assert.equal(resolveSessionId(request({ [name]: "attacker-two" })), "anonymous", name);
  }
});

test("post-auth fairness accepts only the original trusted principal, not raw IDs or lookalikes", () => {
  const prior = process.env.API_KEY_SECRET;
  process.env.API_KEY_SECRET = "admission-test-secret";
  try {
    const first = createReasoningCacheKeyContext("credential-one-same-last4");
    const repeat = createReasoningCacheKeyContext("credential-one-same-last4");
    const second = createReasoningCacheKeyContext("credential-two-same-last4");
    const lane = resolveAdmissionTenantKey(first);
    assert.notEqual(lane, "anonymous");
    assert.equal(lane, resolveAdmissionTenantKey(repeat));
    assert.notEqual(lane, resolveAdmissionTenantKey(second));
    assert.equal(resolveAdmissionTenantKey({ ...first } as never), "anonymous");
    assert.equal(resolveAdmissionTenantKey("metadata-id" as never), "anonymous");
    assert.equal(resolveAdmissionTenantKey(null), "anonymous");
    assert.equal(resolveSessionId(request({ "x-session-id": "spoof" }), first), lane);
    assert.doesNotMatch(lane, /credential|last4|admission-test-secret/);
  } finally {
    if (prior === undefined) delete process.env.API_KEY_SECRET;
    else process.env.API_KEY_SECRET = prior;
  }
});

test("admission bearer is process-random and never the sentinel or a configured API credential", () => {
  const prior = [process.env.OMNIROUTE_API_KEY, process.env.ROUTER_API_KEY];
  try {
    delete process.env.OMNIROUTE_API_KEY;
    delete process.env.ROUTER_API_KEY;
    const token = resolveSelfLoopBearer();
    assert.match(token, /^[a-f0-9]{64}$/);
    process.env.OMNIROUTE_API_KEY = "operator-key";
    process.env.ROUTER_API_KEY = "router-key";
    assert.equal(resolveSelfLoopBearer(), token);
    for (const bearer of ["sk_omniroute", "operator-key", "router-key", token.toUpperCase()]) {
      assert.equal(
        isInternalAdmissionBypass(
          request({
            "x-omniroute-admission-bypass": "internal",
            authorization: `Bearer ${bearer}`,
          })
        ),
        false
      );
    }
  } finally {
    for (const [i, name] of ["OMNIROUTE_API_KEY", "ROUTER_API_KEY"].entries()) {
      if (prior[i] === undefined) delete process.env[name];
      else process.env[name] = prior[i];
    }
  }
});

test("valid bearer bypass is bound to this listener, not a remote or neighboring service", () => {
  const headers = {
    "x-omniroute-admission-bypass": "internal",
    authorization: `Bearer ${resolveSelfLoopBearer()}`,
  };
  assert.equal(isInternalAdmissionBypass(request(headers)), true);
  for (const url of [
    "http://localhost:20129/v1/chat/completions",
    "https://example.com/v1/chat/completions",
    "ftp://localhost:20128/v1/chat/completions",
  ]) {
    assert.equal(isInternalAdmissionBypass(request(headers, url)), false, url);
  }
});

test("many spoofed sessions and credentials park in the same actual fairness queue", async () => {
  const { ChatAdmissionController } =
    await import("../../src/shared/middleware/chatBodyAdmission.ts");
  const controller = new ChatAdmissionController(1, 1024, 0, () => undefined);
  const holder = controller.tryAcquireHeavy()!;
  const abort = new AbortController();
  try {
    const waiters = [1, 2, 3].map((i) =>
      controller.acquireHeavyWithin(
        10_000,
        abort.signal,
        10,
        resolveSessionId(
          request({ authorization: `Bearer fake-${i}`, "x-session-id": `sess-${i}` })
        )
      )
    );
    assert.deepEqual(controller.waitersByKey, [{ key: "anonymous", waiting: 3 }]);
    assert.equal(controller.queuedBytes, 30);
    abort.abort();
    assert.deepEqual(await Promise.all(waiters), [null, null, null]);
    assert.equal(controller.queuedBytes, 0);
    assert.equal(controller.waitingCount, 0);
  } finally {
    abort.abort();
    holder.release();
  }
});
