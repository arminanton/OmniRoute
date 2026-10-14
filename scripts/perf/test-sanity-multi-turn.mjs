import { Agent, setGlobalDispatcher } from "undici";
import { getDeveloperScenario, getDeveloperTurnPrompt } from "./developer-scenarios.mjs";

const CLIENT_TIMEOUT_MS = parseInt(process.env.OMNIROUTE_CLIENT_TIMEOUT_MS || "300000", 10);

// Configure client dispatcher with high connection ceiling to avoid client-side socket bottlenecks
setGlobalDispatcher(
  new Agent({
    connections: 512,
    pipelining: 1,
    connectTimeout: 45000,
    headersTimeout: CLIENT_TIMEOUT_MS,
    bodyTimeout: CLIENT_TIMEOUT_MS,
  })
);

const ENDPOINT = process.env.OMNIROUTE_URL || "http://127.0.0.1:20129/v1/chat/completions";
const AUTH_KEY = process.env.OMNIROUTE_KEY || "sk-cef4c81993033beb-1e1c29-a1426079";
const MODEL = process.env.OMNIROUTE_MODEL || "cx/gpt-6-luna-high";
const CONCURRENCY = parseInt(process.argv[2] || process.env.OMNIROUTE_CONCURRENCY || "10", 10);
const TOTAL_TURNS = parseInt(process.argv[3] || process.env.OMNIROUTE_TURNS || "10", 10);
const USE_STREAM = process.env.OMNIROUTE_STREAM !== "false";
const STARTUP_JITTER_MAX = parseInt(process.env.OMNIROUTE_STARTUP_JITTER_MAX || "500", 10);
const THINK_TIME_MIN = parseInt(process.env.OMNIROUTE_THINK_TIME_MIN || "600", 10);
const THINK_TIME_MAX = parseInt(process.env.OMNIROUTE_THINK_TIME_MAX || "1800", 10);
const MAX_TOKENS = parseInt(process.env.OMNIROUTE_MAX_TOKENS || "250", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function consumeSseStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullContent = "";
  let reasoningContent = "";
  let chunkCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    chunkCount++;

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) continue;
      if (trimmed === "data: [DONE]") continue;
      if (trimmed.startsWith("data: ")) {
        try {
          const parsed = JSON.parse(trimmed.slice(6));
          const delta = parsed.choices?.[0]?.delta;
          if (delta) {
            if (delta.content) {
              fullContent += delta.content;
            }
            if (delta.reasoning_content) {
              reasoningContent += delta.reasoning_content;
            }
          }
        } catch {
          // ignore keepalive or malformed chunk
        }
      }
    }
  }

  return {
    content: fullContent.trim(),
    reasoning: reasoningContent.trim(),
    chunkCount,
  };
}

console.log(`================================================================`);
console.log(`Starting Realistic Developer Multi-Turn Benchmark`);
console.log(`Concurrency : ${CONCURRENCY} parallel agents`);
console.log(`Turns/agent : ${TOTAL_TURNS} consecutive project turns`);
console.log(`Total turns : ${CONCURRENCY * TOTAL_TURNS} requests`);
console.log(`Model       : ${MODEL}`);
console.log(`Mode        : ${USE_STREAM ? "SSE Streaming (stream: true)" : "Buffered JSON"}`);
console.log(`Tokens/turn : ${MAX_TOKENS}`);
console.log(`Endpoint    : ${ENDPOINT}`);
console.log(`================================================================\n`);

