import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-dario-supervisor-key-"));
const ORIGINAL_DATA_DIR = process.env.DATA_DIR;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_STORAGE_ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY;
const ORIGINAL_DISABLE_SQLITE_AUTO_BACKUP = process.env.DISABLE_SQLITE_AUTO_BACKUP;

process.env.DATA_DIR = TEST_DATA_DIR;
process.env.NODE_ENV = "test";
process.env.STORAGE_ENCRYPTION_KEY = "dario-supervisor-key-test-encryption-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("../../../../src/lib/db/core.ts");
const { upsertVersionManagerTool } = await import("../../../../src/lib/db/versionManager.ts");
const { getSupervisor, unregisterSupervisor } = await import("../../../../src/lib/services/registry.ts");
const { ServiceSupervisor } = await import("../../../../src/lib/services/ServiceSupervisor.ts");
const { POST } = await import("../../../../src/app/api/services/dario/start/route.ts");

after(() => {
  unregisterSupervisor("dario");
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

  if (ORIGINAL_DATA_DIR === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = ORIGINAL_DATA_DIR;
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_STORAGE_ENCRYPTION_KEY === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = ORIGINAL_STORAGE_ENCRYPTION_KEY;
  if (ORIGINAL_DISABLE_SQLITE_AUTO_BACKUP === undefined) delete process.env.DISABLE_SQLITE_AUTO_BACKUP;
  else process.env.DISABLE_SQLITE_AUTO_BACKUP = ORIGINAL_DISABLE_SQLITE_AUTO_BACKUP;
});

test("Dario start fails closed when the stored admin key cannot be decrypted", async () => {
  unregisterSupervisor("dario");
  await upsertVersionManagerTool({
    tool: "dario",
    status: "stopped",
    apiKey: "enc:v1:corrupt-ciphertext",
  });

  const originalStart = ServiceSupervisor.prototype.start;
  let startCalls = 0;
  ServiceSupervisor.prototype.start = async function startSpy() {
    startCalls += 1;
    return this.getStatus();
  };

  try {
    const response = await POST(
      new Request("http://localhost/api/services/dario/start", { method: "POST" })
    );

    assert.equal(response.status, 503);
    assert.equal(startCalls, 0, "the supervisor must not start with a fallback admin token");
    assert.equal(getSupervisor("dario"), null, "failed key recovery must not register a supervisor");
    const body = await response.json();
    assert.match(body.error?.message ?? body.message, /could not be decrypted/i);
  } finally {
    ServiceSupervisor.prototype.start = originalStart;
    unregisterSupervisor("dario");
  }
});
