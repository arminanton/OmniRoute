import "../_setup/isolateDataDir.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getAntigravitySessionId,
  withAntigravityConversationIdentity,
} from "../../open-sse/services/antigravityIdentity.ts";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.ts";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";

test("Antigravity identity is stable per actual conversation and isolated across callers", () => {
  const base = { connectionId: "account", accessToken: "synthetic" };
  const a = withAntigravityConversationIdentity("antigravity", base, "key-a", "child-a");
  const again = withAntigravityConversationIdentity("agy", base, "key-a", "child-a");
  const otherChild = withAntigravityConversationIdentity("agy", base, "key-a", "child-b");
  const otherCaller = withAntigravityConversationIdentity("agy", base, "key-b", "child-a");
  assert.equal(getAntigravitySessionId(a), getAntigravitySessionId(again));
  assert.notEqual(getAntigravitySessionId(a), getAntigravitySessionId(otherChild));
  assert.notEqual(getAntigravitySessionId(a), getAntigravitySessionId(otherCaller));
  assert.equal(getAntigravitySessionId(a, "native-id"), "native-id");
  assert.deepEqual(base, { connectionId: "account", accessToken: "synthetic" });
  assert.equal(withAntigravityConversationIdentity("codex", base, "key-a", "child-a"), base);
  assert.equal(withAntigravityConversationIdentity("agy", base, "key-a", null), base);
});

test("100 conversations preserve distinct thought signatures even with identical upstream tool ids", async () => {
  const executor = new AntigravityExecutor();
  const sessions = await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const credentials = withAntigravityConversationIdentity(
        "antigravity",
        { connectionId: "account", projectId: "synthetic-project" },
        "same-key",
        `child-${i}`
      );
      const namespace = (credentials as { _signatureNamespace?: string })._signatureNamespace;
      const response = new Response(
        `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ functionCall: { id: "shared-id", name: "lookup", args: { i } }, thoughtSignature: `signature-${i}` }] }, finishReason: "STOP" }] } })}\n\n`
      );
      const collected = await executor.collectStreamToResponse(
        response,
        "mock",
        "https://mock.invalid",
        {},
        {},
        null,
        null,
        namespace
      );
      const message = (await collected.response.json()).choices[0].message;
      return { credentials, namespace, message, i };
    })
  );
  for (const { credentials, namespace, message, i } of sessions) {
    const translated = openaiToAntigravityRequest(
      "gemini-2.5-flash",
      {
        messages: [
          { role: "user", content: "lookup" },
          { role: "assistant", ...message },
          { role: "tool", tool_call_id: "shared-id", content: "result" },
        ],
      },
      false,
      { ...credentials, _signatureNamespace: namespace }
    );
    const call = translated.request.contents
      .flatMap((c: { parts: unknown[] }) => c.parts)
      .find((p: { functionCall?: unknown }) => p.functionCall);
    assert.equal(call.thoughtSignature, `signature-${i}`);
    assert.equal(translated.request.sessionId, getAntigravitySessionId(credentials));
  }
});
