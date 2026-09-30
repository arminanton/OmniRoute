/** Offline regression tests: all tokens, signing constants, stores and HTTP are synthetic. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  ensureFreshMaxaiCredential,
  maxaiRefreshAccessToken,
  maxaiRefreshGeneration,
  MAXAI_REFRESH_ERRORS,
  MAXAI_REFRESH_TIMEOUT_MS,
  MAXAI_REFRESH_FAILURE_COOLDOWN_MS,
  MAXAI_REFRESH_MAX_ENTRIES,
  MaxaiRefreshError,
  __resetMaxaiRefreshStateForTest,
  __maxaiRefreshStateSizeForTest,
  __setMaxaiRefreshOwnerForTest,
  type MaxaiRefreshStore,
  type MaxaiRefreshLease,
  type MaxaiRefreshAcquireInput,
  type MaxaiRefreshCommitInput,
  type MaxaiStoredCredential,
} from "../../open-sse/executors/maxai/refresh.ts";
import {
  accessTokenExpiry,
  resolveMaxaiCredential,
  type MaxaiCredential,
} from "../../open-sse/executors/maxai/credentials.ts";
import { __setMaxaiConstantsForTest } from "../../open-sse/executors/maxai/constantsStore.ts";
import { MOCK_CONSTANTS } from "./helpers/maxaiMockConstants.ts";
import { createMaxaiTransport } from "../../open-sse/services/maxaiTransport.ts";

const CONNECTION = "synthetic-maxai-connection";
const SECRET = "SYNTHETIC_SECRET_DO_NOT_REFLECT";

function jwt(exp: number, generation = "old"): string {
  return `synthetic.${Buffer.from(JSON.stringify({ exp, sub: "test-user", generation })).toString("base64url")}.signature`;
}

function credential(generation = "old", ttlSeconds = 20): MaxaiCredential {
  return {
    accessToken: jwt(Math.floor(Date.now() / 1000) + ttlSeconds, generation),
    refreshToken: jwt(Math.floor(Date.now() / 1000) + 864000, `refresh-${generation}`),
    deviceId: "test-device",
    userId: "test-user",
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function observeRefreshOwner() {
  const owner = { active: 0, acquired: 0, released: 0 };
  __setMaxaiRefreshOwnerForTest(async <T>(operation: () => Promise<T>): Promise<T> => {
    owner.active++;
    owner.acquired++;
    try {
      return await operation();
    } finally {
      owner.active--;
      owner.released++;
    }
  });
  return owner;
}

/** Models the durable contract. The separate DB suite tests real transaction/CAS behavior. */
class MemoryStore implements MaxaiRefreshStore {
  rows = new Map<string, MaxaiCredential>();
  revisions = new Map<string, number>();
  leases = new Map<string, MaxaiRefreshAcquireInput & { sent: boolean; original: string }>();
  commits = 0;
  sends = 0;
  acquisitions: MaxaiRefreshAcquireInput[] = [];

  constructor(initial: MaxaiCredential = credential()) {
    this.rows.set(CONNECTION, { ...initial });
  }

  read(connectionId: string): MaxaiStoredCredential | null {
    const row = this.rows.get(connectionId);
    return row ? { ...row, credentialVersion: this.version(connectionId) } : null;
  }

  private version(connectionId: string): string {
    return createHash("sha256")
      .update(JSON.stringify([this.revisions.get(connectionId) ?? 0, this.rows.get(connectionId)]))
      .digest("hex");
  }

  acquire(input: MaxaiRefreshAcquireInput) {
    this.acquisitions.push({ ...input });
    const row = this.rows.get(input.connectionId);
    if (!row) return "missing" as const;
    if (this.version(input.connectionId) !== input.expectedCredentialVersion)
      return "stale" as const;
    if (maxaiRefreshGeneration(row.refreshToken ?? "") !== input.generation)
      return "stale" as const;
    const previous = this.leases.get(input.connectionId);
    if (previous && previous.generation === input.generation) {
      if (previous.leaseExpiresAt > Date.now()) return "busy" as const;
      if (previous.sent) return "quarantined" as const;
    }
    this.leases.set(input.connectionId, { ...input, sent: false, original: JSON.stringify(row) });
    return "acquired" as const;
  }

  markSent(input: MaxaiRefreshLease): boolean {
    const lease = this.liveLease(input);
    if (!lease || lease.sent) return false;
    lease.sent = true;
    this.sends++;
    return true;
  }

  commit(input: MaxaiRefreshCommitInput): boolean {
    const lease = this.liveLease(input);
    const row = this.rows.get(input.connectionId);
    if (
      !lease?.sent ||
      JSON.stringify(row) !== lease.original ||
      this.version(input.connectionId) !== lease.expectedCredentialVersion
    )
      return false;
    this.rows.set(input.connectionId, { ...input.credential });
    this.revisions.set(input.connectionId, (this.revisions.get(input.connectionId) ?? 0) + 1);
    this.leases.delete(input.connectionId);
    this.commits++;
    return true;
  }

  release(input: MaxaiRefreshLease): void {
    const lease = this.leases.get(input.connectionId);
    if (lease?.owner === input.owner && lease.generation === input.generation && !lease.sent) {
      this.leases.delete(input.connectionId);
    }
  }

  private liveLease(input: MaxaiRefreshLease) {
    const lease = this.leases.get(input.connectionId);
    if (
      lease?.owner !== input.owner ||
      lease.generation !== input.generation ||
      lease.leaseExpiresAt <= Date.now()
    )
      return null;
    return lease;
  }
}

