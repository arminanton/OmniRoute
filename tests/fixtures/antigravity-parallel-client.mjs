import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { snapshotProcessMemory } from "./process-memory-snapshot.mjs";

const gatewayUrl = process.env.ANTIGRAVITY_GATEWAY_URL;
const apiKey = process.env.ANTIGRAVITY_TEST_API_KEY;
const captureContextBytes = Math.max(0, Number(process.env.ANTIGRAVITY_CAPTURE_CONTEXT_BYTES) || 0);
const requestTimeoutMs = Number(process.env.ANTIGRAVITY_CAPTURE_REQUEST_TIMEOUT_MS) || 30_000;
const captureMemoryBench = process.env.ANTIGRAVITY_CAPTURE_MEMORY_BENCH === "1";
const eventLoopDelay = captureMemoryBench ? monitorEventLoopDelay({ resolution: 20 }) : null;
eventLoopDelay?.enable();
const requestedSessionCounts = (process.env.ANTIGRAVITY_CAPTURE_SESSION_COUNTS || "")
  .split(",")
  .map(Number)
  .filter((count) => Number.isInteger(count) && count > 0);
const sessionCounts = requestedSessionCounts.length
  ? requestedSessionCounts
  : process.env.ANTIGRAVITY_CAPTURE_SINGLE_SESSION === "1"
    ? [1]
    : [1, 30, 70, 100];
if (!gatewayUrl || !apiKey) throw new Error("gateway URL and synthetic API key are required");

function userMessage(session, turnIndex) {
  if (captureContextBytes <= 0) return { role: "user", content: `session:${session}` };
  const context = randomBytes(Math.ceil((captureContextBytes * 3) / 4))
    .toString("base64url")
    .slice(0, captureContextBytes);
  return { role: "user", content: `session:${session}|turn:${turnIndex}\n${context}` };
}

async function turn(session, messages, stream, phaseSignal, turnNumber) {
  const bodyBuildStartedAt = performance.now();
  const body = JSON.stringify({
    model: "antigravity/gemini-2.5-flash",
    stream,
    messages,
    tools: [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
            properties: { session: { type: "string" } },
            required: ["session"],
          },
        },
      },
    ],
  });
  requestBodyBuildMs += performance.now() - bodyBuildStartedAt;
  requestsStarted++;
  maxClientRequestBytes = Math.max(maxClientRequestBytes, Buffer.byteLength(body));
  const startedAt = performance.now();
  const fetchStartedAtEpochMs = Date.now();
  let stage = "response_headers";
  try {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      signal: AbortSignal.any([phaseSignal, AbortSignal.timeout(requestTimeoutMs)]),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        "x-omniroute-session-id": session,
        "x-omniroute-fixture-started-at": String(fetchStartedAtEpochMs),
      },
      body,
    });
    responseHeadersReceived++;
    stage = "response_body";
    const text = await response.text();
    responseBodiesCompleted++;
    stage = "response_validation";
    assert.equal(response.status, 200, text.slice(0, 500));
    if (!stream) return JSON.parse(text).choices[0].message;

    const calls = new Map();
    let content = "";
    assert.ok(text.includes("[DONE]"), "stream must complete");
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      const event = JSON.parse(line.slice(5));
      assert.ok(!event.error, JSON.stringify(event));
      const delta = event.choices?.[0]?.delta;
      if (delta?.content) content += delta.content;
      for (const part of delta?.tool_calls ?? []) {
        const call = calls.get(part.index) ?? {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (part.id) call.id = part.id;
        if (part.function?.name) call.function.name = part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        calls.set(part.index, call);
      }
    }
    return { content: content || null, ...(calls.size ? { tool_calls: [...calls.values()] } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `conversation=${session} turn=${turnNumber} stage=${stage} elapsedMs=${Math.round(performance.now() - startedAt)}: ${message}`,
      { cause: error }
    );
  }
}

