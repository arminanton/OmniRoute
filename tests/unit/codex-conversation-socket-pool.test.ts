import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexConversationSocketPool,
  type CodexConversationSocket,
  type CodexSocketRequest,
} from "../../open-sse/executors/codex/conversationSocketPool.ts";
import {
  prepareCodexContinuation,
  commitCodexContinuation,
} from "../../open-sse/executors/codex/deltaContinuation.ts";

const failure = (code: string) =>
  `event: response.failed\ndata: ${JSON.stringify({ type: "response.failed", error: { code } })}\n\n`;
const encode = (raw: string) => {
  const value = JSON.parse(raw) as { type: string };
  return {
    sse: `data: ${raw}\n\n`,
    terminal: ["response.completed", "response.failed", "response.incomplete"].includes(value.type),
  };
};
function fixture(delay = 0) {
  let connections = 0,
    closes = 0,
    sends = 0;
  const bodies: Record<string, unknown>[] = [];
  const connect = async (): Promise<CodexConversationSocket> => {
    connections++;
    const socket: CodexConversationSocket = {
      onmessage: null,
      onclose: null,
      onerror: null,
      close() {
        closes++;
      },
      send(wire) {
        sends++;
        const id = `resp_${sends}`,
          body = JSON.parse(wire) as Record<string, unknown>;
        bodies.push(body);
        setTimeout(() => {
          socket.onmessage?.({
            data: JSON.stringify({ type: "response.created", response: { id } }),
          });
          socket.onmessage?.({
            data: JSON.stringify({
              type: "response.completed",
              response: {
                id,
                status: "completed",
                output: [
                  { type: "function_call", call_id: `call_${id}`, name: "lookup", arguments: "{}" },
                ],
              },
            }),
          });
        }, delay);
      },
    };
    return socket;
  };
  return { connect, bodies, counts: () => ({ connections, closes, sends }) };
}
function req(
  connect: CodexSocketRequest["connect"],
  body: Record<string, unknown>,
  thread = "one"
): CodexSocketRequest {
  return {
    url: "wss://synthetic.invalid/responses",
    headers: { authorization: "synthetic-token", "thread-id": thread },
    body,
    connect,
    reuse: true,
    encode,
    failure,
  };
}
const user = { role: "user", content: "lookup" };