function fetcher(send: (init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return async (url, init) => {
    if (String(url).endsWith("/oauth/refresh_access_token")) return send(init ?? {});
    // Force extraction to use the seeded synthetic memo, never a real DB/bundle.
    return new Response("", { status: 404 });
  };
}

function refreshed(
  accessToken = credential("fresh", 86400).accessToken,
  refreshToken?: string
): Response {
  return Response.json({ data: { access_token: accessToken, refresh_token: refreshToken } });
}

function rejectsWith(code: keyof typeof MAXAI_REFRESH_ERRORS) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof MaxaiRefreshError);
    assert.equal(error.message, MAXAI_REFRESH_ERRORS[code]);
    assert.equal(error.code, code);
    assert.ok(!JSON.stringify(error).includes(SECRET));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test.beforeEach(() => {
  __resetMaxaiRefreshStateForTest();
  __setMaxaiConstantsForTest(MOCK_CONSTANTS);
});

test.afterEach(() => {
  __resetMaxaiRefreshStateForTest();
  __setMaxaiRefreshOwnerForTest(null);
});

test("canonical top-level access/refresh tokens take priority over legacy PSD", () => {
  const old = credential();
  const fresh = credential("new", 86400);
  const result = resolveMaxaiCredential(
    {
      maxaiAccessToken: old.accessToken,
      maxaiRefreshToken: old.refreshToken,
      maxaiDeviceId: old.deviceId,
      maxaiUserId: old.userId,
    },
    fresh.accessToken,
    fresh.refreshToken
  );
  assert.equal(result?.accessToken, fresh.accessToken);
  assert.equal(result?.refreshToken, fresh.refreshToken);
  assert.equal(
    resolveMaxaiCredential({
      maxaiAccessToken: old.accessToken,
      maxaiRefreshToken: old.refreshToken,
      maxaiDeviceId: old.deviceId,
    })?.refreshToken,
    old.refreshToken
  );
  assert.equal(accessTokenExpiry(jwt(-1)), 0);
});

test("requires a connection ID even for a fresh credential and rejects pre-aborted callers", async () => {
  const value = credential("fresh", 86400);
  const store = new MemoryStore(value);
  await assert.rejects(
    ensureFreshMaxaiCredential({ connectionId: " ", credential: value, store }),
    rejectsWith("connection")
  );
  const controller = new AbortController();
  controller.abort(new Error(SECRET));
  await assert.rejects(
    ensureFreshMaxaiCredential({
      connectionId: CONNECTION,
      credential: value,
      store,
      signal: controller.signal,
    }),
    rejectsWith("aborted")
  );
  assert.equal(store.acquisitions.length, 0);
});

test("never falls through with an expired or malformed access token without refresh", async () => {
  for (const accessToken of [jwt(1), "not-a-jwt"]) {
    const value = { ...credential(), accessToken, refreshToken: undefined };
    await assert.rejects(
      ensureFreshMaxaiCredential({
        connectionId: CONNECTION,
        credential: value,
        store: new MemoryStore(value),
      }),
      rejectsWith("expired")
    );
  }
});

