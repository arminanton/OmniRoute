import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("encrypted native grant rotation is shared across processes and does not copy fingerprints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-native-grant-"));
  const vars = {
    DATA_DIR: dir,
    OMNI_COORDINATION_DB: join(dir, "coordination.sqlite"),
    OMNI_SHARED_ADMISSION: "true",
    STORAGE_ENCRYPTION_KEY: "test-only-coordination-key-not-an-account-secret",
  };
  const prior = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  const { runCoordinatedGrantRefresh } =
    await import("../../open-sse/services/coordination/grantRefresh.ts");
  const { getDbInstance, resetDbInstance } = await import("../../src/lib/db/core.ts");
  try {
    let calls = 0;
    await runCoordinatedGrantRefresh("test-native", "old", async () => {
      calls++;
      return {
        accessToken: "test-bearer",
        refreshToken: "new",
        providerSpecificData: { fingerprint: "first-import" },
      };
    });
    const second = await runCoordinatedGrantRefresh("test-native", "old", async () => {
      calls++;
      throw new Error("unexpected replay");
    });
    assert.equal(calls, 1);
    assert.equal((second as Record<string, unknown>).providerSpecificData, undefined);
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "--input-type=module",
        "-e",
        `import {runCoordinatedGrantRefresh} from './open-sse/services/coordination/grantRefresh.ts'; const r=await runCoordinatedGrantRefresh('test-native','old',async()=>{throw new Error('replayed');}); if(r.accessToken!=='test-bearer')throw new Error('missing rotation');console.log('shared rotation verified');`,
      ],
      { encoding: "utf8", env: { ...process.env, ...vars } }
    );
    assert.equal(child.status, 0, child.stderr);
    assert.ok(child.stdout.includes("shared rotation verified"));
    const rows = getDbInstance()
      .prepare("SELECT value FROM key_value WHERE namespace=?")
      .all("coordinatedGrantRotations/v1") as Array<{ value: string }>;
    assert.equal(rows.length, 1);
    assert.ok(rows[0].value.startsWith("enc:v1:"));
    assert.ok(!rows[0].value.includes("test-bearer"));
  } finally {
    await resetDbInstance();
    for (const k of Object.keys(vars)) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
