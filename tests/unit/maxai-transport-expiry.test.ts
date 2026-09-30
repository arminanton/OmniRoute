import test from "node:test";
import assert from "node:assert/strict";
import {
  createMaxaiTransport,
  type MaxaiEgressAttestation,
} from "../../open-sse/services/maxaiTransport.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  let now = 1_000;
  let expiry = 11_000;
  let generation = "gen";
  let verifications = 0,
    sends = 0;
  let barrier: Promise<void> | undefined;
  const transport = createMaxaiTransport({
    bootNow: () => now,
    resolve: async () => ({ proxyConfig: null, blocked: false }),
    verify: async (route) => {
      verifications++;
      if (barrier) await barrier;
      return {
        ...route,
        kind: "namespace",
        bootId: "boot",
        namespaceId: "ns",
        generation,
        expiresAt: Date.now() + 10_000,
        expiresBootMs: expiry,
      } as MaxaiEgressAttestation;
    },
    profileSupported: () => true,
    tlsFetch: async () => {
      sends++;
      return new Response("ok");
    },
  });
  return {
    transport,
    get sends() {
      return sends;
    },
    get verifications() {
      return verifications;
    },
    setNow(value: number) {
      now = value;
    },
    setExpiry(value: number) {
      expiry = value;
    },
    setGeneration(value: string) {
      generation = value;
    },
    setBarrier(value: Promise<void> | undefined) {
      barrier = value;
    },
  };
}
const url = "https://www.maxai.co/app/";

test("late same-generation renewal cannot revive expired scope even on wall rollback", async () => {
  const f = fixture();
  const wall = Date.now;
  try {
    await f.transport.run("conn", async () => {
      f.setNow(11_000);
      f.setExpiry(21_000);
      Date.now = () => 1;
      await assert.rejects(f.transport.fetch(url));
      assert.equal(f.verifications, 1);
      f.setNow(10_000);
      await assert.rejects(f.transport.fetch(url));
    });
  } finally {
    Date.now = wall;
  }
  assert.equal(f.sends, 0);
});

test("simulated system suspend uses boottime, not wall or process elapsed clock", async () => {
  const f = fixture();
  await f.transport.run("conn", async () => {
    f.setNow(61_000);
    f.setExpiry(71_000);
    await assert.rejects(f.transport.fetch(url));
  });
  assert.equal(f.sends, 0);
});

test("verifier delayed across accepted deadline invalidates scope irreversibly", async () => {
  const f = fixture();
  const gate = deferred<void>();
  await f.transport.run("conn", async () => {
    f.setBarrier(gate.promise);
    f.setExpiry(21_000);
    const pending = f.transport.fetch(url);
    await Promise.resolve();
    f.setNow(11_000);
    gate.resolve();
    await assert.rejects(pending);
    f.setNow(11_100);
    f.setExpiry(21_100);
    f.setBarrier(undefined);
    await assert.rejects(f.transport.fetch(url));
  });
  assert.equal(f.sends, 0);
});

test("same identity renewal accepted before expiry extends only a live scope", async () => {
  const f = fixture();
  await f.transport.run("conn", async () => {
    f.setNow(9_000);
    f.setExpiry(19_000);
    await f.transport.fetch(url);
    f.setNow(12_000);
    f.setExpiry(22_000);
    await f.transport.fetch(url);
  });
  assert.equal(f.sends, 2);
  await assert.rejects(f.transport.fetch(url));
});

test("invalid identity latches scope even if later verifier restores original generation", async () => {
  const f = fixture();
  await f.transport.run("conn", async () => {
    f.setGeneration("changed");
    await assert.rejects(f.transport.fetch(url));
    f.setGeneration("gen");
    await assert.rejects(f.transport.fetch(url));
  });
  assert.equal(f.sends, 0);
});

test("concurrent delayed verifiers cannot resurrect an expired scope", async () => {
  const f = fixture();
  const gate = deferred<void>();
  await f.transport.run("conn", async () => {
    f.setBarrier(gate.promise);
    f.setExpiry(21_000);
    const a = f.transport.fetch(url),
      b = f.transport.fetch(url);
    await Promise.resolve();
    f.setNow(11_000);
    gate.resolve();
    await assert.rejects(a);
    await assert.rejects(b);
  });
  assert.equal(f.sends, 0);
});