test("wire request pins URL/body/headers and rejects redirects; parses rotated snake/camel tokens", async () => {
  for (const camel of [false, true]) {
    const value = credential();
    const next = credential("next", 86400);
    const result = await maxaiRefreshAccessToken({
      ...value,
      refreshToken: value.refreshToken!,
      fetchImpl: fetcher((init) => {
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.equal(init.body, JSON.stringify({ app: "maxai_webapp" }));
        const headers = new Headers(init.headers);
        assert.equal(headers.get("authorization"), `Bearer ${value.refreshToken}`);
        assert.equal(headers.get("noauthlogout"), "true");
        assert.ok(headers.get("x-authorization"));
        return Response.json(
          camel
            ? { accessToken: next.accessToken, refreshToken: next.refreshToken }
            : { data: { access_token: next.accessToken, refresh_token: next.refreshToken } }
        );
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.accessToken, next.accessToken);
    assert.equal(result.refreshToken, next.refreshToken);
    assert.equal(result.expiresAt, accessTokenExpiry(next.accessToken));
  }
});

test("wire errors are exact fixed text, never response bodies or transport exceptions", async () => {
  const value = credential();
  for (const status of [401, 418, 500]) {
    const result = await maxaiRefreshAccessToken({
      ...value,
      refreshToken: value.refreshToken!,
      fetchImpl: fetcher(() => new Response(SECRET, { status })),
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.equal(result.error, MAXAI_REFRESH_ERRORS.failed);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
  const failed = await maxaiRefreshAccessToken({
    ...value,
    refreshToken: value.refreshToken!,
    fetchImpl: fetcher(() => {
      throw new Error(`https://user:${SECRET}@proxy.invalid`);
    }),
  });
  assert.equal(failed.error, MAXAI_REFRESH_ERRORS.failed);
  const redirected = await maxaiRefreshAccessToken({
    ...value,
    refreshToken: value.refreshToken!,
    fetchImpl: fetcher(
      () => new Response(SECRET, { status: 302, headers: { Location: "https://unsafe.invalid" } })
    ),
  });
  assert.equal(redirected.error, MAXAI_REFRESH_ERRORS.redirect);
});

test("rejects malformed, missing, expired and control-character refresh responses", async () => {
  const value = credential();
  for (const body of [
    SECRET,
    "null",
    "{}",
    JSON.stringify({ access_token: jwt(1) }),
    JSON.stringify({
      access_token: credential("fresh", 86400).accessToken,
      refreshToken: "bad\r\ntoken",
    }),
  ]) {
    const result = await maxaiRefreshAccessToken({
      ...value,
      refreshToken: value.refreshToken!,
      fetchImpl: fetcher(() => new Response(body)),
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, MAXAI_REFRESH_ERRORS.response);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test("same connection/generation shares one POST and one durable commit", async () => {
  const value = credential();
  const next = credential("next", 86400);
  const store = new MemoryStore(value);
  const waiting = deferred<Response>();
  const started = deferred<void>();
  let posts = 0;
  const input = {
    connectionId: CONNECTION,
    credential: value,
    store,
    fetchImpl: fetcher(() => {
      posts++;
      started.resolve();
      return waiting.promise;
    }),
  };
  const callers = [
    ensureFreshMaxaiCredential(input),
    ensureFreshMaxaiCredential(input),
    ensureFreshMaxaiCredential(input),
  ];
  await started.promise;
  assert.equal(posts, 1);
  assert.equal(store.sends, 1);
  const lease = store.acquisitions[0];
  assert.equal(lease.generation, createHash("sha256").update(value.refreshToken!).digest("hex"));
  assert.ok(lease.leaseExpiresAt <= Date.now() + 30_000);
  waiting.resolve(refreshed(next.accessToken, next.refreshToken));
  for (const result of await Promise.all(callers)) assert.deepEqual(result, next);
  assert.equal(store.commits, 1);
  assert.equal(
    __maxaiRefreshStateSizeForTest(),
    0,
    "completed plaintext tokens must not remain in the coordinator"
  );
});

test("caller abort does not cancel another caller's shared rotation", async () => {
  const value = credential();
  const store = new MemoryStore(value);
  const waiting = deferred<Response>();
  const started = deferred<void>();
  const controller = new AbortController();
  let sharedSignal: AbortSignal | null | undefined;
  const input = {
    connectionId: CONNECTION,
    credential: value,
    store,
    fetchImpl: fetcher((init) => {
      sharedSignal = init.signal;
      started.resolve();
      return waiting.promise;
    }),
  };
  const first = ensureFreshMaxaiCredential({ ...input, signal: controller.signal });
  const second = ensureFreshMaxaiCredential(input);
  const rejection = assert.rejects(first, rejectsWith("aborted"));
  await started.promise;
  controller.abort(SECRET);
  await rejection;
  assert.equal(sharedSignal?.aborted, false);
  waiting.resolve(refreshed());
  assert.ok((await second).accessToken);
  assert.equal(store.commits, 1);
});

test("shared refresh owns transport through commit and readback after its first waiter aborts", async () => {
  const owner = observeRefreshOwner();
  const value = credential();
  const next = credential("owned-refresh", 86400);
  const store = new MemoryStore(value);
  const response = deferred<Response>();
  const sent = deferred<void>();
  const commitStarted = deferred<void>();
  const allowCommit = deferred<void>();
  const readbackStarted = deferred<void>();
  const allowReadback = deferred<void>();
  const controller = new AbortController();
  const heldStore: MaxaiRefreshStore = {
    read: async (connectionId) => {
      if (store.commits) {
        readbackStarted.resolve();
        await allowReadback.promise;
      }
      return store.read(connectionId);
    },
    acquire: store.acquire.bind(store),
    markSent: store.markSent.bind(store),
    commit: async (input) => {
      commitStarted.resolve();
      await allowCommit.promise;
      return store.commit(input);
    },
    release: store.release.bind(store),
  };
  const input = {
    connectionId: CONNECTION,
    credential: value,
    store: heldStore,
    fetchImpl: fetcher(() => {
      sent.resolve();
      return response.promise;
    }),
  };
  const first = ensureFreshMaxaiCredential({ ...input, signal: controller.signal });
  const second = ensureFreshMaxaiCredential(input);
  const rejected = assert.rejects(first, rejectsWith("aborted"));
  let secondSettled = false;
  void second.then(
    () => {
      secondSettled = true;
    },
    () => {
      secondSettled = true;
    }
  );
  try {
    await sent.promise;
    assert.deepEqual(owner, { active: 1, acquired: 1, released: 0 });
    controller.abort(SECRET);
    await rejected;
    assert.equal(owner.active, 1, "the cancelled waiter must not release shared ownership");
    response.resolve(refreshed(next.accessToken, next.refreshToken));
    await commitStarted.promise;
    assert.equal(owner.active, 1, "ownership must include durable commit, not only the POST");
    assert.equal(store.commits, 0);
    allowCommit.resolve();
    await readbackStarted.promise;
    assert.equal(store.commits, 1);
    assert.equal(secondSettled, false);
    assert.equal(owner.active, 1, "the shared authoritative readback still owns the transport");
    allowReadback.resolve();
    assert.deepEqual(await second, next);
    assert.deepEqual(owner, { active: 0, acquired: 1, released: 1 });
    assert.equal(store.sends, 1);
  } finally {
    controller.abort();
    response.resolve(refreshed(next.accessToken, next.refreshToken));
    allowCommit.resolve();
    allowReadback.resolve();
    await Promise.allSettled([rejected, second]);
  }
});

test("local transport renewal follows the shared commit, not its cancelled originating scope", async () => {
  let bootMs = 1_000;
  let timerId = 0;
  let verifications = 0;
  let resolutions = 0;
  let sends = 0;
  let posts = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const response = deferred<Response>();
  const sent = deferred<void>();
  const committing = deferred<void>();
  const allowCommit = deferred<void>();
  const afterClose = deferred<void>();
  let closedRejection: Promise<void> | undefined;
  const transport = createMaxaiTransport({
    bootNow: () => bootMs,
    resolve: async () => {
      resolutions++;
      return { proxyConfig: null, blocked: false };
    },
    profileSupported: () => true,
    verify: async (route) => {
      verifications++;
      return {
        ...route,
        kind: "namespace",
        bootId: "synthetic-boot",
        namespaceId: "synthetic-namespace",
        generation: "synthetic-proof-generation",
        expiresBootMs: bootMs + 10_000,
        expiresAt: Date.now() + 10_000,
      };
    },
    tlsFetch: async (url, _options, beforeDispatch) => {
      beforeDispatch();
      sends++;
      if (!url.endsWith("/oauth/refresh_access_token")) return new Response("", { status: 404 });
      posts++;
      sent.resolve();
      return response.promise;
    },
    setTimer: (run, delayMs) => {
      const id = ++timerId;
      timers.set(id, { at: bootMs + delayMs, run });
      return () => {
        timers.delete(id);
      };
    },
  });
  async function advanceBoot(ms: number) {
    const target = bootMs + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      bootMs = next[1].at;
      timers.delete(next[0]);
      next[1].run();
      await settle();
    }
    bootMs = target;
  }
  __setMaxaiRefreshOwnerForTest(transport.withOwner);
  const value = credential();
  const next = credential("owned-transport", 86400);
  const store = new MemoryStore(value);
  const heldStore: MaxaiRefreshStore = {
    read: store.read.bind(store),
    acquire: store.acquire.bind(store),
    markSent: store.markSent.bind(store),
    commit: async (input) => {
      committing.resolve();
      await allowCommit.promise;
      return store.commit(input);
    },
    release: store.release.bind(store),
  };
  const controller = new AbortController();
  const input = {
    connectionId: CONNECTION,
    credential: value,
    store: heldStore,
    fetchImpl: transport.fetch,
  };
  const first = transport.run(CONNECTION, () => {
    // Register inside the originating ALS scope. A late descendant must not
    // revive that scope after its last real operation has completed.
    closedRejection = assert.rejects(
      afterClose.promise.then(() => transport.fetch("https://www.maxai.co/app/"))
    );
    return ensureFreshMaxaiCredential({ ...input, signal: controller.signal });
  });
  const rejected = assert.rejects(first, rejectsWith("aborted"));
  let second: Promise<MaxaiCredential> | undefined;
  try {
    await sent.promise;
    second = ensureFreshMaxaiCredential(input);
    controller.abort(SECRET);
    await rejected;
    response.resolve(refreshed(next.accessToken, next.refreshToken));
    await committing.promise;
    // The original run and native header wait have both ended. Only the shared
    // refresh owns this scope while the authoritative commit is still pending.
    const beforeRenewal = verifications;
    await advanceBoot(20_000);
    assert.ok(verifications > beforeRenewal, "local proof reads continue for the shared commit");
    assert.equal(posts, 1, "renewal must never create provider requests");
    assert.equal(sends, 2, "only the synthetic bundle and refresh POST are sent");
    assert.equal(resolutions, 1, "a surviving waiter must not grant a second scope");
    assert.equal(store.acquisitions.length, 1);
    assert.equal(store.commits, 0);
    allowCommit.resolve();
    assert.deepEqual(await second, next);
    assert.equal(store.commits, 1);
    assert.equal(timers.size, 0, "settled shared work must stop local renewal");
    const afterCommit = verifications;
    await advanceBoot(20_000);
    assert.equal(verifications, afterCommit);
    afterClose.resolve();
    await closedRejection;
    assert.equal(verifications, afterCommit, "a closed descendant cannot even re-verify");
    assert.equal(timers.size, 0);
    assert.equal(sends, 2);
    assert.equal(posts, 1);
  } finally {
    controller.abort();
    response.resolve(refreshed(next.accessToken, next.refreshToken));
    allowCommit.resolve();
    await Promise.allSettled([rejected, ...(second ? [second] : [])]);
    afterClose.resolve();
    await closedRejection;
  }
});

test("shared timeout releases transport ownership despite ignored fetch; late bodies cannot commit", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const owner = observeRefreshOwner();
  const value = credential();
  const store = new MemoryStore(value);
  const response = deferred<Response>();
  const sent = deferred<void>();
  const controller = new AbortController();
  let sharedSignal: AbortSignal | null | undefined;
  let posts = 0;
  const input = {
    connectionId: CONNECTION,
    credential: value,
    store,
    fetchImpl: fetcher((init) => {
      posts++;
      sharedSignal = init.signal;
      sent.resolve();
      return response.promise;
    }),
  };
  const first = ensureFreshMaxaiCredential({ ...input, signal: controller.signal });
  const second = ensureFreshMaxaiCredential(input);
  const firstRejected = assert.rejects(first, rejectsWith("aborted"));
  const secondRejected = assert.rejects(second, rejectsWith("timeout"));
  try {
    await sent.promise;
    controller.abort(SECRET);
    await firstRejected;
    assert.equal(owner.active, 1);
    t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
    await secondRejected;
    assert.equal(sharedSignal?.aborted, true);
    assert.deepEqual(owner, { active: 0, acquired: 1, released: 1 });
    let cancelled = 0;
    response.resolve(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        })
      )
    );
    await settle();
    assert.equal(cancelled, 1);
    assert.equal(store.commits, 0);
    assert.equal(
      store.leases.get(CONNECTION)?.sent,
      true,
      "uncertain generation stays quarantined"
    );
    assert.equal(posts, 1);
    assert.deepEqual(owner, { active: 0, acquired: 1, released: 1 });
  } finally {
    controller.abort();
    t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
    response.resolve(refreshed());
    await Promise.allSettled([firstRejected, secondRejected]);
    await settle();
  }
});

test("shared timeout ends ownership before an ignored acquire settles and cleans its unsent lease", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const owner = observeRefreshOwner();
  const value = credential();
  const store = new MemoryStore(value);
  const acquiring = deferred<void>();
  const allowAcquire = deferred<void>();
  let releases = 0;
  let posts = 0;
  const heldStore: MaxaiRefreshStore = {
    read: store.read.bind(store),
    acquire: async (input) => {
      acquiring.resolve();
      await allowAcquire.promise;
      return store.acquire(input);
    },
    markSent: store.markSent.bind(store),
    commit: store.commit.bind(store),
    release: (input) => {
      releases++;
      store.release(input);
    },
  };
  const pending = ensureFreshMaxaiCredential({
    connectionId: CONNECTION,
    credential: value,
    store: heldStore,
    fetchImpl: fetcher(() => {
      posts++;
      return refreshed();
    }),
  });
  const rejected = assert.rejects(pending, rejectsWith("timeout"));
  try {
    await acquiring.promise;
    assert.equal(owner.active, 1);
    t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
    await rejected;
    assert.deepEqual(owner, { active: 0, acquired: 1, released: 1 });
    assert.equal(releases, 0, "the ignored task has not settled yet");
    allowAcquire.resolve();
    await settle();
    assert.equal(releases, 1);
    assert.equal(store.leases.size, 0);
    assert.equal(store.sends, 0);
    assert.equal(posts, 0);
    assert.equal(store.commits, 0);
    assert.deepEqual(owner, { active: 0, acquired: 1, released: 1 });
  } finally {
    t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
    allowAcquire.resolve();
    await rejected;
    await settle();
  }
});

test("shared timeout releases ownership while a late commit must still satisfy the durable lease", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const owner = observeRefreshOwner();
  const value = credential();
  const store = new MemoryStore(value);
  const committing = deferred<void>();
  const allowCommit = deferred<void>();
  const heldStore: MaxaiRefreshStore = {
    read: store.read.bind(store),
    acquire: store.acquire.bind(store),
    markSent: store.markSent.bind(store),
    commit: async (input) => {
      committing.resolve();
      await allowCommit.promise;
      return store.commit(input);
    },
    release: store.release.bind(store),
  };
  const pending = ensureFreshMaxaiCredential({
    connectionId: CONNECTION,
    credential: value,
    store: heldStore,
    fetchImpl: fetcher(() => refreshed()),
  });
  const rejected = assert.rejects(pending, rejectsWith("timeout"));
  try {
    await committing.promise;
    assert.equal(owner.active, 1);
    t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
    await rejected;
    assert.deepEqual(owner, { active: 0, acquired: 1, released: 1 });
    allowCommit.resolve();
    await settle();
    assert.equal(store.commits, 0);
    assert.deepEqual(store.rows.get(CONNECTION), value);
    assert.equal(store.leases.get(CONNECTION)?.sent, true);
    assert.deepEqual(owner, { active: 0, acquired: 1, released: 1 });
  } finally {
    t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
    allowCommit.resolve();
    await rejected;
    await settle();
  }
});

test("shared deadline rejects ignored abort at 30s and quarantines the sent generation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const value = credential();
  const store = new MemoryStore(value);
  const waiting = deferred<Response>();
  const started = deferred<void>();
  let posts = 0;
  let sharedSignal: AbortSignal | null | undefined;
  const input = {
    connectionId: CONNECTION,
    credential: value,
    store,
    fetchImpl: fetcher((init) => {
      posts++;
      sharedSignal = init.signal;
      started.resolve();
      return waiting.promise;
    }),
  };
  const pending = ensureFreshMaxaiCredential(input);
  const rejected = assert.rejects(pending, rejectsWith("timeout"));
  await started.promise;
  t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
  await rejected;
  assert.equal(sharedSignal?.aborted, true);
  await assert.rejects(ensureFreshMaxaiCredential(input), rejectsWith("cooldown"));
  t.mock.timers.tick(MAXAI_REFRESH_FAILURE_COOLDOWN_MS + 1);
  await assert.rejects(ensureFreshMaxaiCredential(input), rejectsWith("quarantined"));
  waiting.resolve(refreshed());
  await settle();
  assert.equal(store.commits, 0, "late completion must not persist");
  assert.equal(posts, 1, "an uncertain sent generation must never be reposted");
});

test("wire has its own timeout even if fetch ignores abort", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const value = credential();
  const started = deferred<void>();
  const pending = maxaiRefreshAccessToken({
    ...value,
    refreshToken: value.refreshToken!,
    fetchImpl: fetcher(() => {
      started.resolve();
      return new Promise<Response>(() => {});
    }),
  });
  await started.promise;
  t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
  const result = await pending;
  assert.equal(result.error, MAXAI_REFRESH_ERRORS.timeout);
});

test("deadline also covers ignored body reads and cannot commit their late result", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const value = credential();
  const store = new MemoryStore(value);
  const body = deferred<string>();
  const started = deferred<void>();
  const pending = ensureFreshMaxaiCredential({
    connectionId: CONNECTION,
    credential: value,
    store,
    fetchImpl: fetcher(() => {
      const response = new Response();
      response.text = () => {
        started.resolve();
        return body.promise;
      };
      return response;
    }),
  });
  const rejected = assert.rejects(pending, rejectsWith("timeout"));
  await started.promise;
  t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
  await rejected;
  body.resolve(JSON.stringify({ accessToken: credential("fresh", 86400).accessToken }));
  await settle();
  assert.equal(store.commits, 0);
});