async function runAgentSession(id) {
  const scenario = getDeveloperScenario(id);
  const sessionId = `agent-${id}-${Date.now()}`;
  const startTime = Date.now();

  // Startup micro-jitter: realistic staggered launch across agents (50-500ms)
  const initialJitter = Math.floor(Math.random() * STARTUP_JITTER_MAX) + (id % 10) * 30;
  if (initialJitter > 0) {
    await sleep(initialJitter);
  }

  const messages = [
    {
      role: "system",
      content: "You are an expert software engineer. Provide clear, concise, and production-ready code with a brief explanation.",
    },
  ];

  const turnLatencies = [];
  let totalCharsReceived = 0;

  for (let turn = 0; turn < TOTAL_TURNS; turn++) {
    const turnPrompt = getDeveloperTurnPrompt(id, turn);
    messages.push({ role: "user", content: turnPrompt });

    const turnStart = Date.now();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${AUTH_KEY}`,
        "Content-Type": "application/json",
        "x-omniroute-session-id": sessionId,
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: MAX_TOKENS,
        stream: USE_STREAM,
      }),
    });

    let reply = "";
    if (USE_STREAM) {
      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Turn ${turn + 1}/${TOTAL_TURNS} failed for [${scenario.topic}]: HTTP ${res.status} -> ${errorText}`);
      }
      const streamResult = await consumeSseStream(res);
      reply = streamResult.content || streamResult.reasoning || "(empty reply)";
    } else {
      const data = await res.json();
      if (!res.ok) {
        throw new Error(`Turn ${turn + 1}/${TOTAL_TURNS} failed for [${scenario.topic}]: HTTP ${res.status} -> ${JSON.stringify(data)}`);
      }
      reply = data.choices?.[0]?.message?.content?.trim() || "";
    }

    const turnLatency = Date.now() - turnStart;
    turnLatencies.push(turnLatency);
    totalCharsReceived += reply.length;

    // Append assistant response to message history for conversation continuity
    messages.push({ role: "assistant", content: reply });

    // Realistic think time between turns (except after last turn)
    if (turn < TOTAL_TURNS - 1) {
      const thinkTime = THINK_TIME_MIN + Math.floor(Math.random() * (THINK_TIME_MAX - THINK_TIME_MIN));
      await sleep(thinkTime);
    }
  }

  const totalDuration = Date.now() - startTime;
  const avgTurnLatency = Math.round(turnLatencies.reduce((a, b) => a + b, 0) / turnLatencies.length);

  return {
    id,
    domain: scenario.domain,
    topic: scenario.topic,
    turnLatencies,
    avgTurnLatency,
    totalDuration,
    totalCharsReceived,
  };
}

async function main() {
  const start = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) => runAgentSession(i))
  );
  const wallDuration = Date.now() - start;

  let successCount = 0;
  let failureCount = 0;
  const allLatencies = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      successCount++;
      const val = r.value;
      for (const l of val.turnLatencies) {
        allLatencies.push(l);
      }
      console.log(
        `[Agent #${String(val.id).padStart(2, "0")}] [${val.domain.toUpperCase()}] ${val.topic}: ` +
        `Completed ${TOTAL_TURNS}/${TOTAL_TURNS} turns | AvgTurn=${val.avgTurnLatency}ms, ` +
        `Chars=${val.totalCharsReceived} | TotalSession=${(val.totalDuration / 1000).toFixed(1)}s`
      );
    } else {
      failureCount++;
      const err = r.reason;
      const detail = err?.cause ? `${err.message} (cause: ${err.cause?.message || err.cause})` : (err?.message || String(err));
      console.error(`[Agent Failure]:`, detail);
    }
  }

  allLatencies.sort((a, b) => a - b);
  const p50 = (arr) => arr[Math.floor(arr.length * 0.5)] || 0;
  const p95 = (arr) => arr[Math.floor(arr.length * 0.95)] || 0;
  const p99 = (arr) => arr[Math.floor(arr.length * 0.99)] || 0;

  console.log(`\n================================================================`);
  console.log(`Benchmark Complete`);
  console.log(`Agents Success : ${successCount}/${CONCURRENCY} (${((successCount / CONCURRENCY) * 100).toFixed(1)}%)`);
  console.log(`Turns Completed: ${successCount * TOTAL_TURNS}/${CONCURRENCY * TOTAL_TURNS}`);
  console.log(`Wall Duration  : ${(wallDuration / 1000).toFixed(2)}s`);
  if (allLatencies.length > 0) {
    console.log(`Turn Latency   : p50=${p50(allLatencies)}ms, p95=${p95(allLatencies)}ms, p99=${p99(allLatencies)}ms`);
  }
  console.log(`================================================================\n`);

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Fatal benchmark runner error:", err);
  process.exit(1);
});
