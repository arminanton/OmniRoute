import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { SignJWT } from "jose";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-v1-resource-scope-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = "v1-resource-scope-test-secret";
process.env.JWT_SECRET = "v1-resource-scope-session-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";

const core = await import("@/lib/db/core");
const { createApiKey } = await import("@/lib/db/apiKeys");
const { createFile, getFile, getFileContent } = await import("@/lib/db/files");
const { createBatch, getBatch } = await import("@/lib/db/batches");
const filesRoute = await import("@/app/api/v1/files/route");
const fileRoute = await import("@/app/api/v1/files/[id]/route");
const fileContentRoute = await import("@/app/api/v1/files/[id]/content/route");
const batchesRoute = await import("@/app/api/v1/batches/route");
const batchRoute = await import("@/app/api/v1/batches/[id]/route");
const batchCancelRoute = await import("@/app/api/v1/batches/[id]/cancel/route");
const deleteCompletedRoute = await import("@/app/api/v1/batches/delete-completed/route");

after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  delete process.env.DATA_DIR;
  delete process.env.API_KEY_SECRET;
  delete process.env.JWT_SECRET;
  delete process.env.DISABLE_SQLITE_AUTO_BACKUP;
});

function makeRequest(
  pathname: string,
  options: { method?: string; apiKey?: string; cookie?: string; body?: BodyInit } = {}
): Request {
  const headers = new Headers();
  if (options.apiKey) headers.set("Authorization", `Bearer ${options.apiKey}`);
  if (options.cookie) headers.set("Cookie", options.cookie);
  if (options.body instanceof FormData) {
    return new Request(`http://localhost${pathname}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
    });
  }
  return new Request(`http://localhost${pathname}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

async function dashboardCookie(): Promise<string> {
  const token = await new SignJWT({ authenticated: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  return `auth_token=${token}`;
}

function createTestFile(filename: string, apiKeyId: string | null) {
  const content = Buffer.from(`content:${filename}`);
  return createFile({
    bytes: content.byteLength,
    filename,
    purpose: "assistants",
    content,
    mimeType: "text/plain",
    apiKeyId,
  });
}

function createTestBatch(inputFileId: string, apiKeyId: string | null, status = "in_progress") {
  return createBatch({
    endpoint: "/v1/chat/completions",
    completionWindow: "24h",
    inputFileId,
    apiKeyId,
    status: status as "in_progress" | "completed",
  });
}

test("V1 file and batch handlers reject anonymous callers", async () => {
  const fileParams = { params: Promise.resolve({ id: "file-not-found" }) };
  const batchParams = { params: Promise.resolve({ id: "batch_not_found" }) };
  const requests: Array<[string, () => Promise<Response>]> = [
    ["file list", () => filesRoute.GET(makeRequest("/api/v1/files"))],
    ["file upload", () => filesRoute.POST(makeRequest("/api/v1/files", { method: "POST" }))],
    ["file metadata", () => fileRoute.GET(makeRequest("/api/v1/files/file-not-found"), fileParams)],
    [
      "file delete",
      () =>
        fileRoute.DELETE(
          makeRequest("/api/v1/files/file-not-found", { method: "DELETE" }),
          fileParams
        ),
    ],
    [
      "file content",
      () => fileContentRoute.GET(makeRequest("/api/v1/files/file-not-found/content"), fileParams),
    ],
    ["batch list", () => batchesRoute.GET(makeRequest("/api/v1/batches"))],
    ["batch create", () => batchesRoute.POST(makeRequest("/api/v1/batches", { method: "POST" }))],
    [
      "batch detail",
      () => batchRoute.GET(makeRequest("/api/v1/batches/batch_not_found"), batchParams),
    ],
    [
      "batch delete",
      () =>
        batchRoute.DELETE(
          makeRequest("/api/v1/batches/batch_not_found", { method: "DELETE" }),
          batchParams
        ),
    ],
    [
      "batch cancel",
      () =>
        batchCancelRoute.POST(
          makeRequest("/api/v1/batches/batch_not_found/cancel", { method: "POST" }),
          batchParams
        ),
    ],
    [
      "delete completed batches",
      () =>
        deleteCompletedRoute.DELETE(
          makeRequest("/api/v1/batches/delete-completed", { method: "DELETE" })
        ),
    ],
  ];

  for (const [label, invoke] of requests) {
    const response = await invoke();
    assert.equal(response.status, 401, `${label} must reject anonymous callers`);
    const body = await response.json();
    assert.equal(body.error.type, "invalid_request_error", `${label} error type`);
  }

  const invalidBearer = await filesRoute.GET(
    makeRequest("/api/v1/files", { apiKey: "not-a-valid-api-key" })
  );
  assert.equal(invalidBearer.status, 401, "invalid Bearer must not downgrade to anonymous access");
});

test("API-key listings and resource methods remain scoped to that key", async () => {
  const owner = await createApiKey("resource owner", "resource-owner");
  const other = await createApiKey("other resource owner", "other-resource-owner");
  const ownFile = createTestFile("owner-a.txt", owner.id);
  const otherFile = createTestFile("owner-b.txt", other.id);
  const unownedFile = createTestFile("shared-unowned.txt", null);
  const ownBatch = createTestBatch(ownFile.id, owner.id);
  const otherBatch = createTestBatch(otherFile.id, other.id);

  const fileList = await filesRoute.GET(makeRequest("/api/v1/files", { apiKey: owner.key }));
  assert.equal(fileList.status, 200);
  const listedFiles = await fileList.json();
  assert.deepEqual(
    listedFiles.data.map((entry: { id: string }) => entry.id),
    [ownFile.id],
    "an API-key owner must not receive an unfiltered tenant list"
  );

  const batchList = await batchesRoute.GET(makeRequest("/api/v1/batches", { apiKey: owner.key }));
  assert.equal(batchList.status, 200);
  const listedBatches = await batchList.json();
  assert.deepEqual(
    listedBatches.data.map((entry: { id: string }) => entry.id),
    [ownBatch.id],
    "an API-key owner must not receive another tenant's batches"
  );

  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const otherFileResponse = await fileRoute.GET(
    makeRequest(`/api/v1/files/${otherFile.id}`, { apiKey: owner.key }),
    params(otherFile.id)
  );
  assert.equal(otherFileResponse.status, 404);

  const otherContentResponse = await fileContentRoute.GET(
    makeRequest(`/api/v1/files/${otherFile.id}/content`, { apiKey: owner.key }),
    params(otherFile.id)
  );
  assert.equal(otherContentResponse.status, 404);

  const ownContentResponse = await fileContentRoute.GET(
    makeRequest(`/api/v1/files/${ownFile.id}/content`, { apiKey: owner.key }),
    params(ownFile.id)
  );
  assert.equal(ownContentResponse.status, 200);
  assert.deepEqual(Buffer.from(await ownContentResponse.arrayBuffer()), getFileContent(ownFile.id));

  const otherBatchResponse = await batchRoute.GET(
    makeRequest(`/api/v1/batches/${otherBatch.id}`, { apiKey: owner.key }),
    params(otherBatch.id)
  );
  assert.equal(otherBatchResponse.status, 404);

  const otherCancelResponse = await batchCancelRoute.POST(
    makeRequest(`/api/v1/batches/${otherBatch.id}/cancel`, {
      method: "POST",
      apiKey: owner.key,
    }),
    params(otherBatch.id)
  );
  assert.equal(otherCancelResponse.status, 404);
  assert.equal(getBatch(otherBatch.id)?.status, "in_progress");

  assert.ok(getFile(unownedFile.id), "unowned file fixture remains available to the session test");
});

test("dashboard sessions retain cross-owner file and batch access", async () => {
  const owner = await createApiKey("session test owner", "session-owner");
  const other = await createApiKey("session test other", "session-other");
  const ownerFile = createTestFile("session-owner.txt", owner.id);
  const otherFile = createTestFile("session-other.txt", other.id);
  const otherBatch = createTestBatch(otherFile.id, other.id);
  const cookie = await dashboardCookie();

  const files = await filesRoute.GET(makeRequest("/api/v1/files", { cookie }));
  assert.equal(files.status, 200);
  const fileList = await files.json();
  assert.ok(fileList.data.some((entry: { id: string }) => entry.id === ownerFile.id));
  assert.ok(fileList.data.some((entry: { id: string }) => entry.id === otherFile.id));

  const batches = await batchesRoute.GET(makeRequest("/api/v1/batches", { cookie }));
  assert.equal(batches.status, 200);
  const batchList = await batches.json();
  assert.ok(batchList.data.some((entry: { id: string }) => entry.id === otherBatch.id));

  const params = { params: Promise.resolve({ id: otherFile.id }) };
  const content = await fileContentRoute.GET(
    makeRequest(`/api/v1/files/${otherFile.id}/content`, { cookie }),
    params
  );
  assert.equal(content.status, 200);

  const batchParams = { params: Promise.resolve({ id: otherBatch.id }) };
  const cancelled = await batchCancelRoute.POST(
    makeRequest(`/api/v1/batches/${otherBatch.id}/cancel`, { method: "POST", cookie }),
    batchParams
  );
  assert.equal(cancelled.status, 200);
  assert.equal(getBatch(otherBatch.id)?.status, "cancelling");
});

test("delete-completed only removes the requesting API key's batches", async () => {
  const owner = await createApiKey("cleanup owner", "cleanup-owner");
  const other = await createApiKey("cleanup other", "cleanup-other");
  const ownFile = createTestFile("cleanup-owner.jsonl", owner.id);
  const otherFile = createTestFile("cleanup-other.jsonl", other.id);
  const ownBatch = createTestBatch(ownFile.id, owner.id, "completed");
  const otherBatch = createTestBatch(otherFile.id, other.id, "completed");

  const response = await deleteCompletedRoute.DELETE(
    makeRequest("/api/v1/batches/delete-completed", { method: "DELETE", apiKey: owner.key })
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true, deletedBatches: 1, deletedFiles: 1 });
  assert.equal(getBatch(ownBatch.id), null);
  assert.equal(getFile(ownFile.id), null);
  assert.ok(getBatch(otherBatch.id), "the other API key's batch must remain");
  assert.ok(getFile(otherFile.id), "the other API key's file must remain");
});