test("a new refresh generation bypasses old failure cooldown", async () => {
  const old = credential();
  const next = credential("manual-login");
  const store = new MemoryStore(old);
  const input = {
    connectionId: CONNECTION,
    credential: old,
    store,
    fetchImpl: fetcher(() => new Response(SECRET, { status: 401 })),
  };
  await assert.rejects(ensureFreshMaxaiCredential(input), rejectsWith("failed"));
  await assert.rejects(ensureFreshMaxaiCredential(input), rejectsWith("cooldown"));
  store.rows.set(CONNECTION, next);
  const fresh = credential("fresh", 86400);
  const result = await ensureFreshMaxaiCredential({
    ...input,
    credential: next,
    fetchImpl: fetcher(() => refreshed(fresh.accessToken, fresh.refreshToken)),
  });
  assert.deepEqual(result, fresh);
});

test("different connections never share a refresh even with identical tokens", async () => {
  const value = credential();
  const store = new MemoryStore(value);
  store.rows.set("connection-b", { ...value });
  let posts = 0;
  const input = {
    credential: value,
    store,
    fetchImpl: fetcher(() => {
      posts++;
      return refreshed();
    }),
  };
  await Promise.all([
    ensureFreshMaxaiCredential({ ...input, connectionId: CONNECTION }),
    ensureFreshMaxaiCredential({ ...input, connectionId: "connection-b" }),
  ]);
  assert.equal(posts, 2);
  assert.equal(store.commits, 2);
});