test("expiry while native session creation waits prevents actual request invocation", async () => {
  const { createMaxaiTlsClient } = await import("../../open-sse/services/maxaiTransport.ts");
  const started = deferred<void>(),
    ready = deferred<void>();
  let now = 1_000,
    nativeSends = 0;
  let guard: () => void = () => {
    throw new Error("missing boundary guard");
  };
  const client = createMaxaiTlsClient(
    async () => {
      started.resolve();
      await ready.promise;
      return {
        fetch: async () => {
          nativeSends++;
          return new Response("unsafe");
        },
        close: async () => {},
        getCookies: () => ({}),
      };
    },
    () => guard()
  );
  const transport = createMaxaiTransport({
    bootNow: () => now,
    resolve: async () => ({ proxyConfig: null, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => ({
      ...route,
      kind: "namespace",
      bootId: "boot",
      namespaceId: "ns",
      generation: "gen",
      expiresAt: Date.now() + 10_000,
      expiresBootMs: 11_000,
    }),
    tlsFetch: (url, options, beforeDispatch) => {
      guard = beforeDispatch;
      return client.fetch(url, options);
    },
  });
  try {
    const pending = transport.run("conn", () => transport.fetch(url));
    await started.promise;
    now = 11_000;
    ready.resolve();
    await assert.rejects(pending);
    assert.equal(nativeSends, 0);
  } finally {
    await client.closeAll();
  }
});

test("native adapter refuses calls without a scope-bound dispatch guard", async () => {
  const { createMaxaiTlsClient } = await import("../../open-sse/services/maxaiTransport.ts");
  let nativeSends = 0;
  const client = createMaxaiTlsClient(async () => ({
    fetch: async () => {
      nativeSends++;
      return new Response("unsafe");
    },
    close: async () => {},
    getCookies: () => ({}),
  }));
  try {
    await assert.rejects(
      client.fetch(url, { proxy: null, sessionScope: "conn", redirect: "error" })
    );
  } finally {
    await client.closeAll();
  }
  assert.equal(nativeSends, 0);
});

test("already-authorized long upload/header response survives lapse but cannot authorize another send", async () => {
  let now = 1_000,
    cancelled = false,
    sends = 0;
  const transport = createMaxaiTransport({
    bootNow: () => now,
    resolve: async () => ({ proxyConfig: null, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => ({
      ...route,
      kind: "namespace",
      bootId: "boot",
      namespaceId: "ns",
      generation: "gen",
      expiresAt: Date.now() + 10_000,
      expiresBootMs: now + 10_000,
    }),
    tlsFetch: async () => {
      sends++;
      now = 12_000;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        })
      );
    },
  });
  await transport.run("conn", async () => {
    const response = await transport.fetch(url);
    assert.equal(response.status, 200);
    assert.equal(cancelled, false);
    await assert.rejects(transport.fetch(url));
    await response.body?.cancel();
  });
  assert.equal(sends, 1);
  assert.equal(cancelled, true);
});

test("concurrent requests share one bounded verifier and cannot overlap renewal", async () => {
  let now = 1_000,
    verifyCount = 0,
    sends = 0;
  const slow = deferred<MaxaiEgressAttestation>();
  const entered = deferred<void>();
  let delayedProof!: MaxaiEgressAttestation;
  const transport = createMaxaiTransport({
    bootNow: () => now,
    resolve: async () => ({ proxyConfig: null, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => {
      verifyCount++;
      const proof = {
        ...route,
        kind: "namespace" as const,
        bootId: "boot",
        namespaceId: "ns",
        generation: "gen",
        expiresAt: Date.now() + 10_000,
        expiresBootMs: now + 10_000,
      };
      if (verifyCount === 2) {
        delayedProof = proof;
        entered.resolve();
        return slow.promise;
      }
      return proof;
    },
    tlsFetch: async () => {
      sends++;
      return new Response("ok");
    },
  });
  await transport.run("conn", async () => {
    now = 8_000;
    const first = transport.fetch(url),
      second = transport.fetch(url);
    await entered.promise;
    assert.equal(verifyCount, 2);
    slow.resolve(delayedProof);
    await Promise.all([first, second]);
    now = 16_000;
    await transport.fetch(url);
  });
  assert.equal(sends, 3);
  assert.equal(verifyCount, 3);
});

test("invalid clock latches scope and wall rollback cannot authorize or cancel valid boot permission", async () => {
  const f = fixture();
  const wall = Date.now;
  try {
    await f.transport.run("conn", async () => {
      Date.now = () => 1;
      await f.transport.fetch(url);
      f.setNow(Number.NaN);
      await assert.rejects(f.transport.fetch(url));
      f.setNow(2_000);
      await assert.rejects(f.transport.fetch(url));
    });
  } finally {
    Date.now = wall;
  }
  assert.equal(f.sends, 1);
});

test("scope exit closes permission and detached descendant work cannot renew it", async () => {
  const f = fixture();
  const done = deferred<void>();
  let descendant!: Promise<void>;
  await f.transport.run("conn", async () => {
    descendant = (async () => {
      await done.promise;
      await assert.rejects(f.transport.fetch(url));
    })();
  });
  f.setNow(11_000);
  f.setExpiry(21_000);
  done.resolve();
  await descendant;
  assert.equal(f.verifications, 1);
  assert.equal(f.sends, 0);
});

test("trusted boot-clock parser uses conservative printed precision and refuses malformed values", async () => {
  const { maxaiBootTimeUpperBound } = await import("../../src/lib/maxaiEgressAttestation.ts");
  assert.equal(maxaiBootTimeUpperBound("100.25 10.00\n"), 100_260);
  assert.equal(maxaiBootTimeUpperBound("100.2 10.00\n"), 100_300);
  assert.equal(maxaiBootTimeUpperBound("100.250000001 10.00\n"), 100_251);
  for (const invalid of ["NaN 0", "-1.00 0.00", "100 10", "9999999999999.99 10.00\n"])
    assert.throws(() => maxaiBootTimeUpperBound(invalid));
});

function bootScheduler() {
  let now = 1_000,
    nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const flush = async () => {
    for (let n = 0; n < 16; n++) await Promise.resolve();
  };
  return {
    now: () => now,
    setNow(value: number) {
      now = value;
    },
    get pending() {
      return timers.size;
    },
    setTimer(callback: () => void, delay: number) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return () => {
        timers.delete(id);
      };
    },
    async elapse(ms: number) {
      const target = now + ms;
      for (let n = 0; n < 100; n++) {
        const due = [...timers]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          now = target;
          await flush();
          return;
        }
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      throw new Error("unbounded fixture timer loop");
    },
    flush,
  };
}
function renewalFixture() {
  const clock = bootScheduler();
  let verifications = 0,
    sends = 0,
    generation = "gen";
  let verifierBarrier: Promise<void> | undefined;
  let requestBarrier: Promise<void> | undefined;
  let verifierError = false;
  let cancellations = 0;
  let onVerify: (() => void) | undefined, onSend: (() => void) | undefined;
  const transport = createMaxaiTransport({
    bootNow: clock.now,
    setTimer: clock.setTimer,
    resolve: async () => ({ proxyConfig: null, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => {
      verifications++;
      onVerify?.();
      if (verifierBarrier) await verifierBarrier;
      if (verifierError) throw new Error("fixture verifier failure");
      return {
        ...route,
        kind: "namespace",
        bootId: "boot",
        namespaceId: "ns",
        generation,
        expiresAt: Date.now() + 15_000,
        expiresBootMs: clock.now() + 15_000,
      };
    },
    tlsFetch: async () => {
      sends++;
      onSend?.();
      if (requestBarrier) await requestBarrier;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          },
          cancel() {
            cancellations++;
          },
        })
      );
    },
  });
  return {
    transport,
    clock,
    get verifications() {
      return verifications;
    },
    get sends() {
      return sends;
    },
    get cancellations() {
      return cancellations;
    },
    setVerifierBarrier(value: Promise<void> | undefined) {
      verifierBarrier = value;
    },
    setRequestBarrier(value: Promise<void> | undefined) {
      requestBarrier = value;
    },
    setVerifierError() {
      verifierError = true;
    },
    setGeneration(value: string) {
      generation = value;
    },
    onVerify(value: () => void) {
      onVerify = value;
    },
    onSend(value: () => void) {
      onSend = value;
    },
  };
}

