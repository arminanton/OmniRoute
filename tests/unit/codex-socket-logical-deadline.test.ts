import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexConversationSocketPool,
  type CodexConversationSocket,
  type CodexSocketRequest,
} from "../../open-sse/executors/codex/conversationSocketPool.ts";
import {
  LogicalRetryBudget,
  runWithLogicalRetryBudget,
  isLogicalRetryBudgetError,
} from "../../open-sse/services/logicalRetryBudget.ts";
function fixture(first: number | null, completed: number) {
  let sends = 0,
    closes = 0;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const socket: CodexConversationSocket = {
    onmessage: null,
    onerror: null,
    onclose: null,
    close() {
      closes++;
      timers.forEach(clearTimeout);
    },
    send() {
      sends++;
      if (first !== null)
        timers.push(
          setTimeout(
            () => socket.onmessage?.({ data: JSON.stringify({ type: "response.created" }) }),
            first
          )
        );
      if (first !== null)
        timers.push(
          setTimeout(
            () => socket.onmessage?.({ data: JSON.stringify({ type: "response.completed" }) }),
            completed
          )
        );
    },
  };
  const request: CodexSocketRequest = {
    url: "wss://fixture.invalid/responses",
    headers: {},
    body: { model: "fixture", input: [] },
    ownerKey: "fixture-principal",
    reuse: true,
    connect: async () => socket,
    encode: (raw) => ({
      sse: `data: ${raw}\n\n`,
      terminal: JSON.parse(raw).type === "response.completed",
    }),
    failure: (code) => `data: ${code}\n\n`,
  };
  return { request, counts: () => ({ sends, closes }) };
}

test("native socket busy queue and handshake cannot outlive remaining logical deadline", async () => {
  const pool = new CodexConversationSocketPool({ queueTimeoutMs: 90000, connectTimeoutMs: 15000 });
  const f = fixture(1, 250);
  try {
    const first = await pool.request(f.request);
    await assert.rejects(
      runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 25), () =>
        pool.request(f.request)
      ),
      isLogicalRetryBudgetError
    );
    assert.equal(f.counts().sends, 1);
    await first.body?.cancel();
    const g = fixture(1, 100);
    await assert.rejects(
      runWithLogicalRetryBudget(new LogicalRetryBudget(12, Date.now() + 25), () =>
        pool.request({
          ...g.request,
          connect: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve(g.request.connect("wss://fixture.invalid")), 100)
            ),
        })
      ),
      isLogicalRetryBudgetError
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(g.counts().closes, 1);
    assert.equal(g.counts().sends, 0);
  } finally {
    pool.close();
  }
});

test("native socket first-event budget exhaustion is terminal and forbids additional sends", async () => {
  const pool = new CodexConversationSocketPool({ firstEventTimeoutMs: 80000 });
  const f = fixture(null, 0);
  const budget = new LogicalRetryBudget(12, Date.now() + 30);
  try {
    const response = await runWithLogicalRetryBudget(budget, () => pool.request(f.request));
    assert.match(await response.text(), /RETRY_BUDGET_EXHAUSTED/);
    assert.throws(() => budget.consumeAttempt(), isLogicalRetryBudgetError);
    assert.equal(f.counts().sends, 1);
  } finally {
    pool.close();
  }
});

test("native socket first semantic event ends logical clock while subsequent body uses idle timeout", async () => {
  const pool = new CodexConversationSocketPool({ idleTimeoutMs: 1000 });
  const f = fixture(1, 100);
  try {
    const response = await runWithLogicalRetryBudget(
      new LogicalRetryBudget(12, Date.now() + 40),
      () => pool.request(f.request)
    );
    const body = await response.text();
    assert.match(body, /response.completed/);
    assert.doesNotMatch(body, /RETRY_BUDGET_EXHAUSTED/);
  } finally {
    pool.close();
  }
});