test("reads a newer stored generation instead of replaying the stale snapshot", async () => {
  const old = credential();
  const winner = credential("manual-login", 86400);
  const store = new MemoryStore(winner);
  let posts = 0;
  const result = await ensureFreshMaxaiCredential({
    connectionId: CONNECTION,
    credential: old,
    store,
    fetchImpl: fetcher(() => {
      posts++;
      return refreshed();
    }),
  });
  assert.deepEqual(result, winner);
  assert.equal(posts, 0);
});

test("stale CAS cannot overwrite a newer login or return the losing token", async () => {
  const old = credential();
  const winner = credential("manual-login", 86400);
  const store = new MemoryStore(old);
  const pending = ensureFreshMaxaiCredential({
    connectionId: CONNECTION,
    credential: old,
    store,
    fetchImpl: fetcher(() => {
      store.rows.set(CONNECTION, winner);
      return refreshed();
    }),
  });
  await assert.rejects(pending, rejectsWith("conflict"));
  assert.deepEqual(store.rows.get(CONNECTION), winner);
  assert.equal(store.commits, 0);
});

test("false markSent prevents dispatch and false commit is not treated as success", async () => {
  const old = credential();
  for (const method of ["markSent", "commit"] as const) {
    __resetMaxaiRefreshStateForTest();
    const store = new MemoryStore(old);
    store[method] = () => false;
    let posts = 0;
    await assert.rejects(
      ensureFreshMaxaiCredential({
        connectionId: CONNECTION,
        credential: old,
        store,
        fetchImpl: fetcher(() => {
          posts++;
          return refreshed();
        }),
      }),
      rejectsWith("conflict")
    );
    assert.equal(posts, method === "markSent" ? 0 : 1);
    assert.equal(store.commits, 0);
  }
});

