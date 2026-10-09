import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

const externalConfigPath = process.env.CODEX_CAPTURE_CLIENT_CONFIG_FILE;
const externalConfig = externalConfigPath
  ? JSON.parse(fs.readFileSync(externalConfigPath, "utf8"))
  : {};
const gatewayUrl = process.env.CODEX_GATEWAY_URL || externalConfig.gatewayUrl;
const apiKey = process.env.CODEX_TEST_API_KEY || externalConfig.apiKey;
const model = process.env.CODEX_TEST_MODEL || externalConfig.model || "codex/gpt-6.1-sol-medium";
const contextBytes = Math.max(
  0,
  Number(process.env.CODEX_CAPTURE_CONTEXT_BYTES ?? externalConfig.contextBytes) || 0
);
const contextEntropy =
  process.env.CODEX_CAPTURE_CONTEXT_ENTROPY || externalConfig.contextEntropy || "repeated";
const requestTimeoutMs = Number(process.env.CODEX_CAPTURE_REQUEST_TIMEOUT_MS) || 120_000;
const configuredPhases =
  process.env.CODEX_CAPTURE_PHASES ||
  (Array.isArray(externalConfig.phases) ? externalConfig.phases.join(",") : "1,30,70,100");
const sessionCounts = configuredPhases
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

if (!gatewayUrl || !apiKey)
  throw new Error("Codex test gateway URL and synthetic API key are required");
if (!["repeated", "random-base64"].includes(contextEntropy))
  throw new Error(`Unsupported Codex capture context entropy mode: ${contextEntropy}`);

function contextText() {
  if (contextEntropy === "random-base64") {
    return randomBytes(Math.ceil((contextBytes * 3) / 4))
      .toString("base64")
      .slice(0, contextBytes);
  }
  return "x".repeat(contextBytes);
}

function userMessage(sessionId, turnIndex, filler) {
  return {
    role: "user",
    content: `Historical request ${turnIndex} (${sessionId})\n${filler}`,
  };
}

function history(sessionId) {
  return [
    userMessage(sessionId, 1, contextText()),
    {
      role: "assistant",
      content: `Historical response 1 (${sessionId})\n${contextText()}`,
    },
    userMessage(sessionId, 2, contextText()),
    {
      role: "assistant",
      content: `Historical response 2 (${sessionId})\n${contextText()}`,
    },
    { role: "user", content: `Run lookup for ${sessionId}` },
  ];
}

function lookupTool() {
  return {
    type: "function",
    function: {
      name: "lookup",
      description: "Return a synthetic result from the local Codex benchmark provider.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  };
}

async function postChat(messages, sessionId) {
  const startedAt = performance.now();
  const response = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${apiKey}`,
      "x-session-id": sessionId,
      "x-codex-session-id": sessionId,
      "x-omniroute-session-id": sessionId,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: [lookupTool()],
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 64,
    }),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const firstBodyByteMs = performance.now() - startedAt;
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok) {
    const body = (await response.text()).slice(0, 800);
    throw new Error(`HTTP ${response.status} for ${sessionId}: ${body}`);
  }
  assert.match(contentType, /text\/event-stream/i, `unexpected content-type ${contentType}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`missing stream for ${sessionId}`);

  const events = [];
  const decoder = new TextDecoder();
  let pending = "";
  let reachedDone = false;
  while (!reachedDone) {
    const next = await reader.read();
    if (next.done) break;
    pending += decoder.decode(next.value, { stream: true });
    let boundary;
    while ((boundary = pending.indexOf("\n\n")) >= 0) {
      const frame = pending.slice(0, boundary).replace(/\r/g, "");
      pending = pending.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        reachedDone = true;
        break;
      }
      events.push(JSON.parse(data));
    }
  }
  await reader.cancel().catch(() => {});
  if (!reachedDone) throw new Error(`stream ended without [DONE] for ${sessionId}`);
  return {
    events,
    firstBodyByteMs,
    responseMs: performance.now() - startedAt,
  };
}

