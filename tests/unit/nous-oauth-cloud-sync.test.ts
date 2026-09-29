import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nous-oauth-cloud-sync-"));
process.env.DATA_DIR = dir;
process.env.API_KEY_SECRET ||= "nous-oauth-cloud-test-secret";
process.env.STORAGE_ENCRYPTION_KEY ||= "nous-oauth-cloud-test-encryption-key";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.CLOUD_URL = "https://cloud-sync.example.test";
process.env.OMNIROUTE_CLOUD_SYNC_SECRETS = "true";
process.env.OMNIROUTE_CLOUD_SYNC_SECRET = "nous-cloud-sync-test-signature";

const core = await import("../../src/lib/db/core.ts");
const db = await import("../../src/lib/db/providers.ts");
const bundle = await import("../../src/lib/sync/bundle.ts");
const cloud = await import("../../src/lib/cloudSync.ts");
const key = "nousInferenceBaseUrl";
const paid = "https://inference-api.nousresearch.com/v1";
const guest = "https://welcome-api.nousresearch.com/v1";
const realFetch = globalThis.fetch;

test.after(() => {
  globalThis.fetch = realFetch;
  core.resetDbInstance();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Nous OAuth is absent from outbound cloud bundle/version and inbound opt-in cannot alter it", async () => {
  assert.equal(cloud.CLOUD_SYNC_SECRETS_ENABLED, true, "exercise credential-sync opt-in");
  const conn = await db.createProviderConnection({
    provider: "nous-oauth", authType: "oauth", accessToken: "LOCAL-NOUS-ACCESS-FAKE",
    refreshToken: "LOCAL-NOUS-REFRESH-FAKE", testStatus: "active",
    providerSpecificData: { [key]: paid },
  });
  const first = await bundle.buildConfigSyncEnvelope();
  assert.equal(first.bundle.providerConnections.some((row) => row.id === conn.id), false);
  assert.equal(JSON.stringify(first).includes("LOCAL-NOUS-ACCESS-FAKE"), false);
  assert.equal(JSON.stringify(first).includes("LOCAL-NOUS-REFRESH-FAKE"), false);
  const forged = {
    ...first.bundle,
    providerConnections: [...first.bundle.providerConnections, {
      id: conn.id, provider: "nous-oauth", accessToken: "SENTINEL-OUTBOUND-TOKEN",
    }],
  };
  assert.equal(bundle.computeConfigSyncVersion(forged), first.version);
  assert.equal(bundle.toLegacyCloudSyncPayload(forged).providers.some((row) => row.id === conn.id), false);

  await db.updateProviderConnection(conn.id, {
    accessToken: "LOCAL-NOUS-ACCESS-ROTATED", refreshToken: "LOCAL-NOUS-REFRESH-ROTATED",
    providerSpecificData: { [key]: guest },
  });
  const second = await bundle.buildConfigSyncEnvelope();
  assert.equal(second.version, first.version, "local-only token/URL rotation must not change cloud version");
  const previous = await db.getProviderConnectionById(conn.id);
  let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++;
    assert.equal(String(url), "https://cloud-sync.example.test/sync/cloud-machine");
    const sent = JSON.parse(String(init?.body));
    assert.equal(sent.providers.some((row: { id: string }) => row.id === conn.id), false);
    assert.equal(sent.version, first.version);
    assert.equal(JSON.stringify(sent).includes("LOCAL-NOUS-REFRESH-ROTATED"), false);
    const raw = JSON.stringify({ data: { providers: { [conn.id]: {
      // Do not trust remote `provider`: local row identity is authoritative.
      provider: "not-nous-oauth", accessToken: "ATTACKER-ACCESS-FAKE",
      refreshToken: "ATTACKER-REFRESH-FAKE",
      providerSpecificData: { [key]: paid },
      status: "expired", lastError: "remote error", expiresAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2100-01-01T00:00:00.000Z",
    } } } });
    const sig = createHmac("sha256", process.env.OMNIROUTE_CLOUD_SYNC_SECRET!)
      .update(raw).digest("hex");
    return new Response(raw, { status: 200, headers: { "X-Cloud-Sig": sig } });
  }) as typeof fetch;
  const result = await cloud.syncToCloud("cloud-machine");
  assert.equal(result.success, true);
  assert.equal(calls, 1);
  const latest = await db.getProviderConnectionById(conn.id);
  assert.equal(latest?.accessToken, previous?.accessToken);
  assert.equal(latest?.refreshToken, previous?.refreshToken);
  assert.equal(latest?.testStatus, previous?.testStatus);
  assert.equal(latest?.expiresAt, previous?.expiresAt);
  assert.deepEqual(latest?.providerSpecificData, previous?.providerSpecificData);
});