test("optional callback false or throw is a fixed failure, not silent success", async () => {
  const old = credential();
  for (const callback of [
    () => false,
    () => {
      throw new Error(SECRET);
    },
  ]) {
    __resetMaxaiRefreshStateForTest();
    const store = new MemoryStore(old);
    await assert.rejects(
      ensureFreshMaxaiCredential({
        connectionId: CONNECTION,
        credential: old,
        store,
        fetchImpl: fetcher(() => refreshed()),
        onCredentialsRefreshed: callback,
      }),
      rejectsWith("persistence")
    );
    assert.equal(store.commits, 1, "callback is not a replacement for durable CAS");
  }
});

test("storage failures redact details and never dispatch a refresh", async () => {
  const old = credential();
  const store = new MemoryStore(old);
  store.read = () => {
    throw new Error(SECRET);
  };
  let posts = 0;
  await assert.rejects(
    ensureFreshMaxaiCredential({
      connectionId: CONNECTION,
      credential: old,
      store,
      fetchImpl: fetcher(() => {
        posts++;
        return refreshed();
      }),
    }),
    rejectsWith("storage")
  );
  assert.equal(posts, 0);
});

test("a foreign live lease blocks dispatch and is not released by this worker", async () => {
  const old = credential();
  const store = new MemoryStore(old);
  const other = {
    connectionId: CONNECTION,
    generation: maxaiRefreshGeneration(old.refreshToken!),
    owner: "other-worker",
    leaseExpiresAt: Date.now() + 30_000,
    expectedCredentialVersion: store.read(CONNECTION)!.credentialVersion,
  };
  assert.equal(store.acquire(other), "acquired");
  let posts = 0;
  await assert.rejects(
    ensureFreshMaxaiCredential({
      connectionId: CONNECTION,
      credential: old,
      store,
      fetchImpl: fetcher(() => {
        posts++;
        return refreshed();
      }),
    }),
    rejectsWith("busy")
  );
  assert.equal(posts, 0);
  assert.equal(store.leases.get(CONNECTION)?.owner, "other-worker");
});

