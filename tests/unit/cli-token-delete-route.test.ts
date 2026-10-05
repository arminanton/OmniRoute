import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-cli-token-delete-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.INITIAL_PASSWORD = "test-pass";

const core = await import("../../src/lib/db/core.ts");
const at = await import("../../src/lib/db/accessTokens.ts");
const { DELETE } = await import("../../src/app/api/cli/tokens/[id]/route.ts");

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 5 });
  delete process.env.INITIAL_PASSWORD;
});

function deleteToken(id: string, bearer: string): Promise<Response> {
  return DELETE(
    new Request(`http://localhost:20128/api/cli/tokens/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${bearer}` },
    }),
    { params: Promise.resolve({ id }) }
  );
}

test("DELETE retries an already-revoked token successfully", async () => {
  const admin = at.createAccessToken({ name: "admin", scope: "admin" });
  const target = at.createAccessToken({ name: "target", scope: "read" });

  const first = await deleteToken(target.record.id, admin.secret);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    success: true,
    id: target.record.id,
    alreadyRevoked: false,
  });

  const retry = await deleteToken(target.record.id, admin.secret);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), {
    success: true,
    id: target.record.id,
    alreadyRevoked: true,
  });
});

test("DELETE returns 404 for an unknown token", async () => {
  const admin = at.createAccessToken({ name: "admin-missing", scope: "admin" });
  const response = await deleteToken("tok_missing", admin.secret);
  assert.equal(response.status, 404);
});

test("DELETE refuses a prefix shared by two live tokens", async () => {
  const admin = at.createAccessToken({ name: "admin-ambiguous", scope: "admin" });
  const first = at.createAccessToken({ name: "ambiguous-a", scope: "read" });
  const second = at.createAccessToken({ name: "ambiguous-b", scope: "write" });
  core
    .getDbInstance()
    .prepare("UPDATE cli_access_tokens SET token_prefix = ? WHERE id = ?")
    .run(first.record.tokenPrefix, second.record.id);

  const response = await deleteToken(first.record.tokenPrefix, admin.secret);
  assert.equal(response.status, 409);
  assert.equal(at.getAccessToken(first.record.id)?.revokedAt, null);
  assert.equal(at.getAccessToken(second.record.id)?.revokedAt, null);
});
