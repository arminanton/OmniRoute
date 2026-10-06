import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { acquireSharedSemaphore } from "../../open-sse/services/coordination/sharedSemaphore.ts";
import {
  backoffGenerationRetry,
  runGenerationDispatch,
} from "../../open-sse/services/logicalRetryBudget.ts";
import {
  clearAntigravityVersionCaches,
  resolveAntigravityCliVersion,
} from "../../open-sse/services/antigravityVersion.ts";

test("metadata singleflight never gives its owned generation permit to followers awaiting the same metadata", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-metadata-cycle-"));
  const old = { enabled: process.env.OMNI_SHARED_ADMISSION, db: process.env.OMNI_COORDINATION_DB };
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = path.join(dir, "coordination.sqlite");
  clearAntigravityVersionCaches();
  const abort = new AbortController();
  const releases: Array<() => void> = [];
  let ownerRelease: (() => void) | null = null;
  const acquire = () =>
    acquireSharedSemaphore(
      [{ key: "antigravity:synthetic", maxConcurrency: 32, adaptive: true, initialConcurrency: 4 }],
      { timeoutMs: 500, signal: abort.signal, onLeaseLost() {} }
    );
  let hookEntries = 0,
    metadataCalls = 0;
  try {
    ownerRelease = await acquire();
    for (let i = 0; i < 3; i++) releases.push(await acquire());
    const fifth = acquire().then((release) => {
      releases.push(release);
    });
    const fetch = async () => {
      metadataCalls++;
      await backoffGenerationRetry(10);
      return new Response('{"tag_name":"v1.2.16"}');
    };
    const owner = runGenerationDispatch(
      () => resolveAntigravityCliVersion(fetch as typeof globalThis.fetch),
      {
        withPermitReleased: async (wait) => {
          hookEntries++;
          ownerRelease?.();
          ownerRelease = null;
          await wait();
          ownerRelease = await acquire();
        },
      }
    );
    const followers = Array.from({ length: 3 }, () =>
      resolveAntigravityCliVersion(fetch as typeof globalThis.fetch)
    );
    await Promise.all([owner, ...followers]);
    assert.equal(
      hookEntries,
      0,
      "controlmetadata retry must not release/reacquire admitted generation ownership"
    );
    assert.equal(metadataCalls, 1);
    ownerRelease?.();
    ownerRelease = null;
    for (const release of releases.splice(0)) release();
    await fifth;
    const sql = new DatabaseSync(process.env.OMNI_COORDINATION_DB!, { readOnly: true });
    try {
      assert.ok(
        Number(sql.prepare("SELECT COUNT(*) AS n FROM coordination_resources").get()?.n) <= 1
      );
    } finally {
      sql.close();
    }
  } finally {
    abort.abort(new Error("fixturecleanup"));
    ownerRelease?.();
    for (const release of releases) release();
    globalThis.__omniSharedCoordinator?.close();
    globalThis.__omniSharedCoordinator = null;
    if (old.enabled === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = old.enabled;
    if (old.db === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = old.db;
    clearAntigravityVersionCaches();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("production fingerprint is immediately usable and failed metadata is negativecached across request waves", async () => {
  clearAntigravityVersionCaches();
  const originalFetch = globalThis.fetch;
  const now = Date.now;
  let settle!: (value: Response) => void;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Promise<Response>((resolve) => {
      settle = resolve;
    });
  }) as typeof fetch;
  try {
    const first = await resolveAntigravityCliVersion();
    assert.equal(first, "1.2.16");
    assert.equal(calls, 1);
    settle(new Response("{}"));
    await resolveAntigravityCliVersion(globalThis.fetch);
    await Promise.all(Array.from({ length: 100 }, () => resolveAntigravityCliVersion()));
    assert.equal(calls, 1, "failedreleasefeed must not retry on everyadmitted request");
    const baseline = Date.now();
    Date.now = () => baseline + 60001;
    const next = resolveAntigravityCliVersion();
    assert.equal(await next, "1.2.16");
    assert.equal(calls, 2);
    settle(new Response('{"tag_name":"v1.2.17"}'));
    await resolveAntigravityCliVersion(globalThis.fetch);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = now;
    clearAntigravityVersionCaches();
  }
});

test("control dispatch cannot borrow request retry budget but generation retries retain release/reacquire", async () => {
  const {
    runControlPlaneDispatch,
    runWithLogicalRetryBudget,
    LogicalRetryBudget,
    getLogicalRetryBudget,
    isGenerationHttpDispatch,
  } = await import("../../open-sse/services/logicalRetryBudget.ts");
  const budget = new LogicalRetryBudget(2, Date.now() + 10000);
  const events: string[] = [];
  await runWithLogicalRetryBudget(budget, () =>
    runGenerationDispatch(
      async () => {
        await runControlPlaneDispatch(async () => {
          assert.equal(getLogicalRetryBudget(), undefined);
          assert.equal(
            isGenerationHttpDispatch("https://fixture/v1/responses", { method: "POST" }),
            false
          );
          await backoffGenerationRetry(1);
        });
        assert.equal(getLogicalRetryBudget(), budget);
        assert.equal(
          isGenerationHttpDispatch("https://fixture/v1/responses", { method: "POST" }),
          true
        );
        await backoffGenerationRetry(1);
      },
      {
        withPermitReleased: async (wait) => {
          events.push("release");
          await wait();
          events.push("reacquire");
        },
      }
    )
  );
  assert.deepEqual(events, ["release", "reacquire"]);
});

test("control scope retains independently bound egress context", async () => {
  const {
    runWithDirectFetchContext,
    runWithProxyContext,
    hasAmbientProxyContext,
    resolveProxyForRequest,
  } = await import("../../open-sse/utils/proxyFetch.ts");
  const { runControlPlaneDispatch } = await import("../../open-sse/services/logicalRetryBudget.ts");
  await runWithProxyContext(
    "http://127.0.0.1:9919",
    () =>
      runControlPlaneDispatch(async () => {
        await Promise.resolve();
        assert.equal(hasAmbientProxyContext(), true);
        assert.equal(resolveProxyForRequest("https://synthetic.invalid").source, "context");
        assert.throws(() => runWithDirectFetchContext(() => {}));
      }),
    { skipUnreachableProbe: true, requireProxy: true }
  );
});