test("process failure state is bounded at 256 generations and prunes after TTL", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const old = credential();
  const store = new MemoryStore(old);
  store.read = () => {
    throw new Error(SECRET);
  };
  const input = { credential: old, store, fetchImpl: fetcher(() => refreshed()) };
  for (let i = 0; i < MAXAI_REFRESH_MAX_ENTRIES; i++) {
    await assert.rejects(
      ensureFreshMaxaiCredential({ ...input, connectionId: `connection-${i}` }),
      rejectsWith("storage")
    );
  }
  assert.equal(MAXAI_REFRESH_MAX_ENTRIES, 256);
  assert.equal(__maxaiRefreshStateSizeForTest(), 256);
  await assert.rejects(
    ensureFreshMaxaiCredential({ ...input, connectionId: "overflow" }),
    rejectsWith("capacity")
  );
  t.mock.timers.tick(MAXAI_REFRESH_FAILURE_COOLDOWN_MS + 1);
  await assert.rejects(
    ensureFreshMaxaiCredential({ ...input, connectionId: "after-expiry" }),
    rejectsWith("storage")
  );
  assert.equal(__maxaiRefreshStateSizeForTest(), 1);
});

test("all callers cancelled before work starts cause zero store leases or HTTP requests", async () => {
  const value = credential();
  const store = new MemoryStore(value);
  const controller = new AbortController();
  let posts = 0;
  const pending = ensureFreshMaxaiCredential({
    connectionId: CONNECTION,
    credential: value,
    store,
    signal: controller.signal,
    fetchImpl: fetcher(() => {
      posts++;
      return refreshed();
    }),
  });
  const rejected = assert.rejects(pending, rejectsWith("aborted"));
  controller.abort(SECRET);
  await rejected;
  await settle();
  assert.equal(posts, 0);
  assert.equal(store.acquisitions.length, 0);
  assert.equal(__maxaiRefreshStateSizeForTest(), 0);
});

test("a refresh response without a replacement refresh token preserves the settled generation", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const value = credential();
  const store = new MemoryStore(value);
  let posts = 0;
  const input = {
    connectionId: CONNECTION,
    credential: value,
    store,
    fetchImpl: fetcher(() => {
      posts++;
      return refreshed();
    }),
  };
  const first = await ensureFreshMaxaiCredential(input);
  assert.equal(first.refreshToken, value.refreshToken);
  assert.equal(store.commits, 1);
  t.mock.timers.tick(86400 * 1000);
  const second = await ensureFreshMaxaiCredential({ ...input, credential: first });
  assert.equal(second.refreshToken, value.refreshToken);
  assert.equal(store.commits, 2);
  assert.equal(posts, 2);
});

test("stale callers reread a manual edit even after this process successfully refreshed", async () => {
  const old = credential();
  const store = new MemoryStore(old);
  let posts = 0;
  const input = {
    connectionId: CONNECTION,
    credential: old,
    store,
    fetchImpl: fetcher(() => {
      posts++;
      return refreshed();
    }),
  };
  await ensureFreshMaxaiCredential(input);
  const winner = credential("manual-login", 86400);
  store.rows.set(CONNECTION, winner);
  assert.deepEqual(await ensureFreshMaxaiCredential(input), winner);
  assert.equal(posts, 1);
});

test("pre-send lease failure releases only the unsent lease and retries after cooldown", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const value = credential();
  const store = new MemoryStore(value);
  const markSent = store.markSent.bind(store);
  store.markSent = () => false;
  let posts = 0;
  const input = {
    connectionId: CONNECTION,
    credential: value,
    store,
    fetchImpl: fetcher(() => {
      posts++;
      return refreshed();
    }),
  };
  await assert.rejects(ensureFreshMaxaiCredential(input), rejectsWith("conflict"));
  assert.equal(store.leases.size, 0);
  assert.equal(posts, 0);
  store.markSent = markSent;
  t.mock.timers.tick(MAXAI_REFRESH_FAILURE_COOLDOWN_MS + 1);
  await ensureFreshMaxaiCredential(input);
  assert.equal(posts, 1);
});

test("a hung public signing-bundle request times out before the durable sent marker", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const value = credential();
  const store = new MemoryStore(value);
  const started = deferred<void>();
  const bundle = deferred<Response>();
  let posts = 0;
  const pending = ensureFreshMaxaiCredential({
    connectionId: CONNECTION,
    credential: value,
    store,
    fetchImpl: async (url) => {
      if (String(url).endsWith("/oauth/refresh_access_token")) {
        posts++;
        return refreshed();
      }
      started.resolve();
      return bundle.promise;
    },
  });
  const rejected = assert.rejects(pending, rejectsWith("timeout"));
  await started.promise;
  t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
  await rejected;
  bundle.resolve(new Response("", { status: 404 }));
  await settle();
  assert.equal(posts, 0);
  assert.equal(store.sends, 0);
  assert.equal(store.leases.size, 0);
});