let completedRequests = 0;
let requestsStarted = 0;
let responseHeadersReceived = 0;
let responseBodiesCompleted = 0;
let requestBodyBuildMs = 0;
let taskConstructionMs = 0;
let maxClientRequestBytes = 0;
const startedAt = performance.now();
try {
  for (const count of sessionCounts) {
    const abort = new AbortController();
    const taskConstructionStartedAt = performance.now();
    const tasks = Array.from({ length: count }, async (_, index) => {
      try {
        const session = `conversation-${count}-${index}`;
        const messages = [];
        if (captureContextBytes > 0) {
          for (let turnIndex = 0; turnIndex < 4; turnIndex++) {
            messages.push(userMessage(session, turnIndex));
            messages.push({ role: "assistant", content: `previous-answer:${turnIndex}` });
          }
        }
        messages.push(userMessage(session, captureContextBytes > 0 ? 4 : 0));
        const first = await turn(session, messages, index % 2 === 0, abort.signal, 1);
        completedRequests++;
        assert.deepEqual(JSON.parse(first.tool_calls[0].function.arguments), { session });

        const second = await turn(
          session,
          [
            ...messages,
            { role: "assistant", ...first },
            { role: "tool", tool_call_id: first.tool_calls[0].id, content: `result:${session}` },
          ],
          index % 2 === 0,
          abort.signal,
          2
        );
        completedRequests++;
        assert.equal(second.content, `done:${session}`);
      } catch (error) {
        abort.abort(error);
        throw error;
      }
    });
    taskConstructionMs += performance.now() - taskConstructionStartedAt;
    const outcomes = await Promise.allSettled(tasks);
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed?.status === "rejected") {
      abort.abort(failed.reason);
      await Promise.allSettled(tasks);
      throw failed.reason;
    }
    process.stderr.write(`ANTIGRAVITY_PARALLEL_HTTP conversations=${count} passed\n`);
  }

  eventLoopDelay?.disable();
  if (captureMemoryBench) {
    process.stderr.write(
      `ANTIGRAVITY_CLIENT_DIAGNOSTICS ${JSON.stringify({
        requestsStarted,
        responseHeadersReceived,
        responseBodiesCompleted,
        completedRequests,
        requestBodyBuildMs: Math.round(requestBodyBuildMs),
        taskConstructionMs: Math.round(taskConstructionMs),
        eventLoopDelayMaxMs: Math.round((eventLoopDelay?.max ?? 0) / 1_000_000),
        eventLoopDelayP95Ms: Math.round((eventLoopDelay?.percentile(95) ?? 0) / 1_000_000),
      })}\n`
    );
  }
  process.stdout.write(
    JSON.stringify({
      completedRequests,
      maxClientRequestBytes,
      elapsedMs: Math.round(performance.now() - startedAt),
      clientRssBytes: process.memoryUsage().rss,
      ...(process.env.ANTIGRAVITY_CAPTURE_MEMORY_BENCH === "1"
        ? { processMemory: snapshotProcessMemory() }
        : {}),
      counts: sessionCounts,
    }) + "\n"
  );
} catch (error) {
  eventLoopDelay?.disable();
  if (captureMemoryBench) {
    process.stderr.write(
      `ANTIGRAVITY_CLIENT_DIAGNOSTICS ${JSON.stringify({
        requestsStarted,
        responseHeadersReceived,
        responseBodiesCompleted,
        completedRequests,
        requestBodyBuildMs: Math.round(requestBodyBuildMs),
        taskConstructionMs: Math.round(taskConstructionMs),
        pendingForHeaders: requestsStarted - responseHeadersReceived,
        pendingForBodies: responseHeadersReceived - responseBodiesCompleted,
        eventLoopDelayMaxMs: Math.round((eventLoopDelay?.max ?? 0) / 1_000_000),
        eventLoopDelayP95Ms: Math.round((eventLoopDelay?.percentile(95) ?? 0) / 1_000_000),
      })}\n`
    );
  }
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
}
