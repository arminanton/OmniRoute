/** Proposed primitive tests only; actual UC/use-site tests are a separate gate. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteMediaFetchError,
  createRemoteMediaFailureResult,
  isRemoteMediaFailureResult,
  createRemoteMediaFailureResponse,
  isRemoteMediaFailureResponse,
  getRemoteMediaFailureResponseDetails,
  cloneRemoteMediaFailureResponse,
} from "../../src/shared/network/mediaFailure.ts";
import {
  RuntimePolicyError,
  isRuntimePolicyError,
  markRuntimePolicyResponse,
  isRuntimePolicyResponse,
} from "../../src/shared/runtimePolicy.ts";
import {
  markExhaustedNetworkResponse,
  isExhaustedNetworkResponse,
} from "../../open-sse/services/exhaustedNetworkResponse.ts";

function fixture(status = 502) {
  const details = {
    message: "UC input media upload did not complete.",
    code: "uc_media_upload_failed",
  };
  const text = JSON.stringify({
    error: {
      code: details.code,
      message: details.message,
      type: status >= 500 ? "provider_error" : "invalid_request_error",
    },
  });
  const response = new Response(text, { status, headers: { "content-type": "application/json" } });
  const error = new RemoteMediaFetchError(
    new Error("private URL/query/cause must not be copied"),
    status
  );
  return { details, text, response, error };
}

for (const status of [400, 499, 502, 504]) {
  test(`media response preserves exact local status/body and copied diagnostics: ${status}`, async () => {
    const f = fixture(status);
    const result = createRemoteMediaFailureResponse(f.response, f.error, null, f.details);
    assert.strictEqual(result, f.response);
    assert.equal(result.status, status);
    assert.equal(result.bodyUsed, false);
    assert.equal(isRemoteMediaFailureResponse(result), true);
    assert.equal(isRuntimePolicyResponse(result), false);
    assert.equal(isExhaustedNetworkResponse(result), false);
    const details = getRemoteMediaFailureResponseDetails(result);
    assert.deepEqual(details, { status, ...f.details });
    assert.equal(Object.isFrozen(details), true);
    f.details.message = "changed after construction";
    assert.equal(details.message, "UC input media upload did not complete.");
    for (const name of [
      "omniroute.remote-media-response-failure",
      "omniroute.remote-media-response-details",
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(result, Symbol.for(name));
      assert.ok(descriptor);
      assert.equal(descriptor.enumerable, false);
      assert.equal(descriptor.writable, false);
      assert.equal(descriptor.configurable, false);
    }
    assert.equal(JSON.stringify(result).includes("private URL"), false);
    assert.equal(isRemoteMediaFailureResponse({ ...result }), false);
    assert.equal(await result.text(), f.text);
  });
}

for (const aborted of [false, true]) {
  test(`actual policy identity wins before media/caller-abort conversion: aborted=${aborted}`, () => {
    const controller = new AbortController();
    if (aborted) controller.abort(new Error("caller abort"));
    const policy = new RuntimePolicyError("proxy-forbidden");
    for (const error of [policy, new RemoteMediaFetchError(policy, 502)]) {
      const f = fixture();
      assert.throws(
        () => createRemoteMediaFailureResponse(f.response, error, controller.signal, f.details),
        (actual: unknown) => actual === policy && isRuntimePolicyError(actual)
      );
      assert.equal(isRemoteMediaFailureResponse(f.response), false);
      assert.equal(f.response.bodyUsed, false);
    }
  });
}

test("ordinary JSON/name/status/details cannot establish media provenance", () => {
  const lookalike = {
    name: "RemoteMediaFetchError",
    status: 504,
    retryable: false,
    message: "UC input media upload did not complete.",
    code: "uc_media_upload_failed",
  };
  for (const error of [
    lookalike,
    new Error(lookalike.message),
    JSON.parse(JSON.stringify(lookalike)),
  ]) {
    const f = fixture(504);
    assert.throws(
      () => createRemoteMediaFailureResponse(f.response, error, null, f.details),
      TypeError
    );
    assert.equal(isRemoteMediaFailureResponse(f.response), false);
  }
  for (const status of [503, 504]) {
    const ordinary = Response.json({ error: lookalike }, { status });
    assert.equal(isRemoteMediaFailureResponse(ordinary), false);
    assert.throws(() => getRemoteMediaFailureResponseDetails(ordinary), TypeError);
    assert.throws(() => cloneRemoteMediaFailureResponse(ordinary), TypeError);
  }
});

test("new carrier cannot relabel policy/exhausted responses or successful responses", () => {
  const f = fixture();
  const policy = markRuntimePolicyResponse(new Response("policy", { status: 403 }));
  const exhausted = markExhaustedNetworkResponse(new Response("exhausted", { status: 502 }));
  for (const response of [policy, exhausted, new Response("success")]) {
    assert.throws(
      () => createRemoteMediaFailureResponse(response, f.error, null, f.details),
      TypeError
    );
    assert.equal(isRemoteMediaFailureResponse(response), false);
  }
  assert.equal(isRuntimePolicyResponse(policy), true);
  assert.equal(isExhaustedNetworkResponse(exhausted), true);
});

test("native caller abort admits cancellation without manufacturing runtime policy", () => {
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  const f = fixture(499);
  const response = createRemoteMediaFailureResponse(
    f.response,
    reason,
    controller.signal,
    f.details
  );
  assert.equal(isRemoteMediaFailureResponse(response), true);
  assert.equal(response.status, 499);
  assert.equal(isRuntimePolicyResponse(response), false);
});

test("aborted signal proof uses native state, not prototype membership or shadow properties", () => {
  const f = fixture(499);
  const prototypeOnly = Object.create(AbortSignal.prototype);
  Object.defineProperty(prototypeOnly, "aborted", { value: true });
  const live = new AbortController();
  Object.defineProperty(live.signal, "aborted", { value: true });
  for (const fake of [{ aborted: true }, prototypeOnly, live.signal]) {
    assert.throws(
      () =>
        createRemoteMediaFailureResponse(
          new Response(f.text, { status: 499 }),
          new Error("ordinary"),
          fake as AbortSignal,
          f.details
        ),
      TypeError
    );
  }
  const aborted = new AbortController();
  aborted.abort();
  Object.defineProperty(aborted.signal, "aborted", { value: false });
  const response = createRemoteMediaFailureResponse(
    f.response,
    new Error("ordinary"),
    aborted.signal,
    f.details
  );
  assert.equal(isRemoteMediaFailureResponse(response), true);
});

test("trusted header replacement preserves private details and never tees or reads the body", async () => {
  let pulls = 0;
  let forbiddenReads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        pulls++;
      },
    },
    { highWaterMark: 0 }
  );
  const f = fixture();
  const response = createRemoteMediaFailureResponse(
    new Response(body, {
      status: 502,
      statusText: "Local media",
      headers: { "x-original": "yes" },
    }),
    f.error,
    null,
    f.details
  );
  const forbidden = () => {
    forbiddenReads++;
    throw new Error("body read/tee is forbidden");
  };
  for (const name of ["clone", "json", "text"] as const) {
    Object.defineProperty(response, name, { value: forbidden });
  }
  Object.defineProperty(body, "tee", { value: forbidden });
  const details = getRemoteMediaFailureResponseDetails(response);
  const headers = new Headers(response.headers);
  headers.set("X-OmniRoute-Selected-Connection-Id", "fixture-connection");
  const replacement = cloneRemoteMediaFailureResponse(response, headers);
  assert.equal(isRemoteMediaFailureResponse(replacement), true);
  assert.strictEqual(getRemoteMediaFailureResponseDetails(replacement), details);
  assert.equal(replacement.status, 502);
  assert.equal(replacement.statusText, "Local media");
  assert.equal(replacement.headers.get("x-original"), "yes");
  assert.equal(replacement.headers.get("X-OmniRoute-Selected-Connection-Id"), "fixture-connection");
  assert.equal(response.bodyUsed, false);
  assert.equal(replacement.bodyUsed, false);
  assert.strictEqual(
    replacement.body,
    response.body,
    "header replacement must keep the original body"
  );
  assert.equal(isRuntimePolicyResponse(replacement), false);
  assert.equal(isExhaustedNetworkResponse(replacement), false);
  await Promise.resolve();
  assert.equal(pulls, 0);
  assert.equal(forbiddenReads, 0);
  await replacement.body?.cancel();
});

test("ordinary native cloning and JSON serialization do not copy the carrier", async () => {
  const f = fixture();
  const response = createRemoteMediaFailureResponse(f.response, f.error, null, f.details);
  const clone = response.clone();
  assert.equal(isRemoteMediaFailureResponse(clone), false);
  assert.equal(isRemoteMediaFailureResponse(JSON.parse(JSON.stringify(response))), false);
  const bodies = await Promise.all([response.text(), clone.text()]);
  assert.deepEqual(bodies, [f.text, f.text]);
});

test("HMR defining-leaf copies preserve old and new brands without constructor identity", async () => {
  const duplicate = (await import(
    new URL("../../src/shared/network/mediaFailure.ts?response-hmr", import.meta.url).href
  )) as typeof import("../../src/shared/network/mediaFailure.ts");
  assert.notStrictEqual(duplicate.RemoteMediaFetchError, RemoteMediaFetchError);
  const error = new duplicate.RemoteMediaFetchError(new Error("fixture"), 504);
  assert.ok(error instanceof RemoteMediaFetchError);
  const result = duplicate.createRemoteMediaFailureResult(error);
  assert.equal(isRemoteMediaFailureResult(result), true);
  assert.equal(isRemoteMediaFailureResult(JSON.parse(JSON.stringify(result))), false);
  assert.equal(isRemoteMediaFailureResult({ ...result }), false);
  const oldResult = createRemoteMediaFailureResult(error);
  assert.equal(duplicate.isRemoteMediaFailureResult(oldResult), true);
  const f = fixture(504);
  const response = duplicate.createRemoteMediaFailureResponse(f.response, error, null, f.details);
  assert.equal(isRemoteMediaFailureResponse(response), true);
  const replacement = cloneRemoteMediaFailureResponse(response);
  assert.equal(duplicate.isRemoteMediaFailureResponse(replacement), true);
  assert.deepEqual(duplicate.getRemoteMediaFailureResponseDetails(replacement), {
    status: 504,
    ...f.details,
  });
  assert.equal(
    await replacement.text(),
    f.text,
    "finite body bytes survive the trusted replacement"
  );
});
