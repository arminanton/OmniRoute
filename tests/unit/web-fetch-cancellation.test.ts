import test from "node:test";
import assert from "node:assert/strict";

const { handleWebFetch } = await import("../../open-sse/handlers/webFetch.ts");
const { tinyfishFetch } = await import("../../open-sse/executors/tinyfish-fetch.ts");
const { WEB_FETCH_CALLER_ABORT_CODE } = await import("../../open-sse/utils/webFetchAbort.ts");

function pendingUntilAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const rejectAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal.aborted) {
      rejectAbort();
      return;
    }
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("handleWebFetch preserves Firecrawl caller cancellation instead of returning provider 502", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let upstreamSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    upstreamSignal = (init as RequestInit).signal as AbortSignal;
    return pendingUntilAborted(upstreamSignal);
  };

  try {
    const request = handleWebFetch(
      { url: "https://example.com" },
      { apiKey: "test-key" },
      "firecrawl",
      caller.signal
    );
    await nextTurn();
    caller.abort("client disconnected");

    await assert.rejects(request, (error: Error & { code?: string }) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.code, WEB_FETCH_CALLER_ABORT_CODE);
      assert.equal(error.message, "client disconnected");
      return true;
    });
    assert.equal(upstreamSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("handleWebFetch passes caller cancellation through to Jina Reader", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let upstreamSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    upstreamSignal = (init as RequestInit).signal as AbortSignal;
    return pendingUntilAborted(upstreamSignal);
  };

  try {
    const request = handleWebFetch(
      { url: "https://example.com" },
      { apiKey: "jina-key" },
      "jina-reader",
      caller.signal
    );
    await nextTurn();
    caller.abort("client disconnected");

    await assert.rejects(request, (error: Error & { code?: string }) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.code, WEB_FETCH_CALLER_ABORT_CODE);
      return true;
    });
    assert.equal(upstreamSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TinyFish cancels a long-running browser extraction when its caller disconnects", async () => {
  const originalFetch = globalThis.fetch;
  const caller = new AbortController();
  let upstreamSignal: AbortSignal | null = null;
  globalThis.fetch = async (_url, init = {}) => {
    upstreamSignal = (init as RequestInit).signal as AbortSignal;
    return pendingUntilAborted(upstreamSignal);
  };

  try {
    const request = tinyfishFetch({
      url: "https://example.com",
      format: "markdown",
      includeMetadata: false,
      credentials: { apiKey: "tf-key" },
      signal: caller.signal,
    });
    await nextTurn();
    caller.abort(new Error("downstream socket closed"));

    await assert.rejects(request, (error: Error & { code?: string }) => {
      assert.equal(error.name, "AbortError");
      assert.equal(error.code, WEB_FETCH_CALLER_ABORT_CODE);
      assert.match(error.message, /downstream socket closed/);
      return true;
    });
    assert.equal(upstreamSignal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