test("same conversation reuses a socket and sends compatible tool continuation as a delta", async () => {
  const pool = new CodexConversationSocketPool();
  const f = fixture();
  const base = { model: "gpt-6.1-sol", tools: [{ name: "lookup" }], input: [user] };
  const first = await (await pool.request(req(f.connect, base))).text();
  assert.match(first, /response.completed/);
  const call = { type: "function_call", call_id: "call_resp_1", name: "lookup", arguments: "{}" };
  await (
    await pool.request(
      req(f.connect, {
        ...base,
        input: [user, call, { type: "function_call_output", call_id: call.call_id, output: "OK" }],
      })
    )
  ).text();
  assert.equal(f.counts().connections, 1);
  assert.equal(f.bodies[1].previous_response_id, "resp_1");
  assert.equal((f.bodies[1].input as unknown[]).length, 1);
  assert.equal(pool.stats().active, 0);
  pool.close();
});
test("instruction/tool/model changes, compaction and caller-owned previous IDs cannot reuse the baseline", () => {
  const body = { model: "gpt-6.1-sol", instructions: "original", input: [user], tools: [] };
  const state = commitCodexContinuation(body, { id: "r1", status: "completed", output: [] }, 10000);
  assert.ok(state);
  for (const change of [
    { model: "different" },
    { instructions: "changed" },
    { tools: [{ name: "other" }] },
    { input: [] },
    { previous_response_id: "caller" },
  ]) {
    const next = { ...body, input: [user, { role: "user", content: "next" }], ...change };
    assert.equal(prepareCodexContinuation(next, state).incremental, false);
  }
});
test("100 independent conversations isolate sockets and identities while tool turns reuse each one", async () => {
  const pool = new CodexConversationSocketPool();
  const f = fixture();
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const r = req(
        f.connect,
        { model: "gpt-6.1-sol", input: [{ role: "user", content: `agent_${i}` }] },
        `thread_${i}`
      );
      await (await pool.request(r)).text();
      await (await pool.request(r)).text();
    })
  );
  assert.deepEqual(f.counts(), { connections: 100, closes: 0, sends: 200 });
  pool.close();
});
test("a queued same-thread request can be cancelled without disrupting the active turn", async () => {
  const pool = new CodexConversationSocketPool();
  const f = fixture(30);
  const r = req(f.connect, { model: "model", input: [user] });
  const first = await pool.request(r);
  const abort = new AbortController();
  const queued = pool.request({ ...r, signal: abort.signal });
  abort.abort();
  await assert.rejects(queued, { name: "AbortError" });
  await first.text();
  assert.equal(f.counts().sends, 1);
  pool.close();
});
test("late handshake resolution is closed after cancellation", async () => {
  const pool = new CodexConversationSocketPool();
  let resolve!: (s: CodexConversationSocket) => void,
    closed = 0;
  const connecting = new Promise<CodexConversationSocket>((r) => (resolve = r));
  const abort = new AbortController();
  const response = pool.request({
    ...req(() => connecting, { input: [user] }),
    signal: abort.signal,
  });
  abort.abort();
  await assert.rejects(response, { name: "AbortError" });
  resolve({
    send() {},
    close() {
      closed++;
    },
    onmessage: null,
    onerror: null,
    onclose: null,
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(closed, 1);
  pool.close();
});
test("bounded idle/first-event timeout produces one explicit failure without success", async () => {
  const pool = new CodexConversationSocketPool({ firstEventTimeoutMs: 20 });
  const socket: CodexConversationSocket = {
    send() {},
    close() {},
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  const text = await (await pool.request(req(async () => socket, { input: [user] }))).text();
  assert.match(text, /first_event_timeout/);
  assert.equal((text.match(/response.failed/g) || []).length, 2);
  assert.doesNotMatch(text, /response.completed/);
  pool.close();
});
test("slow consumers cannot accumulate unbounded incoming frames", async () => {
  const pool = new CodexConversationSocketPool({ maxBufferedBytes: 300, maxFrameBytes: 10000 });
  let socket!: CodexConversationSocket;
  socket = {
    onmessage: null,
    onerror: null,
    onclose: null,
    close() {},
    send() {
      queueMicrotask(() => {
        for (let i = 0; i < 10; i++)
          socket.onmessage?.({
            data: JSON.stringify({ type: "response.output_text.delta", delta: "x".repeat(100) }),
          });
      });
    },
  };
  const text = await (await pool.request(req(async () => socket, { input: [user] }))).text();
  assert.match(text, /buffer_limit/);
  assert.ok(text.length < 1000);
  pool.close();
});
test("auth change creates a new session and native terminal error is not duplicated/replayed", async () => {
  const pool = new CodexConversationSocketPool();
  const f = fixture();
  const r = req(f.connect, { input: [user] });
  await (await pool.request(r)).text();
  await (await pool.request({ ...r, headers: { ...r.headers, authorization: "rotated" } })).text();
  assert.equal(f.counts().connections, 2);
  const errorSocket: CodexConversationSocket = {
    onmessage: null,
    onerror: null,
    onclose: null,
    close() {},
    send() {
      queueMicrotask(() =>
        errorSocket.onmessage?.({
          data: JSON.stringify({
            type: "response.failed",
            response: {
              id: "err",
              status: "failed",
              error: { code: "rate_limit_exceeded", message: "throttled" },
            },
          }),
        })
      );
    },
  };
  const text = await (
    await pool.request(req(async () => errorSocket, { input: [user] }, "error"))
  ).text();
  assert.equal((text.match(/response.failed/g) || []).length, 1);
  assert.match(text, /throttled/);
  pool.close();
});
