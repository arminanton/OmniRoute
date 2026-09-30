import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { AmeliaClient, ChipotleExecutor } from "../../open-sse/executors/chipotle.ts";

class FakeSocket extends EventEmitter {
  terminated = false;
  readyState = 1;
  send() {}
  terminate() {
    this.terminated = true;
    this.emit("close");
  }
  close() {
    this.emit("close");
  }
}
class TestClient extends AmeliaClient {
  socket = new FakeSocket();
  protected async openSocket(): Promise<WebSocket> {
    return this.socket as unknown as WebSocket;
  }
}
function mockInit() {
  mock.method(globalThis, "fetch", async () =>
    Response.json({ csrfToken: "test", user: { userId: "test" } })
  );
}
test.afterEach(() => mock.restoreAll());

test("init has bounded timeout and caller cancellation", async () => {
  const controller = new AbortController();
  let received: AbortSignal | null | undefined;
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    received = init.signal;
    return new Promise<Response>((_resolve, reject) => {
      received!.addEventListener("abort", () => reject(received!.reason), { once: true });
    });
  });
  const client = new AmeliaClient();
  const pending = client.init(controller.signal);
  assert.ok(received);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("init timeout aborts stalled HTTP request", async () => {
  const timeoutController = new AbortController();
  mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 15_000);
    return timeoutController.signal;
  });
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  });
  const pending = new AmeliaClient().init();
  timeoutController.abort(new DOMException("Timed out", "TimeoutError"));
  await assert.rejects(pending, { name: "TimeoutError" });
});

test("aborting WS connection terminates socket", async () => {
  mockInit();
  const client = new TestClient();
  await client.init();
  const controller = new AbortController();
  const pending = client.connect(controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(client.socket.terminated, true);
});

test("failed WS handshake terminates socket", async () => {
  mockInit();
  const client = new TestClient();
  await client.init();
  const pending = client.connect();
  await Promise.resolve();
  client.socket.emit("error", new Error("handshake failed"));
  await assert.rejects(pending, /handshake failed/);
  assert.equal(client.socket.terminated, true);
});

test("WS closed before CONNECTED rejects immediately", async () => {
  mockInit();
  const client = new TestClient();
  await client.init();
  const pending = client.connect();
  await Promise.resolve();
  client.socket.emit("close");
  await assert.rejects(pending, /closed before STOMP/);
  assert.equal(client.socket.terminated, true);
});

test("successful STOMP handshake removes abort handler", async () => {
  mockInit();
  const client = new TestClient();
  await client.init();
  const controller = new AbortController();
  const pending = client.connect(controller.signal);
  await Promise.resolve();
  client.socket.emit("message", 'a["CONNECTED\\n\\n\\u0000"]');
  await pending;
  controller.abort();
  assert.equal(client.socket.terminated, false);
  await client.close();
});

test("WS timeout terminates unfinished connection", async (t) => {
  mockInit();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new TestClient();
  await client.init();
  const pending = client.connect();
  await Promise.resolve();
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, /WS connect timeout/);
  assert.equal(client.socket.terminated, true);
});

test("executor returns 499 when cancelled during initialization", async () => {
  const controller = new AbortController();
  mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  });
  const pending = new ChipotleExecutor().execute({
    model: "pepper-1",
    stream: false,
    body: { messages: [] },
    credentials: {},
    signal: controller.signal,
  });
  controller.abort();
  const { response } = await pending;
  assert.equal(response.status, 499);
  const body = await response.json();
  assert.equal(body.error.code, "ABORTED");
});
