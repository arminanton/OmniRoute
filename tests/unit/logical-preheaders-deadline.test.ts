import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { fetch as undiciFetch, Agent } from "undici";
import {
  LogicalRetryBudget,
  runGenerationDispatch,
  runWithLogicalRetryBudget,
  budgetedGenerationFetch,
  isLogicalRetryBudgetError,
} from "../../open-sse/services/logicalRetryBudget.ts";
import {
  proxyFetch,
  runWithTlsTracking,
  runWithProxyContext,
  setTlsClientForTest,
} from "../../open-sse/utils/proxyFetch.ts";
import { withProviderResponseStartDeadline } from "../../open-sse/utils/providerResponseStartDeadline.ts";

test(
  "real dispatcher headers obey remaining logical deadline rather than80s executor timeout",
  { timeout: 2000 },
  async () => {
    const server = http.createServer((_req, response) =>
      setTimeout(() => response.end("late"), 500)
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = new Agent({ connections: 1 });
    try {
      const fetch = proxyFetch;
      const started = Date.now();
      await assert.rejects(
        runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 80), () =>
          runGenerationDispatch(() =>
            withProviderResponseStartDeadline(
              80000,
              null,
              (signal) =>
                fetch(`http://127.0.0.1:${address.port}/responses`, {
                  method: "POST",
                  signal: signal ?? undefined,
                  dispatcher: agent,
                }),
              () => new Error("operator headers timeout")
            )
          )
        ),
        isLogicalRetryBudgetError
      );
      assert.ok(Date.now() - started < 350);
    } finally {
      await agent.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);

test("successful response headers detach logical timer from streaming body", async () => {
  const fetch = budgetedGenerationFetch(
    async (_url: string, options: { method: string; signal?: AbortSignal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              assert.equal(options.signal?.aborted ?? false, false);
              controller.enqueue(new TextEncoder().encode("later body"));
              controller.close();
            }, 80);
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      )
  );
  const response = await runWithLogicalRetryBudget(
    new LogicalRetryBudget(12, Date.now() + 30),
    () =>
      runGenerationDispatch(() => fetch("https://example.invalid/responses", { method: "POST" }))
  );
  assert.equal(await response.text(), "later body");
});

test("native TLS direct and proxy queues abort at remaining logical deadline without transport fallback", async () => {
  const keys = [
    "ENABLE_TLS_FINGERPRINT",
    "TLS_FINGERPRINT_PROVIDERS",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
  ];
  const previous = keys.map((key) => process.env[key]);
  keys.forEach((key) => delete process.env[key]);
  process.env.ENABLE_TLS_FINGERPRINT = "true";
  process.env.TLS_FINGERPRINT_PROVIDERS = "codex";
  let calls = 0;
  setTlsClientForTest({
    available: true,
    fetch: async (_url, options) => {
      calls++;
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    },
  });
  try {
    for (const proxy of [null, "http://127.0.0.1:9"]) {
      const started = Date.now();
      await assert.rejects(
        runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 35), () =>
          runGenerationDispatch(() =>
            runWithProxyContext(
              proxy,
              () =>
                runWithTlsTracking({ provider: "codex", sessionScope: "fixture" }, () =>
                  proxyFetch("https://example.invalid/responses", { method: "POST" })
                ),
              { skipUnreachableProbe: true }
            )
          )
        ),
        isLogicalRetryBudgetError
      );
      assert.ok(Date.now() - started < 250);
    }
    assert.equal(calls, 2);
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    setTlsClientForTest(null);
  }
});

test("logical cancellation retains physical ownership until an uncooperative dispatcher settles", async () => {
  const { getPhysicalGenerationCount } =
    await import("../../open-sse/services/generationLifetime.ts");
  let resolve: (response: Response) => void = () => {};
  let cancelled = false;
  const fetch = budgetedGenerationFetch(
    async () =>
      new Promise<Response>((done) => {
        resolve = done;
      })
  );
  const baseline = getPhysicalGenerationCount();
  await assert.rejects(
    runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 20), () =>
      runGenerationDispatch(() => fetch("https://example.invalid/responses", { method: "POST" }))
    ),
    isLogicalRetryBudgetError
  );
  assert.equal(getPhysicalGenerationCount(), baseline + 1);
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      })
    )
  );
  await new Promise<void>((done) => setTimeout(done, 0));
  assert.equal(cancelled, true);
  assert.equal(getPhysicalGenerationCount(), baseline);
});

test(
  "real occupied Undici connection queue releases without sending an expired generation",
  { timeout: 2000 },
  async () => {
    let generationCalls = 0;
    let ready: () => void = () => {};
    const occupied = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const server = http.createServer((req, response) => {
      if (req.url === "/hold") {
        ready();
        setTimeout(() => response.end("released"), 500);
      } else {
        generationCalls++;
        response.end("unexpected generation");
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const agent = new Agent({ connections: 1 });
    const holder = undiciFetch(`http://127.0.0.1:${address.port}/hold`, {
      dispatcher: agent,
    }).catch(() => undefined);
    try {
      await occupied;
      await assert.rejects(
        runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 40), () =>
          runGenerationDispatch(() =>
            proxyFetch(`http://127.0.0.1:${address.port}/responses`, {
              method: "POST",
              dispatcher: agent,
            })
          )
        ),
        isLogicalRetryBudgetError
      );
      assert.equal(generationCalls, 0);
    } finally {
      await agent.destroy();
      await holder;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);