test("healthy local renewal permits >15s header/upload wait followed by next signed send", async () => {
  const f = renewalFixture(),
    headers = deferred<void>(),
    sent = deferred<void>();
  f.setRequestBarrier(headers.promise);
  f.onSend(() => sent.resolve());
  const operation = f.transport.run("conn", async () => {
    const first = await f.transport.fetch(url);
    assert.equal(await first.text(), "ok");
    f.setRequestBarrier(undefined);
    const second = await f.transport.fetch("https://api.maxai.me/gpt/cwc/chat", {
      method: "POST",
      body: "{}",
    });
    assert.equal(await second.text(), "ok");
  });
  await sent.promise;
  await f.clock.elapse(25_000);
  assert.equal(f.sends, 1);
  assert.ok(f.verifications >= 6);
  headers.resolve();
  await operation;
  await f.clock.flush();
  assert.equal(f.sends, 2);
  assert.equal(f.clock.pending, 0);
});

test("event-loop/suspend gap does not discard accepted response or replay; next send fails", async () => {
  const f = renewalFixture(),
    headers = deferred<void>(),
    sent = deferred<void>();
  f.setRequestBarrier(headers.promise);
  f.onSend(() => sent.resolve());
  const operation = f.transport.run("conn", async () => {
    const response = await f.transport.fetch(url);
    assert.equal(await response.text(), "ok");
    await assert.rejects(f.transport.fetch(url));
  });
  await sent.promise;
  f.clock.setNow(31_000); // No callbacks ran while process was suspended.
  headers.resolve();
  await operation;
  await f.clock.flush();
  assert.equal(f.sends, 1);
  assert.equal(f.clock.pending, 0);
});

