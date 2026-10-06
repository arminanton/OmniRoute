import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { Agent, fetch, type Dispatcher } from "undici";

// Allows the same regressions to be run against the unmodified release candidate.
const root = process.env.OMNIROUTE_TEST_REPO_ROOT
  ? pathToFileURL(`${process.env.OMNIROUTE_TEST_REPO_ROOT}/`)
  : new URL("../../", import.meta.url);
const { createRoundRobinDispatcher } = await import(
  new URL("open-sse/utils/proxyDispatcherCache.ts", root).href
);
const { directFetchWithBoundedResponseStart } = await import(
  new URL("open-sse/utils/directResponseStartTimeout.ts", root).href
);
const { getDefaultDispatcher, clearDispatcherCache } = await import(
  new URL("open-sse/utils/proxyDispatcher.ts", root).href
);

test("transport picks an available slot after uneven stream completion", () => {
  const calls: number[] = [];
  const handlers: Dispatcher.DispatchHandler[] = [];
  const pools = [0, 1, 2, 3].map(
    (index) =>
      ({
        dispatch(_options: unknown, handler: Dispatcher.DispatchHandler) {
          calls.push(index);
          handlers.push(handler);
          return true;
        },
      }) as unknown as Dispatcher
  );
  const dispatcher = createRoundRobinDispatcher(pools);
  const options = {
    origin: "https://example.test",
    path: "/",
    method: "POST",
  } as Dispatcher.DispatchOptions;
  for (let i = 0; i < 4; i++) dispatcher.dispatch(options, {});
  for (let i = 1; i < 4; i++) handlers[i].onResponseEnd?.({} as Dispatcher.DispatchController, {});
  dispatcher.dispatch(options, {});
  assert.equal(calls.at(-1), 1, "pool zero is still busy, while pool one is available");
});

test(
  "100 independent SSE calls do not spend their headers budget in the local queue",
  { timeout: 15000 },
  async () => {
    let received = 0;
    const server = http.createServer((_req, res) => {
      received++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      const timer = setTimeout(() => res.end("data: [DONE]\n\n"), 1200);
      res.on("close", () => clearTimeout(timer));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const dispatcher = createRoundRobinDispatcher(
      Array.from({ length: 32 }, () => new Agent({ connections: 1, pipelining: 1 }))
    );
    const address = server.address() as { port: number };
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 100 }, async () => {
          const response = await directFetchWithBoundedResponseStart(
            `http://127.0.0.1:${address.port}`,
            { dispatcher, signal: AbortSignal.timeout(10000) },
            (input: RequestInfo | URL, options: RequestInit) =>
              fetch(String(input), options as Parameters<typeof fetch>[1]),
            1000,
            true
          );
          await response.text();
        })
      );
      assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 100);
      assert.equal(received, 100);
    } finally {
      await dispatcher.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);

test("production direct dispatcher reuses HTTP connections between turns", async () => {
  let connections = 0;
  const server = http.createServer((_req, res) => res.end("ok"));
  server.on("connection", () => connections++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS;
  process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS = "1";
  clearDispatcherCache();
  const dispatcher = getDefaultDispatcher();
  try {
    for (let i = 0; i < 5; i++) {
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        { dispatcher }
      );
      await response.text();
    }
    assert.equal(connections, 1);
  } finally {
    await dispatcher.destroy();
    clearDispatcherCache();
    if (previous === undefined) delete process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS;
    else process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS = previous;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("local queue exhaustion is classified as admission capacity and respects caller cancellation", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: {}\n\n");
    setTimeout(() => res.end(), 200);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dispatcher = createRoundRobinDispatcher([new Agent({ connections: 1, pipelining: 1 })]);
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const first = await fetch(url, { dispatcher });
  const draining = first.text();
  const adapter = (input: RequestInfo | URL, options: RequestInit) =>
    fetch(String(input), options as Parameters<typeof fetch>[1]);
  try {
    await assert.rejects(
      directFetchWithBoundedResponseStart(url, { dispatcher }, adapter, 1000, true, 20),
      { code: "SEMAPHORE_TIMEOUT" }
    );
    const controller = new AbortController();
    const reason = new Error("client cancelled queued request");
    const pending = directFetchWithBoundedResponseStart(
      url,
      { dispatcher, signal: controller.signal },
      adapter,
      1000,
      true
    );
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    await draining;
  } finally {
    await dispatcher.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
