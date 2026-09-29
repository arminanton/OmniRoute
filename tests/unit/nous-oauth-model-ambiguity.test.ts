// @ts-nocheck
/** Two persisted Nous credential types require explicit prefixes for shared bare IDs. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-nous-model-ambiguity-"));
process.env.DATA_DIR = dataDir;
process.env.API_KEY_SECRET = "unit-test-not-real";
const core = await import("../../src/lib/db/core.ts");
const db = await import("../../src/lib/db/providers.ts");
const { getModelInfoCore } = await import("../../open-sse/services/model.ts");
const { NOUS_OAUTH_INFERENCE_PSD_KEY } = await import("../../open-sse/config/nousOAuth.ts");

const id = "Hermes-4-70B";

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("shared bare Nous model rejects ONLY when both credential routes are active", async () => {
  const oauth = await db.createProviderConnection({
    provider: "nous-oauth",
    authType: "oauth",
    name: "OAuth inference account",
    accessToken: "oauth-unit-token",
    refreshToken: "oauth-unit-refresh",
    isActive: true,
    providerSpecificData: {
      [NOUS_OAUTH_INFERENCE_PSD_KEY]: "https://inference-api.nousresearch.com/v1",
    },
  });
  assert.equal((await getModelInfoCore(id, null)).provider, "nous-oauth");

  const key = await db.createProviderConnection({
    provider: "nous-research",
    authType: "apiKey",
    name: "API key account",
    apiKey: "sk-nous-unit-test",
    isActive: true,
  });
  const both = await getModelInfoCore(id, null);
  assert.equal(both.provider, null);
  assert.equal(both.errorType, "ambiguous_model");
  assert.match(both.errorMessage, /nous\/Hermes-4-70B.*nso\/Hermes-4-70B/);
  assert.deepEqual(both.candidateProviders, ["nous-research", "nous-oauth"]);
  assert.equal((await getModelInfoCore(`nous/${id}`, null)).provider, "nous-research");
  assert.equal((await getModelInfoCore(`nso/${id}`, null)).provider, "nous-oauth");
  assert.equal((await getModelInfoCore(`nous-oauth/${id}`, null)).provider, "nous-oauth");
  assert.equal((await getModelInfoCore("gpt-4o", null)).provider, "openai");

  await db.updateProviderConnection(oauth.id, { isActive: false });
  assert.equal((await getModelInfoCore(id, null)).provider, "nous-research");
  await db.updateProviderConnection(oauth.id, { isActive: true });
  await db.updateProviderConnection(key.id, { isActive: false });
  assert.equal((await getModelInfoCore(id, null)).provider, "nous-oauth");
});
