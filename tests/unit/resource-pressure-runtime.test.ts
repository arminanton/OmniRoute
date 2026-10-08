import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createResourcePressureRuntime,
  type ResourcePressureRuntime,
} from "../../open-sse/utils/resourcePressure.ts";
import type { ResourceSignals } from "../../open-sse/utils/resourcePressurePolicy.ts";

const MiB = 1024 ** 2;

function signals(observedAtMs: number, heapUsedMb = 100): ResourceSignals {
  return {
    observedAtMs,
    v8: { heapUsedBytes: heapUsedMb * MiB, heapLimitBytes: 1_000 * MiB },
    process: {
      rssBytes: 200 * MiB,
      externalBytes: 10 * MiB,
      arrayBuffersBytes: MiB,
      availableBytes: null,
      constrainedBytes: null,
    },
    cgroup: { currentBytes: null, maxBytes: null, highBytes: null, fileBytes: null, events: null },
    psi: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function settleRefresh(runtime: ResourcePressureRuntime): Promise<void> {
  await runtime.whenRefreshSettled();
  await Promise.resolve();
}

describe("ResourcePressureRuntime stale-while-revalidate cache", () => {
  it("does no proc/sys I/O in check(), while a cheap first-request heap breach sheds immediately", async () => {
    let slowSamples = 0;
    const runtime = createResourcePressureRuntime({
      heapThresholdMb: 200,
      immediateHeapUsedMb: () => 201,
      sample: async () => {
        slowSamples += 1;
        return signals(1);
      },
    });

    const guard = runtime.check();
    assert.ok(guard);
    assert.equal(guard.status, 503);
    assert.equal(slowSamples, 0, "request-path check must not invoke the async proc/sys sampler");
    assert.equal(runtime.getObservation().state.reason, "v8_heap_absolute");
    await settleRefresh(runtime);
    assert.equal(slowSamples, 1, "refresh may run after the request-path decision");
    runtime.dispose();
  });

  it("logs event-time process and V8 memory when no asynchronous sample exists yet", () => {
    let memoryReads = 0;
    const runtime = createResourcePressureRuntime({
      heapThresholdMb: 200,
      immediateMemoryUsage: () => {
        memoryReads++;
        return {
          rss: 321 * MiB,
          heapTotal: 250 * MiB,
          heapUsed: 201 * MiB,
          external: 18 * MiB,
          arrayBuffers: 12 * MiB,
        };
      },
      sample: async () => signals(1),
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      const guard = runtime.check();
      assert.ok(guard);
      assert.equal(guard.status, 503);
      assert.equal(memoryReads, 1, "one existing process-memory read supplies all event metrics");
      const diagnostic = warnings.find((warning) => warning.includes("[resourcePressure]"));
      assert.ok(diagnostic);
      assert.equal(
        warnings.length,
        1,
        "one immediate heap rejection should produce one correlated diagnostic, not a duplicate"
      );
      assert.match(diagnostic, /immediateHeapUsedMb=201/);
      assert.match(diagnostic, /eventHeapTotalMb=250/);
      assert.match(diagnostic, /eventRssMb=321/);
      assert.match(diagnostic, /eventExternalMb=18/);
      assert.match(diagnostic, /eventArrayBuffersMb=12/);
      assert.match(diagnostic, /eventV8HeapUsedMb=\d+/);
      assert.match(diagnostic, /eventV8HeapLimitMb=\d+/);
      assert.match(diagnostic, /sampleHeapUsedMb=null/);
    } finally {
      console.warn = originalWarn;
      runtime.dispose();
    }
  });

  it("clears the immediate absolute heap rejection after the live heap falls below threshold", () => {
    let liveHeapMb = 201;
    const runtime = createResourcePressureRuntime({
      heapThresholdMb: 200,
      immediateHeapUsedMb: () => liveHeapMb,
      sample: async () => signals(1, 100),
    });
    try {
      const first = runtime.check();
      assert.ok(first);
      assert.equal(first.status, 503);

      liveHeapMb = 200;
      assert.equal(
        runtime.check(),
        null,
        "the absolute threshold is a live check, not a latched outage"
      );
    } finally {
      runtime.dispose();
    }
  });

  it("logs bounded numeric memory context when the immediate heap guard sheds", async () => {
    let now = 0;
    let liveHeapMb = 100;
    const sampled = signals(0, 100);
    sampled.cgroup = {
      currentBytes: 700 * MiB,
      maxBytes: 1_000 * MiB,
      highBytes: 800 * MiB,
      fileBytes: 100 * MiB,
      events: { low: 0, high: 2, max: 0, oom: 0, oom_kill: 0 },
    };
    sampled.psi = {
      someAvg10: 12.3,
      someAvg60: 8,
      someAvg300: 4,
      fullAvg10: 0,
      fullAvg60: 0,
      fullAvg300: 0,
    };
    const runtime = createResourcePressureRuntime({
      nowMs: () => now,
      heapThresholdMb: 200,
      immediateHeapUsedMb: () => liveHeapMb,
      sample: async () => sampled,
    });

    runtime.check();
    await settleRefresh(runtime);
    now = 1;
    liveHeapMb = 201;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      const correlationId = "550e8400-e29b-41d4-a716-446655440000";
      const guard = runtime.check({
        correlationId,
        endpoint: "/api/v1/vscode/path-token-must-not-be-logged/v1/responses?api_key=secret",
        provider: "codex",
        model: "gpt-6-luna-max",
      });
      assert.ok(guard);
      assert.equal(guard.status, 503);
      assert.equal(guard.response.headers.get("x-request-id"), correlationId);
      const diagnostic = warnings.find((warning) => warning.includes("[resourcePressure]"));
      assert.ok(diagnostic);
      assert.match(diagnostic, /immediateHeapUsedMb=201/);
      assert.match(diagnostic, /thresholdMb=200/);
      assert.match(diagnostic, /sampleRssMb=200/);
      assert.match(diagnostic, /sampleExternalMb=10/);
      assert.match(diagnostic, /cgroupCurrentMb=700/);
      assert.match(diagnostic, /cgroupOomKillEvents=0/);
      assert.match(diagnostic, /psiSomeAvg10=12\.3/);
      assert.match(diagnostic, /sampleAgeMs=1/);
      assert.match(diagnostic, /pid=\d+/);
      assert.match(diagnostic, /loggedAt=/);
      assert.match(diagnostic, /route=responses/);
      assert.match(diagnostic, /provider=codex/);
      assert.match(diagnostic, /model=gpt-6-luna-max/);
      assert.equal(diagnostic.includes("path-token-must-not-be-logged"), false);
      assert.equal(diagnostic.includes("api_key=secret"), false);
      assert.match(diagnostic, new RegExp(`correlationId=${correlationId}`));

      const payload = await guard.response.json();
      assert.equal(payload.error.code, "resource_pressure");
      assert.equal(JSON.stringify(payload).includes("cgroupCurrentMb"), false);
    } finally {
      console.warn = originalWarn;
      runtime.dispose();
    }
  });

  it("replaces malformed or credential-like correlation IDs with a generated UUID", () => {
    const runtime = createResourcePressureRuntime({
      heapThresholdMb: 200,
      immediateHeapUsedMb: () => 201,
      sample: async () => signals(1),
    });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    try {
      const guard = runtime.check({ correlationId: "sk_live_do_not_log_this" });
      assert.ok(guard);
      const diagnostic = warnings.find((warning) => warning.includes("[resourcePressure]"));
      assert.ok(diagnostic);
      assert.equal(diagnostic.includes("sk_live_do_not_log_this"), false);
      const generatedId = /correlationId=([a-f0-9-]{36})/i.exec(diagnostic)?.[1];
      assert.ok(generatedId);
      assert.equal(guard.response.headers.get("x-request-id"), generatedId);
    } finally {
      console.warn = originalWarn;
      runtime.dispose();
    }
  });

  it("serves a fresh cached sample without scheduling another refresh", async () => {
    let now = 0;
    let calls = 0;
    const runtime = createResourcePressureRuntime({
      nowMs: () => now,
      staleAfterMs: 100,
      immediateHeapUsedMb: () => 100,
      sample: async () => {
        calls += 1;
        return signals(now);
      },
    });

    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 1);
    now = 99;
    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 1);
    runtime.dispose();
  });

  it("schedules at most one refresh under concurrent stale checks", async () => {
    let now = 0;
    let calls = 0;
    const pending = deferred<ResourceSignals>();
    const runtime = createResourcePressureRuntime({
      nowMs: () => now,
      staleAfterMs: 10,
      immediateHeapUsedMb: () => 100,
      sample: async () => {
        calls += 1;
        if (calls === 1) return signals(0);
        return pending.promise;
      },
    });

    runtime.check();
    await settleRefresh(runtime);
    now = 11;
    for (let index = 0; index < 50; index += 1) runtime.check();
    assert.equal(calls, 1, "scheduled work must not run synchronously in check()");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);
    pending.resolve(signals(11));
    await settleRefresh(runtime);
    assert.equal(calls, 2);
    runtime.dispose();
  });

  it("retains a bounded stale snapshot on refresh failure and retries only after backoff", async () => {
    let now = 0;
    let calls = 0;
    const runtime = createResourcePressureRuntime({
      nowMs: () => now,
      staleAfterMs: 10,
      maxStaleMs: 100,
      retryAfterMs: 20,
      immediateHeapUsedMb: () => 100,
      sample: async () => {
        calls += 1;
        if (calls === 1) return signals(0, 950);
        throw new Error("proc unavailable");
      },
      thresholds: {
        sustainedSamplesCritical: 1,
        heapAbsoluteThresholdMb: null,
      },
    });

    runtime.check();
    await settleRefresh(runtime);
    now = 11;
    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 2);
    assert.equal(runtime.getObservation().signals?.observedAtMs, 0, "failure retains stale data");

    now = 25;
    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 2, "failure backoff prevents a refresh storm");

    now = 31;
    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 3);

    now = 101;
    assert.equal(runtime.check(), null, "expired stale adaptive pressure fails open");
    runtime.dispose();
  });

  it("measures failure backoff from settlement, not refresh start", async () => {
    let now = 0;
    let calls = 0;
    const pending = deferred<ResourceSignals>();
    const runtime = createResourcePressureRuntime({
      nowMs: () => now,
      staleAfterMs: 10,
      maxStaleMs: 100,
      retryAfterMs: 20,
      immediateHeapUsedMb: () => 100,
      sample: async () => {
        calls += 1;
        if (calls === 1) return signals(0);
        return pending.promise;
      },
    });

    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 1);

    now = 11;
    runtime.check();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);

    // Slow failure: wall clock advances past retryAfter before the sample rejects.
    now = 50;
    pending.reject(new Error("proc unavailable"));
    await settleRefresh(runtime);
    assert.equal(calls, 2);

    // Retry must wait full retryAfterMs from settlement (50), not from start (11).
    now = 69;
    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 2, "failure backoff starts at settlement, not refresh start");

    now = 70;
    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 3);
    runtime.dispose();
  });

  it("measures success freshness from publication, not refresh start", async () => {
    let now = 0;
    let calls = 0;
    const pending = deferred<ResourceSignals>();
    const runtime = createResourcePressureRuntime({
      nowMs: () => now,
      staleAfterMs: 20,
      maxStaleMs: 100,
      immediateHeapUsedMb: () => 100,
      sample: async () => {
        calls += 1;
        if (calls === 1) return signals(0);
        return pending.promise;
      },
    });

    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 1);

    now = 21;
    runtime.check();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 2);

    // Slow success: wall clock advances past staleAfter before the sample resolves.
    now = 100;
    pending.resolve(signals(100));
    await settleRefresh(runtime);
    assert.equal(calls, 2);
    assert.equal(runtime.getObservation().signals?.observedAtMs, 100);

    // Freshness must run full staleAfterMs from publication (100), not start (21).
    now = 119;
    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 2, "success freshness starts at publication, not refresh start");

    now = 120;
    runtime.check();
    await settleRefresh(runtime);
    assert.equal(calls, 3);
    runtime.dispose();
  });

  it("default scheduler unrefs Immediate; injected schedulers stay caller-owned", async () => {
    // Injected schedule is never wrapped: the runtime must not call unref on it.
    let scheduled = 0;
    let unrefCalled = 0;
    const injected = (refresh: () => void) => {
      scheduled += 1;
      const handle = setImmediate(refresh);
      const originalUnref = handle.unref.bind(handle);
      handle.unref = () => {
        unrefCalled += 1;
        return originalUnref();
      };
    };

    const withInjected = createResourcePressureRuntime({
      immediateHeapUsedMb: () => 100,
      sample: async () => signals(1),
      schedule: injected,
    });
    withInjected.check();
    await settleRefresh(withInjected);
    assert.equal(scheduled, 1);
    assert.equal(unrefCalled, 0, "injected schedule handles remain caller-owned");
    withInjected.dispose();

    // Default schedule path: capture the Immediate and prove it is unref'd so a
    // pending refresh alone cannot keep the process alive.
    const originalSetImmediate = globalThis.setImmediate;
    let captured: NodeJS.Immediate | undefined;
    globalThis.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      const handle = originalSetImmediate(callback, ...args);
      captured = handle;
      return handle;
    }) as typeof setImmediate;
    try {
      const runtime = createResourcePressureRuntime({
        immediateHeapUsedMb: () => 100,
        // Never resolve: we only care about the scheduled Immediate ref state.
        sample: () => new Promise(() => {}),
      });
      runtime.check();
      assert.ok(captured, "default schedule must use setImmediate");
      assert.equal(captured.hasRef(), false, "default Immediate must be unref'd");
      runtime.dispose();
      if (captured) clearImmediate(captured);
    } finally {
      globalThis.setImmediate = originalSetImmediate;
    }
  });

  it("dispose ignores late refresh results and independently owned runtimes do not share state", async () => {
    const pending = deferred<ResourceSignals>();
    let firstCalls = 0;
    const first = createResourcePressureRuntime({
      immediateHeapUsedMb: () => 100,
      sample: async () => {
        firstCalls += 1;
        return pending.promise;
      },
    });
    first.check();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(firstCalls, 1);
    first.dispose();
    pending.resolve(signals(1));
    await settleRefresh(first);
    assert.equal(
      first.getObservation().signals,
      null,
      "disposed runtime ignores late refresh results"
    );

    const second = createResourcePressureRuntime({
      immediateHeapUsedMb: () => 100,
      sample: async () => signals(2),
    });
    assert.notEqual(first, second);
    second.check();
    await settleRefresh(second);
    assert.equal(second.getObservation().signals?.observedAtMs, 2);
    second.dispose();
  });
});
