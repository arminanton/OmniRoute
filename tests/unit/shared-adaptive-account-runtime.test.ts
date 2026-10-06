import test from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

class Worker {
  child: ChildProcess;
  waiting = new Map<string, (reply: { ok: boolean; error?: string }) => void>();
  constructor(file: string) {
    this.child = fork("tests/fixtures/shared-adaptive-account-worker.mts", [], {
      execArgv: ["--import", "tsx/esm"],
      env: { ...process.env, OMNI_SHARED_ADMISSION: "true", OMNI_COORDINATION_DB: file },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child.on("message", (reply: { id: string; ok: boolean; error?: string }) => {
      this.waiting.get(reply.id)?.(reply);
      this.waiting.delete(reply.id);
    });
  }
  ready() {
    return new Promise<void>((resolve) => this.waiting.set("ready", () => resolve()));
  }
  request(action: string, id: string, extra: Record<string, unknown> = {}) {
    return new Promise<{ ok: boolean; error?: string }>((resolve) => {
      this.waiting.set(id, resolve);
      this.child.send({ action, id, ...extra });
    });
  }
  async stop() {
    if (this.child.exitCode == null) {
      const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
      await this.request("stop", "stop");
      await exited;
    }
  }
}
function readState(file: string) {
  const db = new DatabaseSync(file);
  try {
    const row = db
      .prepare("SELECT state FROM coordination_adaptation WHERE resource='codex:synthetic-account'")
      .get();
    return row ? JSON.parse(String(row.state)) : null;
  } finally {
    db.close();
  }
}
async function fixture(run: (a: Worker, b: Worker, file: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "omni-shared-account-"));
  const file = join(dir, "c.sqlite"),
    a = new Worker(file),
    b = new Worker(file);
  try {
    await Promise.all([a.ready(), b.ready()]);
    await run(a, b, file);
  } finally {
    await Promise.all([a.stop(), b.stop()]);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("shared account default starts bounded across two real processes", async () => {
  await fixture(async (a, b, file) => {
    for (let i = 0; i < 4; i++)
      assert.equal((await (i % 2 ? a : b).request("acquire", String(i))).ok, true);
    assert.deepEqual(await a.request("acquire", "fifth", { timeoutMs: 150 }), {
      id: "fifth",
      ok: false,
      error: "SEMAPHORE_TIMEOUT",
    });
    assert.equal(readState(file).currentLimit, 4);
    assert.equal(readState(file).recoveryCeiling, 4);
  });
});
test("explicit unlimited and adaptive optout retain operator semantics", async () => {
  await fixture(async (a, b, file) => {
    for (let i = 0; i < 8; i++)
      assert.equal(
        (await (i % 2 ? a : b).request("acquire", String(i), { credentials: { maxConcurrent: 0 } }))
          .ok,
        true
      );
    assert.equal(readState(file), null);
  });
  await fixture(async (a, b, file) => {
    const credentials = {
      maxConcurrent: 2,
      providerSpecificData: { quotaAdaptiveAdmission: false },
    };
    assert.equal((await a.request("acquire", "a", { credentials })).ok, true);
    assert.equal((await b.request("acquire", "b", { credentials })).ok, true);
    assert.equal((await a.request("acquire", "c", { credentials, timeoutMs: 150 })).ok, false);
    assert.equal(readState(file), null);
  });
});
test("finite operator ceiling and independent declared quota realms are retained", async () => {
  await fixture(async (a, b, file) => {
    const credentials = { maxConcurrent: 1 };
    assert.equal((await a.request("acquire", "a", { credentials })).ok, true);
    assert.equal((await b.request("acquire", "b", { credentials, timeoutMs: 150 })).ok, false);
    const realm = {
      maxConcurrent: 1,
      providerSpecificData: { quotaGroup: "owned-group", quotaRealm: "distinct-project" },
    };
    assert.equal((await b.request("acquire", "realm", { credentials: realm })).ok, true);
    assert.equal(readState(file).currentLimit, 1);
  });
});
test(
  "verified429 feedback reduces actual next admission and measured successes recover",
  { timeout: 80000 },
  async () => {
    await fixture(async (a, b, file) => {
      const credentials = { maxConcurrent: 4 };
      for (let i = 0; i < 4; i++)
        assert.equal(
          (await (i % 2 ? a : b).request("acquire", String(i), { credentials })).ok,
          true
        );
      await a.request("feedback", "quota", {
        credentials,
        status: 429,
        text: "weekly usage quota exhausted",
      });
      assert.equal(readState(file).currentLimit, 4);
      await a.request("feedback", "overload", {
        credentials,
        status: 429,
        text: "Too many concurrent requests",
      });
      assert.equal(readState(file).currentLimit, 2);
      await b.request("release", "0");
      await a.request("release", "1");
      assert.equal(
        (await a.request("acquire", "blocked", { credentials, timeoutMs: 150 })).ok,
        false
      );
      // Keep both permits occupied while real heartbeats renew them. Close the critical window,
      // then a full healthy measured window; do not forge SQLite state or process clocks.
      await new Promise((resolve) => setTimeout(resolve, 30500));
      await a.request("feedback", "success1", { credentials, status: 200 });
      assert.equal(readState(file).currentLimit, 2);
      await new Promise((resolve) => setTimeout(resolve, 30500));
      await a.request("feedback", "success2", { credentials, status: 200 });
      assert.equal(readState(file).currentLimit, 3);
      assert.equal((await a.request("acquire", "recovered", { credentials })).ok, true);
      assert.equal(
        (await b.request("acquire", "stillbounded", { credentials, timeoutMs: 150 })).ok,
        false
      );
    });
  }
);
test("production Core supplies adaptive account requirements and feedback for the selected scope", () => {
  const source = readFileSync("open-sse/handlers/chatCore.ts", "utf8");
  assert.match(source, /accountAdmissionRequirement = resolveSharedAccountAdmissionRequirement/);
  assert.match(source, /accountAdmissionRequirement,\s*\]/);
  assert.match(source, /accountAdmissionRequirement\.adaptive === true/);
  const releaseBody = source.slice(
    source.indexOf("const releaseAccountSemaphore ="),
    source.indexOf("const generationAdmissionHooks =")
  );
  assert.ok(
    releaseBody.indexOf("observeAccountOutcome?.") < releaseBody.indexOf("currentPermitRelease?.()")
  );
  assert.match(
    source,
    /resolveSharedAccountAdmissionRequirement\([\s\S]*?resolveAccountSemaphoreMaxConcurrency\(credentials\)[\s\S]*?\)\.adaptive === true/
  );
});