test("changed generation during owned request stops renewal without discarding accepted response", async () => {
  const f = renewalFixture(),
    headers = deferred<void>(),
    sent = deferred<void>();
  f.setRequestBarrier(headers.promise);
  f.onSend(() => sent.resolve());
  const operation = f.transport.run("conn", async () => {
    assert.equal(await (await f.transport.fetch(url)).text(), "ok");
    await assert.rejects(f.transport.fetch(url));
  });
  await sent.promise;
  f.setGeneration("changed");
  await f.clock.elapse(5_000);
  assert.equal(f.clock.pending, 0);
  headers.resolve();
  await operation;
  assert.equal(f.sends, 1);
});

test("scope exit cancels pending local renewal and fences late completion", async () => {
  const f = renewalFixture(),
    body = deferred<void>(),
    started = deferred<void>(),
    verify = deferred<void>();
  let descendant!: () => Promise<Response>;
  const operation = f.transport.run("conn", async () => {
    descendant = () => f.transport.fetch(url); // Called outside context must not gain a scope.
    f.setVerifierBarrier(verify.promise);
    f.onVerify(() => started.resolve());
    await body.promise;
  });
  await f.clock.flush();
  await f.clock.elapse(5_000);
  await started.promise;
  assert.equal(f.clock.pending, 1);
  body.resolve();
  await operation;
  await f.clock.flush();
  assert.equal(f.clock.pending, 0);
  verify.resolve();
  await f.clock.flush();
  assert.equal(f.clock.pending, 0);
  await assert.rejects(descendant());
  assert.equal(f.sends, 0);
});

test("stuck local renewal times out, stops its timer and cannot revive on late completion", async () => {
  const f = renewalFixture(),
    body = deferred<void>(),
    verify = deferred<void>();
  const operation = f.transport.run("conn", async () => {
    f.setVerifierBarrier(verify.promise);
    await body.promise;
    await assert.rejects(f.transport.fetch(url));
  });
  await f.clock.flush();
  await f.clock.elapse(6_000);
  assert.equal(f.clock.pending, 0);
  verify.resolve();
  await f.clock.flush();
  assert.equal(f.clock.pending, 0);
  body.resolve();
  await operation;
  assert.equal(f.sends, 0);
});

test("local verifier rejection is handled, stops renewal, and keeps expired scope terminal", async () => {
  const f = renewalFixture(),
    body = deferred<void>();
  const operation = f.transport.run("conn", async () => {
    f.setVerifierError();
    await body.promise;
    await assert.rejects(f.transport.fetch(url));
  });
  await f.clock.flush();
  await f.clock.elapse(5_000);
  assert.equal(f.clock.pending, 0);
  body.resolve();
  await operation;
  assert.equal(f.sends, 0);
});

test("explicit shared operation owner outlives outer waiter then closes with actual work", async () => {
  const f = renewalFixture(),
    work = deferred<void>();
  let owned!: Promise<void>, descendant!: Promise<void>;
  const late = deferred<void>();
  await f.transport.run("conn", async () => {
    owned = f.transport.withOwner(async () => {
      await work.promise;
      assert.equal(await (await f.transport.fetch(url)).text(), "ok");
      descendant = (async () => {
        await late.promise;
        await assert.rejects(f.transport.fetch(url));
      })();
    });
  });
  await f.clock.elapse(25_000);
  assert.ok(f.verifications >= 6);
  assert.equal(f.sends, 0);
  work.resolve();
  await owned;
  await f.clock.flush();
  assert.equal(f.clock.pending, 0);
  late.resolve();
  await descendant;
  assert.equal(f.sends, 1);
});

