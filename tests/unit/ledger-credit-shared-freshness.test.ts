import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dataDir = mkdtempSync(join(tmpdir(), "omni-credit-shared-"));
process.env.DATA_DIR = dataDir;
const credits = await import("../../src/lib/db/creditBalance.ts");
const executor = await import("../../open-sse/executors/antigravity.ts");
const core = await import("../../src/lib/db/core.ts");
after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true });
});

function publishFromOtherProcess(account: string, balance: number, observedAt: number): void {
  execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'const credits = await import("./src/lib/db/creditBalance.ts"); const [account, balance, observedAt] = JSON.parse(process.env.OMNI_CREDIT_TEST_PAYLOAD); credits.persistCreditBalance(account, balance, observedAt); (await import("./src/lib/db/core.ts")).resetDbInstance();',
    ],
    {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        OMNI_CREDIT_TEST_PAYLOAD: JSON.stringify([account, balance, observedAt]),
      },
      timeout: 30_000,
    }
  );
}

test("older stream observations cannot shadow a newer shared balance", () => {
  const now = Date.now();
  publishFromOtherProcess("shared-first", 20, now);
  executor.updateAntigravityRemainingCredits("shared-first", 99, now - 1000);
  assert.equal(credits.getPersistedCreditBalance("shared-first"), 20);
  assert.equal(executor.getAntigravityRemainingCredits("shared-first"), 20);
});

test("an existing process observes a newer balance written by another generation", () => {
  const now = Date.now();
  executor.updateAntigravityRemainingCredits("local-first", 50, now - 1000);
  publishFromOtherProcess("local-first", 0, now);
  assert.equal(executor.getAntigravityRemainingCredits("local-first"), 0);
  executor.updateAntigravityRemainingCredits("local-first", 99, now - 500);
  assert.equal(executor.getAntigravityRemainingCredits("local-first"), 0);
});

test("late delivery does not renew the age of an expired credit observation", () => {
  executor.updateAntigravityRemainingCredits("expired-observation", 50, Date.now() - 301_000);
  assert.equal(executor.getAntigravityRemainingCredits("expired-observation"), null);
});
