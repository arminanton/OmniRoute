import test from "node:test";
import assert from "node:assert/strict";
import type { CDPSession, Page } from "playwright";
import {
  captureGeminiWebAccountCatalog,
  GEMINI_ACCOUNT_CATALOG_MAX_BYTES,
} from "../../open-sse/executors/gemini-web/accountCapture.ts";
import { GeminiWebExecutor } from "../../open-sse/executors/gemini-web.ts";
import type { BrowserPageLease } from "../../open-sse/services/browserPool.ts";

class FakeSession {
  listener?: (event: Record<string, unknown>) => void;
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  body = "";
  position = 0;
  blockRead = false;

  on(event: string, listener: (event: Record<string, unknown>) => void) {
    assert.equal(event, "Fetch.requestPaused");
    this.listener = listener;
  }
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Fetch.takeResponseBodyAsStream") return { stream: "stream-1" };
    if (method === "IO.read") {
      if (this.blockRead) return new Promise(() => {});
      const size = Number(params.size);
      const data = this.body.slice(this.position, this.position + size);
      this.position += data.length;
      return { data, eof: this.position >= this.body.length };
    }
    return {};
  }
  async detach() {
    this.calls.push({ method: "detach", params: {} });
  }
  off(event: string, listener: (event: Record<string, unknown>) => void) {
    assert.equal(event, "Fetch.requestPaused");
    if (this.listener === listener) this.listener = undefined;
  }
  emit(url: string, responseHeaders: Array<{ name: string; value: string }> = []) {
    this.listener?.({
      requestId: `request-${this.calls.length}`,
      request: { url },
      responseStatusCode: 200,
      responseHeaders,
    });
  }
  count(method: string) {
    return this.calls.filter((call) => call.method === method).length;
  }
}

class FakePage {
  gotoCalls: Array<{ url: string; options: Record<string, unknown> }> = [];
  constructor(private readonly session: FakeSession, private readonly emitRpc = true) {}
  async goto(url: string, options: Record<string, unknown>) {
    this.gotoCalls.push({ url, options });
    if (this.emitRpc) {
      queueMicrotask(() => {
        this.session.emit(
          "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=uqlm3e%2CotAQ7b"
        );
      });
    }
    return null;
  }
}

function validResponse(): string {
  const payload = Array(17).fill(null);
  payload[14] = 1000;
  payload[15] = [["opaque-id", "Gemini Pro", "Account model"]];
  const rows = [
    ["wrb.fr", "otAQ7b", JSON.stringify({ prompt: "must stay metadata only" })],
    ["wrb.fr", "uqlm3e", JSON.stringify(payload)],
  ];
  const frame = JSON.stringify(rows);
  return `)]}'\n${frame.length}\n${frame}`;
}

function callCapture(
  session: FakeSession,
  page: FakePage,
  timeoutMs = 200,
  readTimeoutMs = 100,
  signal?: AbortSignal
) {
  return captureGeminiWebAccountCatalog(
    page as unknown as Page,
    session as unknown as CDPSession,
    timeoutMs,
    readTimeoutMs,
    signal
  );
}

test("bounded capture ignores missing and understated Content-Length", async () => {
  for (const headers of [[], [{ name: "Content-Length", value: "1" }]]) {
    const session = new FakeSession();
    session.body = "x".repeat(GEMINI_ACCOUNT_CATALOG_MAX_BYTES + 10);
    const page = new FakePage(session);
    const result = callCapture(session, page);
    session.emit(
      "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=uqlm3e",
      headers
    );
    await assert.rejects(result, /exceeds 2 MiB/);
    assert.ok(session.count("Fetch.failRequest") > 0);
    assert.equal(session.count("Fetch.takeResponseBodyAsStream"), 1);
    assert.ok(
      session.calls
        .filter((call) => call.method === "IO.read")
        .every((call) => Number(call.params.size) <= 64 * 1024)
    );
    assert.ok(session.position <= GEMINI_ACCOUNT_CATALOG_MAX_BYTES + 1);
    assert.equal(session.count("Fetch.disable"), 1);
    assert.equal(session.count("detach"), 1);
  }
});

