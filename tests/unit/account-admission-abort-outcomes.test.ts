import test from "node:test";
import assert from "node:assert/strict";

const { handleJinaFoundationProxy } = await import("../../open-sse/handlers/jinaFoundation.ts");
const { handleModeration } = await import("../../open-sse/handlers/moderations.ts");

type HandlerName = "jina" | "moderation";

interface AdmissionFixture {
  loseLease(): void;
  stats: { releases: number; renewals: number; cancellations: number };
  restore(): void;
}

function configureSharedAdmissionFixture(): AdmissionFixture {
  const priorEnabled = process.env.OMNI_SHARED_ADMISSION;
  const priorDb = process.env.OMNI_COORDINATION_DB;
  const runtime = globalThis as any;
  const priorCoordinator = runtime.__omniSharedCoordinator;
  const priorSetInterval = globalThis.setInterval;
  const priorClearInterval = globalThis.clearInterval;
  const stats = { releases: 0, renewals: 0, cancellations: 0 };
  let heartbeat: (() => void) | null = null;
  const lease = { testLease: true };

  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = "fake-coordinator-test.sqlite";
  runtime.__omniSharedCoordinator = {
    enqueue: () => "test-admission-request",
    tryAcquire: () => lease,
    renew: () => {
      stats.renewals++;
      return false;
    },
    release: () => {
      stats.releases++;
    },
    cancel: () => {
      stats.cancellations++;
    },
  };
  globalThis.setInterval = ((callback: () => void) => {
    heartbeat = callback;
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;

  return {
    stats,
    loseLease() {
      assert.ok(heartbeat, "the shared account lease heartbeat should be active");
      heartbeat();
    },
    restore() {
      if (priorEnabled === undefined) delete process.env.OMNI_SHARED_ADMISSION;
      else process.env.OMNI_SHARED_ADMISSION = priorEnabled;
      if (priorDb === undefined) delete process.env.OMNI_COORDINATION_DB;
      else process.env.OMNI_COORDINATION_DB = priorDb;
      runtime.__omniSharedCoordinator = priorCoordinator;
      globalThis.setInterval = priorSetInterval;
      globalThis.clearInterval = priorClearInterval;
    },
  };
}

async function invokeHandler(handler: HandlerName, signal: AbortSignal): Promise<Response> {
  if (handler === "jina") {
    return handleJinaFoundationProxy({
      path: "/v1/classify",
      upstreamUrl: "https://api.jina.ai/v1/classify",
      body: { model: "jina-embeddings-v5-text-small", input: ["hello"], labels: ["greeting"] },
      credentials: {
        apiKey: "jina-test-key",
        connectionId: "jina-admission-test",
        maxConcurrent: 2,
      },
      provider: "jina-ai",
      signal,
    });
  }

  return handleModeration({
    body: { model: "openai/omni-moderation-latest", input: "hello" },
    credentials: {
      apiKey: "moderation-test-key",
      connectionId: "moderation-admission-test",
      maxConcurrent: 2,
    },
    signal,
  });
}

async function assertCancellationOutcome(handler: HandlerName, kind: "caller" | "lease-loss") {
  const fixture = configureSharedAdmissionFixture();
  const priorFetch = globalThis.fetch;
  const caller = new AbortController();
  let announceUpstreamStarted!: (signal: AbortSignal) => void;
  const upstreamStarted = new Promise<AbortSignal>((resolve) => {
    announceUpstreamStarted = resolve;
  });
  let fetchCalls = 0;
  globalThis.fetch = async (_url, init = {}) => {
    fetchCalls++;
    const upstreamSignal = (init as RequestInit).signal as AbortSignal;
    announceUpstreamStarted(upstreamSignal);
    return new Promise<Response>((_resolve, reject) => {
      const abort = () =>
        reject(upstreamSignal.reason ?? new DOMException("Aborted", "AbortError"));
      if (upstreamSignal.aborted) abort();
      else upstreamSignal.addEventListener("abort", abort, { once: true });
    });
  };

  try {
    const responsePromise = invokeHandler(handler, caller.signal);
    const upstreamSignal = await upstreamStarted;
    if (kind === "caller") caller.abort(new Error("synthetic client disconnect"));
    else fixture.loseLease();

    const response = await responsePromise;
    assert.equal(response.status, kind === "caller" ? 499 : 503);
    assert.equal(upstreamSignal.aborted, true, "abort must be propagated to upstream fetch");
    assert.equal(fetchCalls, 1, "cancellation must not retry or fall back to another provider");

    if (kind === "caller") {
      assert.equal(fixture.stats.releases, 1, "caller cancellation releases the held shared slot");
    } else {
      assert.equal(fixture.stats.renewals, 1, "lease-loss heartbeat must fence the request");
      assert.equal(
        fixture.stats.releases,
        0,
        "a lost distributed lease stays fenced until its TTL instead of being prematurely freed"
      );
    }
    assert.equal(fixture.stats.cancellations, 1);
  } finally {
    caller.abort();
    globalThis.fetch = priorFetch;
    fixture.restore();
  }
}

for (const handler of ["jina", "moderation"] as const) {
  test(`${handler} returns 499 for caller abort and releases the shared admission slot`, async () => {
    await assertCancellationOutcome(handler, "caller");
  });

  test(`${handler} returns 503 for shared lease loss without retrying`, async () => {
    await assertCancellationOutcome(handler, "lease-loss");
  });
}