test("ordinary scope completion leaves no scheduled or unhandled renewal task", async () => {
  const f = renewalFixture();
  await f.transport.run("conn", async () => {
    await f.transport.fetch(url);
  });
  await f.clock.flush();
  assert.equal(f.clock.pending, 0);
  const checks = f.verifications;
  await f.clock.elapse(60_000);
  assert.equal(f.verifications, checks);
});

test("aborted native waiter closes monitor even if native ignores signal; late body is cancelled", async () => {
  const f = renewalFixture(),
    entered = deferred<void>(),
    native = deferred<void>();
  const controller = new AbortController();
  let result = "pending";
  f.setRequestBarrier(native.promise);
  f.onSend(() => entered.resolve());
  const operation = f.transport
    .run("conn", () => f.transport.fetch(url, { signal: controller.signal }))
    .then(
      () => {
        result = "returned";
      },
      () => {
        result = "aborted";
      }
    );
  await entered.promise;
  controller.abort();
  await f.clock.flush();
  const pendingTimers = f.clock.pending;
  const atAbort = result;
  // Always release fixture I/O even if the assertion demonstrates the old bug.
  native.resolve();
  await operation;
  await f.clock.flush();
  assert.equal(atAbort, "aborted");
  assert.equal(pendingTimers, 0);
  assert.equal(f.sends, 1);
  assert.equal(f.clock.pending, 0);
  assert.equal(f.cancellations, 1);
});

test("cached native sessions use each current request guard and preserve native method binding", async () => {
  const { createMaxaiTlsClient, createMaxaiTlsDispatcher } =
    await import("../../open-sse/services/maxaiTransport.ts");
  let now = 1_000,
    created = 0,
    nativeSends = 0,
    closed = 0;
  const client = createMaxaiTlsClient(async () => {
    created++;
    const session = {
      async fetch() {
        assert.equal(this, session);
        nativeSends++;
        return new Response("ok");
      },
      async close() {
        assert.equal(this, session);
        closed++;
      },
      getCookies() {
        assert.equal(this, session);
        return {};
      },
    };
    return session;
  });
  const transport = createMaxaiTransport({
    bootNow: () => now,
    resolve: async () => ({ proxyConfig: null, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => ({
      ...route,
      kind: "namespace",
      bootId: "boot",
      namespaceId: "ns",
      generation: "gen",
      expiresAt: Date.now() + 10_000,
      expiresBootMs: now + 10_000,
    }),
    tlsFetch: createMaxaiTlsDispatcher(client),
  });
  try {
    await transport.run("conn", async () => {
      assert.equal(await (await transport.fetch(url)).text(), "ok");
    });
    now = 20_000; // The first scope is closed/expired; only this NEW scope may send.
    await transport.run("conn", async () => {
      assert.equal(await (await transport.fetch(url)).text(), "ok");
    });
    assert.equal(created, 1);
    assert.equal(nativeSends, 2);
  } finally {
    await client.closeAll();
  }
  assert.equal(closed, 1);
});

test("default native ALS guard rechecks expiry after awaited session creation", async () => {
  const { createMaxaiTlsClient, createMaxaiTlsDispatcher } =
    await import("../../open-sse/services/maxaiTransport.ts");
  let now = 1_000,
    nativeSends = 0;
  const created = deferred<void>(),
    sessionReady = deferred<void>();
  const client = createMaxaiTlsClient(async () => {
    created.resolve();
    await sessionReady.promise;
    return {
      fetch: async () => {
        nativeSends++;
        return new Response("unsafe");
      },
      close: () => {},
    };
  });
  const transport = createMaxaiTransport({
    bootNow: () => now,
    resolve: async () => ({ proxyConfig: null, blocked: false }),
    profileSupported: () => true,
    verify: async (route) => ({
      ...route,
      kind: "namespace",
      bootId: "boot",
      namespaceId: "ns",
      generation: "gen",
      expiresAt: Date.now() + 10_000,
      expiresBootMs: now + 10_000,
    }),
    tlsFetch: createMaxaiTlsDispatcher(client),
  });
  try {
    const request = transport.run("conn", () => transport.fetch(url));
    await created.promise;
    now = 11_000;
    sessionReady.resolve();
    await assert.rejects(request);
    assert.equal(nativeSends, 0);
  } finally {
    await client.closeAll();
  }
});
