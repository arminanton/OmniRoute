import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-gemini-cookie-rotation-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.STORAGE_ENCRYPTION_KEY = "gemini-cookie-rotation-test-key";

const core = await import("../../src/lib/db/core.ts");
const encryption = await import("../../src/lib/db/encryption.ts");
const providers = await import("../../src/lib/db/providers.ts");

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function createGeminiConnection(cookie: string, authType = "cookie", provider = "gemini-web") {
  return providers.createProviderConnection({
    provider,
    authType,
    apiKey: cookie,
    name: `Gemini ${Math.random()}`,
    isActive: true,
  });
}

function rawDb() {
  return core.getDbInstance() as unknown as {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
      run(...params: unknown[]): unknown;
    };
  };
}

function rawConnection(id: string) {
  return rawDb()
    .prepare("SELECT id, provider, auth_type, api_key FROM provider_connections WHERE id = ?")
    .get(id) as { id: string; provider: string; auth_type: string; api_key: string } | undefined;
}

function decryptedCookie(id: string) {
  const row = rawConnection(id);
  assert.ok(row);
  const value = encryption.decrypt(row.api_key, { quiet: true });
  assert.equal(typeof value, "string");
  return value as string;
}

test.beforeEach(resetStorage);
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Gemini cookie rotations merge distinct concurrent cookie changes", async () => {
  const base = "__Secure-1PSID=P0; __Secure-1PSIDTS=T0; __Secure-1PSIDCC=C0; other=keep";
  const connection = await createGeminiConnection(base);
  const id = String(connection.id);

  const results = await Promise.all([
    Promise.resolve().then(() =>
      providers.persistGeminiWebCookieRotation(id, base, "__Secure-1PSID=P0; __Secure-1PSIDTS=T1; __Secure-1PSIDCC=C0; other=keep")
    ),
    Promise.resolve().then(() =>
      providers.persistGeminiWebCookieRotation(id, base, "__Secure-1PSID=P0; __Secure-1PSIDTS=T0; __Secure-1PSIDCC=C1; other=keep")
    ),
  ]);

  assert.deepEqual(results, [true, true]);
  assert.equal(
    decryptedCookie(id),
    "__Secure-1PSID=P0; __Secure-1PSIDTS=T1; __Secure-1PSIDCC=C1; other=keep"
  );
  assert.match(rawConnection(id)!.api_key, /^enc:v1:/);
});

test("stale same-cookie rotation cannot revert newer value", async () => {
  const base = "__Secure-1PSID=P0; __Secure-1PSIDTS=T0";
  const connection = await createGeminiConnection(base);
  const id = String(connection.id);

  assert.equal(
    providers.persistGeminiWebCookieRotation(id, base, "__Secure-1PSID=P0; __Secure-1PSIDTS=T1"),
    true
  );
  assert.equal(
    providers.persistGeminiWebCookieRotation(id, base, "__Secure-1PSID=P0; __Secure-1PSIDTS=T2"),
    false
  );
  assert.equal(decryptedCookie(id), "__Secure-1PSID=P0; __Secure-1PSIDTS=T1");
});

test("Gemini apikey connection rotates cookies and keeps stored credential encrypted", async () => {
  const base = "__Secure-1PSID=P0; __Secure-1PSIDTS=T0";
  const connection = await createGeminiConnection(base, "apikey");
  const id = String(connection.id);

  assert.equal(rawConnection(id)?.auth_type, "apikey");
  assert.equal(
    providers.persistGeminiWebCookieRotation(id, base, "__Secure-1PSID=P0; __Secure-1PSIDTS=T1"),
    true
  );
  assert.equal(decryptedCookie(id), "__Secure-1PSID=P0; __Secure-1PSIDTS=T1");
  assert.match(rawConnection(id)!.api_key, /^enc:v1:/);
});

test("rotation preserves jar-absent cookies and absent base cookies are not deleted", async () => {
  const base = "__Secure-1PSID=P0; __Secure-1PSIDTS=T0; __Secure-1PSIDCC=C0; other=keep";
  const connection = await createGeminiConnection(base);
  const id = String(connection.id);

  assert.equal(
    providers.persistGeminiWebCookieRotation(id, base, "__Secure-1PSIDTS=T1"),
    true
  );
  assert.equal(
    decryptedCookie(id),
    "__Secure-1PSID=P0; __Secure-1PSIDTS=T1; __Secure-1PSIDCC=C0; other=keep"
  );
});

test("manual replacement and connection removal are not resurrected by stale rotation", async () => {
  const base = "__Secure-1PSID=P0; __Secure-1PSIDTS=T0";
  const connection = await createGeminiConnection(base);
  const id = String(connection.id);
  const replacement = "__Secure-1PSID=NEW; __Secure-1PSIDTS=NEWTS";

  await providers.updateProviderConnection(id, { apiKey: replacement });
  assert.equal(
    providers.persistGeminiWebCookieRotation(id, base, "__Secure-1PSID=P0; __Secure-1PSIDTS=T1"),
    false
  );
  assert.equal(decryptedCookie(id), replacement);

  rawDb().prepare("DELETE FROM provider_connections WHERE id = ?").run(id);
  assert.equal(
    providers.persistGeminiWebCookieRotation(id, base, "__Secure-1PSID=P0; __Secure-1PSIDTS=T2"),
    false
  );
  assert.equal(rawConnection(id), undefined);
});

test("wrong provider and auth type reject cookie rotation", async () => {
  const base = "__Secure-1PSID=P0; __Secure-1PSIDTS=T0";
  const wrongProvider = await createGeminiConnection(base, "cookie", "other-provider");
  const wrongAuth = await createGeminiConnection(base, "oauth");

  assert.equal(
    providers.persistGeminiWebCookieRotation(String(wrongProvider.id), base, "__Secure-1PSIDTS=T1"),
    false
  );
  assert.equal(
    providers.persistGeminiWebCookieRotation(String(wrongAuth.id), base, "__Secure-1PSIDTS=T1"),
    false
  );
  assert.equal(decryptedCookie(String(wrongProvider.id)), base);
  assert.equal(decryptedCookie(String(wrongAuth.id)), base);
});

test("failed cookie decryption rejects rotation without writing ciphertext as plaintext", async () => {
  const base = "__Secure-1PSID=P0; __Secure-1PSIDTS=T0";
  const connection = await createGeminiConnection(base);
  const id = String(connection.id);
  const badCiphertext = "enc:v1:malformed";
  rawDb()
    .prepare("UPDATE provider_connections SET api_key = ? WHERE id = ?")
    .run(badCiphertext, id);

  assert.throws(
    () => providers.persistGeminiWebCookieRotation(id, base, "__Secure-1PSIDTS=T1"),
    /refusing rotation/i
  );
  assert.equal(rawConnection(id)!.api_key, badCiphertext);
});