function collectToolCalls(events) {
  const calls = new Map();
  for (const event of events) {
    for (const choice of event.choices || []) {
      for (const patch of choice.delta?.tool_calls || []) {
        const index = Number(patch.index || 0);
        const call = calls.get(index) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (patch.id) call.id += patch.id;
        if (patch.type) call.type = patch.type;
        if (patch.function?.name) call.function.name += patch.function.name;
        if (patch.function?.arguments) call.function.arguments += patch.function.arguments;
        calls.set(index, call);
      }
    }
  }
  return [...calls.values()];
}

function collectText(events) {
  return events
    .flatMap((event) => event.choices || [])
    .map((choice) => choice.delta?.content || "")
    .join("");
}

async function runConversation(sessionId) {
  const messages = history(sessionId);
  const first = await postChat(messages, sessionId);
  const toolCall = collectToolCalls(first.events)[0];
  if (!toolCall?.id || toolCall.function?.name !== "lookup") {
    throw new Error(`Expected Codex lookup tool call for ${sessionId}`);
  }
  const second = await postChat(
    [
      ...messages,
      { role: "assistant", tool_calls: [toolCall] },
      {
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: JSON.stringify({ result: "synthetic local result" }),
      },
    ],
    sessionId
  );
  assert.match(collectText(second.events), /mocked Codex tool round-trip complete/);
  return {
    firstResponseMs: first.responseMs,
    secondResponseMs: second.responseMs,
    firstBodyByteMs: first.firstBodyByteMs,
    secondBodyByteMs: second.firstBodyByteMs,
  };
}

function percentile(samples, quantile) {
  const sorted = [...samples].sort((left, right) => left - right);
  return Number(sorted[Math.ceil(quantile * sorted.length) - 1].toFixed(2));
}

const phaseResults = [];
const responseDurations = [];
const firstBodyByteDurations = [];
for (const count of sessionCounts) {
  const startedAt = performance.now();
  const results = await Promise.all(
    Array.from({ length: count }, (_, index) => runConversation(`codex-${count}-${index}`))
  );
  const wallMs = performance.now() - startedAt;
  const roundTrips = results.map((result) => result.firstResponseMs + result.secondResponseMs);
  const firstBytes = results.flatMap((result) => [result.firstBodyByteMs, result.secondBodyByteMs]);
  phaseResults.push({
    conversations: count,
    completed: results.length,
    chatRequests: results.length * 2,
    wallMs: Number(wallMs.toFixed(2)),
    conversationsPerSecond: Number((results.length / (wallMs / 1000)).toFixed(2)),
    roundTripMsP50: percentile(roundTrips, 0.5),
    roundTripMsP95: percentile(roundTrips, 0.95),
    firstBodyByteMsP50: percentile(firstBytes, 0.5),
    firstBodyByteMsP95: percentile(firstBytes, 0.95),
  });
  responseDurations.push(...roundTrips);
  firstBodyByteDurations.push(...firstBytes);
  process.stderr.write(`CODEX_PARALLEL_HTTP conversations=${count} passed\n`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      benchmark: "codex-oauth-tool-roundtrip-http/v1",
      model,
      contextBytesPerHistoricalTurn: contextBytes,
      contextEntropy,
      phases: phaseResults,
      aggregate: {
        conversations: sessionCounts.reduce((sum, count) => sum + count, 0),
        chatRequests: sessionCounts.reduce((sum, count) => sum + count * 2, 0),
        roundTripMsP50: percentile(responseDurations, 0.5),
        roundTripMsP95: percentile(responseDurations, 0.95),
        firstBodyByteMsP50: percentile(firstBodyByteDurations, 0.5),
        firstBodyByteMsP95: percentile(firstBodyByteDurations, 0.95),
      },
      clientMemory: process.memoryUsage(),
    },
    null,
    2
  )}\n`
);
