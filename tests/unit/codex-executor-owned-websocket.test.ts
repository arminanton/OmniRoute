import {
  RequestTransportTelemetry,
  runWithRequestTransportTelemetry,
} from "../../open-sse/utils/transportTelemetry.ts";
import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexExecutor,
  __setCodexWebSocketTransportForTesting,
} from "../../open-sse/executors/codex.ts";
import { withCodexConversationIdentity } from "../../open-sse/services/codexConversationIdentity.ts";
import type { CodexConversationSocket } from "../../open-sse/executors/codex/conversationSocketPool.ts";

test("executor receipts permit the same owner and reject foreign/untracked previous IDs without sending", async () => {
  const executor = new CodexExecutor();
  let connections = 0;
  let sends = 0;
  __setCodexWebSocketTransportForTesting(async () => {
    connections++;
    const socket: CodexConversationSocket = {
      onmessage: null,
      onerror: null,
      onclose: null,
      close() {},
      send(payload) {
        assert.equal(JSON.parse(String(payload)).service_tier, "priority");
        const id = `resp_owned_fixture_${++sends}`;
        queueMicrotask(() => {
          socket.onmessage?.({
            data: JSON.stringify({ type: "response.created", response: { id } }),
          });
          socket.onmessage?.({
            data: JSON.stringify({
              type: "response.completed",
              response: { id, status: "completed", output: [] },
            }),
          });
        });
      },
    };
    return socket;
  });
  const credential = (principal: string) =>
    withCodexConversationIdentity(
      "codex",
      {
        connectionId: "synthetic-account",
        accessToken: "synthetic-not-a-real-token",
        providerSpecificData: { codexTransport: "websocket", codexFingerprintMode: "off" },
      },
      principal,
      "same-native-thread",
      "gpt-6.1-sol"
    );
  const invoke = (principal: string, previous?: string) =>
    executor.execute({
      model: "gpt-6.1-sol",
      stream: true,
      credentials: credential(principal),
      body: {
        model: "gpt-6.1-sol",
        service_tier: "fast",
        input: [{ role: "user", content: "synthetic" }],
        ...(previous ? { previous_response_id: previous } : {}),
      },
      clientHeaders: { "thread-id": "identical-native-thread" },
    });
  try {
    const telemetry = new RequestTransportTelemetry(undefined, () => {});
    await runWithRequestTransportTelemetry(telemetry, async () => {
      await (await invoke("principal-a")).response.text();
      await (await invoke("principal-a", "resp_owned_fixture_1")).response.text();
    });
    const attempts = telemetry.snapshot().attempts;
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].reused, false);
    assert.equal(attempts[1].reused, true);
    assert.equal(attempts[1].connectedMs, null);
    assert.notEqual(attempts[0].firstEventMs, null);
    assert.ok(attempts[0].bytes > 0);
    assert.equal(attempts[0].closure, "eof");
    assert.equal(sends, 2);
    assert.equal(connections, 1);
    for (const [principal, id] of [
      ["principal-b", "resp_owned_fixture_1"],
      ["principal-a", "resp_untracked"],
    ]) {
      const result = await invoke(principal, id);
      assert.equal(result.response.status, 409);
      const error = await result.response.json();
      assert.equal(error.error.code, "previous_response_not_found");
      assert.match(error.error.message, /Resend complete input/);
    }
    assert.equal(sends, 2);
  } finally {
    __setCodexWebSocketTransportForTesting(undefined);
    Reflect.get(executor, "conversationSockets").close();
  }
});

for (const tier of ["fast", "priority", "default", "ultrafast"]) {
  test(`native OAuth maps logical ${tier} without rewriting custom API endpoints`, () => {
    const executor = new CodexExecutor();
    const credentials = { accessToken: "synthetic-access-only" };
    const body = { model: "gpt-6-luna", input: [], service_tier: tier };
    assert.equal(
      executor.transformRequest("gpt-6-luna", body, true, credentials).service_tier,
      tier === "fast" ? "priority" : tier
    );
    assert.equal(body.service_tier, tier);
    const external = new CodexExecutor();
    external.config = { ...external.config, baseUrl: "https://api.openai.com/v1" };
    assert.equal(
      external.transformRequest("gpt-6-luna", body, true, credentials).service_tier,
      tier
    );
    assert.equal(
      executor.transformRequest("gpt-6-luna", body, true, { apiKey: "synthetic" }).service_tier,
      tier
    );
  });
}

test("actual native WebSocket first-event deadline preserves terminal uncertain marker through public projection", async () => {
  const { LogicalRetryBudget, runWithLogicalRetryBudget, isLogicalRetryBudgetError } =
    await import("../../open-sse/services/logicalRetryBudget.ts");
  const { isUncertainGenerationAcceptance } =
    await import("../../open-sse/services/generationReplay.ts");
  const executor = new CodexExecutor();
  let sends = 0;
  __setCodexWebSocketTransportForTesting(async () => ({
    onmessage: null,
    onerror: null,
    onclose: null,
    close() {},
    send() {
      sends++;
    },
  }));
  const budget = new LogicalRetryBudget(12, Date.now() + 100);
  try {
    const result = await runWithLogicalRetryBudget(budget, () =>
      executor.execute({
        model: "gpt-6.1-sol",
        stream: true,
        credentials: {
          connectionId: "synthetic-account",
          accessToken: "synthetic-access-only",
          providerSpecificData: { codexTransport: "websocket", codexFingerprintMode: "off" },
        },
        body: { model: "gpt-6.1-sol", input: [{ role: "user", content: "synthetic" }] },
      })
    );
    assert.equal(
      result.response.status,
      200,
      "the established stream status is not a native HTTP failure status"
    );
    const raw = await result.response.text();
    assert.match(raw, /"code":"upstream_acceptance_uncertain"/);
    assert.doesNotMatch(raw, /RETRY_BUDGET_EXHAUSTED|upstream_server_error/);
    assert.equal(sends, 1);
    assert.throws(
      () => budget.consumeAttempt(),
      (error) => isLogicalRetryBudgetError(error) && isUncertainGenerationAcceptance(error)
    );
  } finally {
    __setCodexWebSocketTransportForTesting(undefined);
    Reflect.get(executor, "conversationSockets").close();
  }
});