test("ignored storage reads are bounded and their late completion cannot acquire a lease", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const value = credential();
  const store = new MemoryStore(value);
  const reading = deferred<MaxaiStoredCredential | null>();
  const started = deferred<void>();
  const blocked: MaxaiRefreshStore = {
    read: () => {
      started.resolve();
      return reading.promise;
    },
    acquire: store.acquire.bind(store),
    markSent: store.markSent.bind(store),
    commit: store.commit.bind(store),
    release: store.release.bind(store),
  };
  const pending = ensureFreshMaxaiCredential({
    connectionId: CONNECTION,
    credential: value,
    store: blocked,
    fetchImpl: fetcher(() => refreshed()),
  });
  const rejected = assert.rejects(pending, rejectsWith("timeout"));
  await started.promise;
  t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
  await rejected;
  reading.resolve(store.read(CONNECTION));
  await settle();
  assert.equal(store.acquisitions.length, 0);
  assert.equal(store.commits, 0);
});

test("256 active operations cannot be evicted to permit an unbounded pending map", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const value = credential();
  const store = new MemoryStore(value);
  const blocked: MaxaiRefreshStore = {
    read: () => new Promise(() => {}),
    acquire: store.acquire.bind(store),
    markSent: store.markSent.bind(store),
    commit: store.commit.bind(store),
    release: store.release.bind(store),
  };
  const input = { credential: value, store: blocked, fetchImpl: fetcher(() => refreshed()) };
  const pending = Array.from({ length: 256 }, (_, i) =>
    ensureFreshMaxaiCredential({ ...input, connectionId: `active-${i}` })
  );
  const results = Promise.allSettled(pending);
  await assert.rejects(
    ensureFreshMaxaiCredential({ ...input, connectionId: "overflow" }),
    rejectsWith("capacity")
  );
  assert.equal(__maxaiRefreshStateSizeForTest(), 256);
  t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
  for (const result of await results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") rejectsWith("timeout")(result.reason);
  }
  assert.equal(store.sends, 0);
});

test("an ignored fetch completing after timeout has its late response body cancelled", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const value = credential();
  const started = deferred<void>();
  const waiting = deferred<Response>();
  const pending = maxaiRefreshAccessToken({
    ...value,
    refreshToken: value.refreshToken!,
    fetchImpl: fetcher(() => {
      started.resolve();
      return waiting.promise;
    }),
  });
  await started.promise;
  t.mock.timers.tick(MAXAI_REFRESH_TIMEOUT_MS);
  assert.equal((await pending).error, MAXAI_REFRESH_ERRORS.timeout);
  let cancelled = 0;
  waiting.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
        },
      })
    )
  );
  await settle();
  assert.equal(cancelled, 1);
});

test("refresh auth and quota failures retain account-level status without reflecting content", async () => {
  const value = credential();
  for (const [upstreamStatus, expectedStatus] of [
    [401, 401],
    [418, 401],
    [403, 403],
    [429, 429],
  ]) {
    __resetMaxaiRefreshStateForTest();
    const store = new MemoryStore(value);
    await assert.rejects(
      ensureFreshMaxaiCredential({
        connectionId: CONNECTION,
        credential: value,
        store,
        fetchImpl: fetcher(() => new Response(SECRET, { status: upstreamStatus })),
      }),
      (error: unknown) => {
        rejectsWith("failed")(error);
        assert.equal((error as MaxaiRefreshError).status, expectedStatus);
        return true;
      }
    );
  }
});

test("explicit malformed rotation fields reject instead of silently retaining the old refresh token", async () => {
  const value = credential();
  const accessToken = credential("fresh", 86400).accessToken;
  for (const rotated of [null, "", 0, false, {}, []]) {
    for (const field of ["refresh_token", "refreshToken"]) {
      const result = await maxaiRefreshAccessToken({
        ...value,
        refreshToken: value.refreshToken!,
        fetchImpl: fetcher(() => Response.json({ data: { accessToken, [field]: rotated } })),
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, MAXAI_REFRESH_ERRORS.response);
    }
  }
});

test("an old read cannot acquire again after another worker commits identical plaintext tokens", async () => {
  const value = credential();
  const store = new MemoryStore(value);
  const original = store.read(CONNECTION)!;
  const acquire = store.acquire.bind(store);
  let swapped = false;
  store.acquire = (input) => {
    assert.equal(input.expectedCredentialVersion, original.credentialVersion);
    if (!swapped) {
      swapped = true;
      const other = { ...input, owner: "another-worker" };
      assert.equal(acquire(other), "acquired");
      assert.equal(store.markSent(other), true);
      assert.equal(store.commit({ ...other, credential: value }), true);
      assert.notEqual(store.read(CONNECTION)!.credentialVersion, original.credentialVersion);
    }
    return acquire(input);
  };
  let posts = 0;
  await assert.rejects(
    ensureFreshMaxaiCredential({
      connectionId: CONNECTION,
      credential: value,
      store,
      fetchImpl: fetcher(() => {
        posts++;
        return refreshed();
      }),
    }),
    rejectsWith("conflict")
  );
  assert.equal(posts, 0);
  assert.equal(store.commits, 1);
});

test("store read without an opaque version is refused before dispatch", async () => {
  const value = credential();
  const store = new MemoryStore(value);
  store.read = () => value as MaxaiStoredCredential;
  let posts = 0;
  await assert.rejects(
    ensureFreshMaxaiCredential({
      connectionId: CONNECTION,
      credential: value,
      store,
      fetchImpl: fetcher(() => {
        posts++;
        return refreshed();
      }),
    }),
    rejectsWith("invalid")
  );
  assert.equal(posts, 0);
  assert.equal(store.acquisitions.length, 0);
});
