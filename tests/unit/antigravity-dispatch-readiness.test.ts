import "../_setup/isolateDataDir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Agent, fetch as undiciFetch } from "undici";
import { observeFetchDispatcher } from "../../open-sse/utils/fetchDispatchObserver.ts";
import { fetchAntigravityWithReadinessTimeout } from "../../open-sse/executors/antigravity/executeAttempt.ts";

test("100 queued Antigravity streams wait for a lane before their header deadline starts", async () => {
  let reached = 0;
  const startedAt = Date.now();
  let lastArrival = startedAt;
  const server = http.createServer((_req, res) => {
    reached++;
    lastArrival = Date.now();
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(
        'data: {"response":{"candidates":[{"content":{"parts":[{"text":"OK"}]},"finishReason":"STOP"}]}}\n\n'
      );
      setTimeout(() => res.end("data: [DONE]\n\n"), 100);
    }, 5);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const agent = new Agent({ connections: 4, pipelining: 1 });
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    undiciFetch(String(url), {
      ...init,
      dispatcher: observeFetchDispatcher(agent),
    } as never) as unknown as Response;
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 100 }, async () => {
        const response = await fetchAntigravityWithReadinessTimeout(
          `http://127.0.0.1:${port}`,
          {},
          500,
          10000
        );
        assert.equal(response.status, 200);
        assert.match(await response.text(), /STOP/);
      })
    );
    assert.equal(
      results.filter((r) => r.status === "rejected").length,
      0,
      JSON.stringify(results.filter((r) => r.status === "rejected"))
    );
    assert.equal(reached, 100);
    assert.ok(lastArrival - startedAt > 500, "queued turns outlive the response-start budget");
  } finally {
    globalThis.fetch = original;
    await agent.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("local queue expiry is classified separately from provider response timeout", async () => {
  const agent = new Agent({ connections: 1, pipelining: 1 });
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.write("open");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    undiciFetch(String(url), {
      ...init,
      dispatcher: observeFetchDispatcher(agent),
    } as never) as unknown as Response;
  let first: Response | undefined;
  try {
    first = await fetchAntigravityWithReadinessTimeout(`http://127.0.0.1:${port}`, {}, 500, 500);
    await assert.rejects(
      fetchAntigravityWithReadinessTimeout(`http://127.0.0.1:${port}`, {}, 500, 30),
      (error: unknown) => (error as { code?: string }).code === "SEMAPHORE_TIMEOUT"
    );
  } finally {
    globalThis.fetch = original;
    await first?.body?.cancel();
    await agent.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
