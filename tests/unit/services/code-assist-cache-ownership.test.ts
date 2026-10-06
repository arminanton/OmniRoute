import assert from "node:assert/strict";
import test from "node:test";
import {
  guardCodeAssistCacheReference,
  type CodeAssistCacheOwnershipReceipt,
} from "../../../open-sse/services/codeAssistCacheOwnership.ts";

const namespace = "ag:" + "a".repeat(64);
const receipt: CodeAssistCacheOwnershipReceipt = {
  issuer: "omni-code-assist-cache-ownership/v1",
  surface: "cloud-code",
  serviceCapabilityVerified: true,
  reference: "projects/native-project/locations/global/cachedContents/private-cache",
  connectionId: "connection-A",
  projectId: "native-project",
  namespace,
  model: "gemini-3.8-flash",
  expiresAt: 2000,
};
const credentials = {
  connectionId: "connection-A",
  projectId: "native-project",
  _signatureNamespace: namespace,
  _codeAssistCacheOwnershipReceipt: receipt,
};

test("verified scoped reference is retained, never automatically created", () => {
  const request = { contents: [], cachedContent: receipt.reference };
  assert.equal(
    guardCodeAssistCacheReference(request, credentials, receipt.model, 1000).cachedContent,
    receipt.reference
  );
  const snake = guardCodeAssistCacheReference(
    { cached_content: receipt.reference },
    credentials,
    receipt.model,
    1000
  );
  assert.equal(snake.cachedContent, receipt.reference);
  assert.equal("cached_content" in snake, false);
  assert.equal(request.cachedContent, receipt.reference);
});

test("missing, stale, wrong principal/conversation/account/model receipts fail closed", () => {
  const request = { cachedContent: receipt.reference };
  for (const altered of [
    {},
    { ...credentials, _signatureNamespace: "ag:" + "b".repeat(64) },
    { ...credentials, connectionId: "connection-B" },
    { ...credentials, projectId: "different-project" },
    { ...credentials, _codeAssistCacheOwnershipReceipt: { ...receipt, expiresAt: 999 } },
    { ...credentials, _codeAssistCacheOwnershipReceipt: { ...receipt, model: "different-model" } },
    {
      ...credentials,
      _codeAssistCacheOwnershipReceipt: { ...receipt, serviceCapabilityVerified: false },
    },
  ])
    assert.throws(() => guardCodeAssistCacheReference(request, altered, receipt.model, 1000), {
      code: "unverified_code_assist_cache_reference",
    });
});

test("request-supplied receipt cannot authorize ownership; ordinary implicit caching unaffected", () => {
  assert.throws(() =>
    guardCodeAssistCacheReference(
      { cachedContent: receipt.reference, _codeAssistCacheOwnershipReceipt: receipt },
      {},
      receipt.model,
      1000
    )
  );
  const ordinary = { contents: [{ parts: [{ text: "normal turn" }] }] };
  assert.equal(guardCodeAssistCacheReference(ordinary, {}, receipt.model), ordinary);
  assert.throws(() =>
    guardCodeAssistCacheReference(
      { cachedContent: receipt.reference, cached_content: "cachedContents/conflicting" },
      credentials,
      receipt.model,
      1000
    )
  );
});

test("executor preserves authorized reference and rejects body-only forgery before dispatch", async () => {
  const { AntigravityExecutor } = await import("../../../open-sse/executors/antigravity.ts");
  const executor = new AntigravityExecutor();
  const body = {
    request: {
      contents: [{ role: "user", parts: [{ text: "next turn" }] }],
      cachedContent: receipt.reference,
    },
  };
  const authorized = {
    ...credentials,
    projectId: "native-project",
    _codeAssistCacheOwnershipReceipt: { ...receipt, expiresAt: Date.now() + 60000 },
  };
  const result = await executor.transformRequest(receipt.model, body, true, authorized);
  assert(!(result instanceof Response));
  assert.equal(result.request.cachedContent, receipt.reference);
  const invalid = await executor.transformRequest(
    receipt.model,
    { ...body, _codeAssistCacheOwnershipReceipt: receipt },
    true,
    { projectId: "native-project", connectionId: "connection-A", _signatureNamespace: namespace }
  );
  assert(invalid instanceof Response);
  assert.equal(invalid.status, 400);
  const failure = await invalid.text();
  assert(failure.includes("verified caller"));
  assert(!failure.includes(receipt.reference));
});