test("unsupported RPC stays metadata-only; capture returns only uqlm3e model data", async () => {
  const session = new FakeSession();
  session.body = validResponse();
  const page = new FakePage(session, false);
  const result = callCapture(session, page);
  session.emit(
    "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b"
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.count("Fetch.continueResponse"), 1);
  assert.equal(session.count("Fetch.takeResponseBodyAsStream"), 0);
  session.emit(
    "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=uqlm3e%2CotAQ7b"
  );
  const catalog = await result;
  assert.deepEqual(catalog, {
    models: [{ id: "opaque-id", displayName: "Gemini Pro", description: "Account model" }],
    unsupportedRpcIds: ["otAQ7b"],
  });
  assert.equal(session.count("Fetch.takeResponseBodyAsStream"), 1);
  assert.equal(page.gotoCalls.length, 1);
  assert.equal(page.gotoCalls[0].url, "https://gemini.google.com/app");
  assert.deepEqual(page.gotoCalls[0].options, {
    waitUntil: "domcontentloaded",
    timeout: 200,
  });
  assert.equal(session.count("Fetch.disable"), 1);
  assert.equal(session.count("detach"), 1);
});

test("IO.read timeout cancels paused catalog request and detaches CDP session", async () => {
  const session = new FakeSession();
  session.blockRead = true;
  const page = new FakePage(session, false);
  const result = callCapture(session, page, 200, 15);
  session.emit(
    "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=uqlm3e"
  );
  await assert.rejects(result, /capture timed out/);
  assert.equal(session.count("IO.close"), 1);
  assert.ok(session.count("Fetch.failRequest") > 0);
  assert.equal(session.count("Fetch.disable"), 1);
  assert.equal(session.count("detach"), 1);
});

test("capture timeout cleans up Fetch and detaches session", async () => {
  const session = new FakeSession();
  const page = new FakePage(session, false);
  await assert.rejects(callCapture(session, page, 10, 100), /capture timed out/);
  assert.equal(session.count("Fetch.disable"), 1);
  assert.equal(session.count("detach"), 1);
});

test("capture abort during IO.read cancels request and cleans up within bound", async () => {
  const session = new FakeSession();
  session.blockRead = true;
  const page = new FakePage(session);
  const controller = new AbortController();
  const result = callCapture(session, page, 1_000, 5_000, controller.signal);
  session.emit("https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=uqlm3e");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.count("IO.read"), 1);

  const startedAt = Date.now();
  controller.abort();
  await assert.rejects(result, (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "capture_aborted"
  );
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(session.count("IO.close"), 1);
  assert.ok(session.count("Fetch.failRequest") > 0);
  assert.equal(session.count("Fetch.disable"), 1);
  assert.equal(session.count("detach"), 1);
  assert.equal(session.listener, undefined);
});

test("executor releases browser lease when catalog capture aborts", async () => {
  const session = new FakeSession();
  session.blockRead = true;
  const page = new FakePage(session);
  const context = {
    newCDPSession: async () => session,
    cookies: async () => [],
  };
  let released = false;
  const lease = {
    context,
    page,
    release: async () => {
      released = true;
    },
  } as unknown as BrowserPageLease;
  const executor = new GeminiWebExecutor(async () => lease);
  const controller = new AbortController();
  const result = executor.captureAccountModels({
    credentials: { apiKey: "__Secure-1PSID=session; __Secure-1PSIDTS=ts" },
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.count("IO.read"), 1);
  const startedAt = Date.now();
  controller.abort();
  await assert.rejects(result, (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "capture_aborted"
  );
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(released, true);
});

test("executor persists only rotated Gemini auth cookies after catalog capture", async () => {
  const session = new FakeSession();
  session.body = validResponse();
  const page = new FakePage(session);
  const context = {
    newCDPSession: async () => session,
    cookies: async () => [
      { name: "__Secure-1PSID", value: "original" },
      { name: "__Secure-1PSIDTS", value: "rotated-ts" },
      { name: "SIDCC", value: "must-not-persist" },
    ],
  };
  let released = false;
  const lease = {
    context,
    page,
    release: async () => {
      released = true;
    },
  } as unknown as BrowserPageLease;
  const executor = new GeminiWebExecutor(async () => lease);
  const patches: Array<Record<string, unknown>> = [];
  await executor.captureAccountModels({
    credentials: {
      apiKey: "__Secure-1PSID=original; __Secure-1PSIDTS=old-ts",
      connectionId: "connection-1",
    },
    onCredentialsRefreshed: async (patch) => {
      patches.push(patch);
    },
  });
  assert.equal(released, true);
  assert.equal(patches.length, 1);
  assert.equal(
    patches[0].apiKey,
    "__Secure-1PSID=original; __Secure-1PSIDTS=rotated-ts"
  );
  assert.equal(String(patches[0].apiKey).includes("must-not-persist"), false);
});
