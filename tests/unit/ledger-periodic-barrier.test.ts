import assert from "node:assert/strict";
import { test } from "node:test";
import {
  periodicServicesAllowed,
  confirmPeriodicStartupBarrier,
  getPeriodicBarrierEvidence,
  installPeriodicOwnershipAuthority,
} from "../../src/lib/periodicServices.ts";

test("generation role actually suppresses boot and lazy scheduler registrations", async () => {
  const prior = process.env.OMNI_COORDINATION_PROCESS_ROLE;
  process.env.OMNI_COORDINATION_PROCESS_ROLE = "generation";
  try {
    assert.equal(periodicServicesAllowed("boot"), false);
    assert.equal(getPeriodicBarrierEvidence().confirmed, false);
    const quota = await import("../../src/domain/quotaCache.ts");
    const warmup = await import("../../src/lib/warmupScheduler.ts");
    const health = await import("../../src/lib/tokenHealthCheck.ts");
    const credential = await import("../../src/lib/credentialHealth/scheduler.ts");
    let scheduled = 0;
    const original = setInterval;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      scheduled++;
      return original(...args);
    }) as typeof setInterval;
    try {
      quota.startBackgroundRefresh();
      assert.equal(warmup.startWarmupScheduler(), null);
      health.initTokenHealthCheck();
      assert.equal(credential.initCredentialHealthCheck(), false);
      assert.equal(scheduled, 0);
    } finally {
      globalThis.setInterval = original;
    }
    confirmPeriodicStartupBarrier();
    const record = getPeriodicBarrierEvidence();
    assert.equal(record.confirmed, true);
    assert.ok(record.suppressed.includes("credential-health"));
  } finally {
    if (prior === undefined) delete process.env.OMNI_COORDINATION_PROCESS_ROLE;
    else process.env.OMNI_COORDINATION_PROCESS_ROLE = prior;
  }
});

test("maintenance role requires live owner assertion and loses permission after fencing", () => {
  const oldRole = process.env.OMNI_COORDINATION_PROCESS_ROLE,
    oldShared = process.env.OMNI_SHARED_ADMISSION;
  process.env.OMNI_COORDINATION_PROCESS_ROLE = "maintenance";
  process.env.OMNI_SHARED_ADMISSION = "true";
  try {
    assert.equal(periodicServicesAllowed("periodic"), false);
    let lost = false;
    installPeriodicOwnershipAuthority(() => {
      if (lost) throw new Error("fenced");
    });
    assert.equal(periodicServicesAllowed("periodic"), true);
    lost = true;
    assert.equal(periodicServicesAllowed("periodic"), false);
  } finally {
    if (oldRole === undefined) delete process.env.OMNI_COORDINATION_PROCESS_ROLE;
    else process.env.OMNI_COORDINATION_PROCESS_ROLE = oldRole;
    if (oldShared === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = oldShared;
  }
});

test("manual job execution stays available when periodic registration is suppressed", async () => {
  const old = process.env.OMNI_COORDINATION_PROCESS_ROLE;
  process.env.OMNI_COORDINATION_PROCESS_ROLE = "generation";
  const { JobRegistry } = await import("../../src/lib/jobRegistry/registry.ts");
  const registry = new JobRegistry();
  let calls = 0;
  try {
    registry.register({
      id: "ledger-manual-test",
      type: "interval",
      cron: null,
      intervalMs: 1000,
      enabled: true,
      envFlag: null,
      config: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      handler: async () => {
        calls++;
        return { success: true };
      },
    });
    registry.start("ledger-manual-test");
    assert.equal(calls, 0);
    assert.equal((await registry.runNow("ledger-manual-test")).started, true);
    assert.equal(calls, 1);
  } finally {
    registry.dispose();
    if (old === undefined) delete process.env.OMNI_COORDINATION_PROCESS_ROLE;
    else process.env.OMNI_COORDINATION_PROCESS_ROLE = old;
  }
});
