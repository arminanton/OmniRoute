import test from "node:test";
import assert from "node:assert/strict";
import { getAccountAdmissionAbortStatus } from "../../open-sse/services/accountRequestAdmission.ts";

test("caller cancellation maps to 499 and takes precedence when the lease is also aborted", () => {
  const caller = new AbortController();
  const lease = new AbortController();
  caller.abort(new Error("client disconnected"));
  lease.abort(new Error("lease lost"));

  assert.equal(getAccountAdmissionAbortStatus(caller.signal, lease.signal), 499);
});

test("shared admission lease loss without caller cancellation maps to 503", () => {
  const lease = new AbortController();
  lease.abort(new Error("lease lost"));

  assert.equal(getAccountAdmissionAbortStatus(new AbortController().signal, lease.signal), 503);
});

test("active caller and active lease have no cancellation status", () => {
  assert.equal(
    getAccountAdmissionAbortStatus(new AbortController().signal, new AbortController().signal),
    null
  );
});
