import { Agent, setGlobalDispatcher } from "undici";
import { getDeveloperScenario } from "./developer-scenarios.mjs";

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
const STARTUP_JITTER_MAX = parseInt(process.env.OMNIROUTE_STARTUP_JITTER_MAX || "500", 10);
const THINK_TIME_MIN = parseInt(process.env.OMNIROUTE_THINK_TIME_MIN || "800", 10);
const THINK_TIME_MAX = parseInt(process.env.OMNIROUTE_THINK_TIME_MAX || "2000", 10);
const MAX_TOKENS = parseInt(process.env.OMNIROUTE_MAX_TOKENS || "250", 10);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

console.log(`================================================================`);
console.log(`Starting Realistic Developer Multi-Turn Benchmark`);
console.log(`Concurrency : ${CONCURRENCY} parallel agents`);
console.log(`Model       : ${MODEL}`);
console.log(`Endpoint    : ${ENDPOINT}`);
console.log(`Tokens/turn : ${MAX_TOKENS}`);
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

  // -------------------------------------------------------------
  // Turn 1: Initial Engineering Task (Contextual Project Query)
  // -------------------------------------------------------------
  const t1Start = Date.now();
  const turn1Res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AUTH_KEY}`,
      "Content-Type": "application/json",
      "x-omniroute-session-id": sessionId,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: "You are an expert software engineer. Provide clear, concise, and production-ready code with a brief explanation.",
        },
        { role: "user", content: scenario.turn1 },
      ],
      max_tokens: MAX_TOKENS,
    }),
  });

  const t1Latency = Date.now() - t1Start;
  const t1Data = await turn1Res.json();
  if (!turn1Res.ok) {
    throw new Error(`Turn 1 failed for [${scenario.topic}]: HTTP ${turn1Res.status} -> ${JSON.stringify(t1Data)}`);
  }
  const reply1 = t1Data.choices?.[0]?.message?.content?.trim() || "";

  // -------------------------------------------------------------
  // Realistic Agent Think-Time / Tool-Processing Jitter between turns
  // -------------------------------------------------------------
  const thinkTime = THINK_TIME_MIN + Math.floor(Math.random() * (THINK_TIME_MAX - THINK_TIME_MIN));
  await sleep(thinkTime);

  // -------------------------------------------------------------
  // Turn 2: In-Depth Subject Continuation (Follow-up on same code)
  // -------------------------------------------------------------
  const t2Start = Date.now();
  const turn2Res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AUTH_KEY}`,
      "Content-Type": "application/json",
      "x-omniroute-session-id": sessionId,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: "You are an expert software engineer. Provide clear, concise, and production-ready code with a brief explanation.",
        },
        { role: "user", content: scenario.turn1 },
        { role: "assistant", content: reply1 },
        { role: "user", content: scenario.turn2 },
      ],
      max_tokens: MAX_TOKENS,
    }),
  });

  const t2Latency = Date.now() - t2Start;
  const t2Data = await turn2Res.json();
  if (!turn2Res.ok) {
    throw new Error(`Turn 2 failed for [${scenario.topic}]: HTTP ${turn2Res.status} -> ${JSON.stringify(t2Data)}`);
  }
  const reply2 = t2Data.choices?.[0]?.message?.content?.trim() || "";
  const totalDuration = Date.now() - startTime;

  return {
    id,
    domain: scenario.domain,
    topic: scenario.topic,
    t1Latency,
    t2Latency,
    thinkTime,
    totalDuration,
    reply1Length: reply1.length,
    reply2Length: reply2.length,
    reply1Sample: reply1.slice(0, 100).replace(/\n/g, " "),
    reply2Sample: reply2.slice(0, 100).replace(/\n/g, " "),
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
  const t1Latencies = [];
  const t2Latencies = [];

  for (const r of results) {
    if (r.status === "fulfilled") {
      successCount++;
      const val = r.value;
      t1Latencies.push(val.t1Latency);
      t2Latencies.push(val.t2Latency);
      console.log(
        `[Agent #${String(val.id).padStart(2, "0")}] [${val.domain.toUpperCase()}] ${val.topic}: ` +
        `T1=${val.t1Latency}ms (${val.reply1Length} chars), ` +
        `Think=${val.thinkTime}ms, ` +
        `T2=${val.t2Latency}ms (${val.reply2Length} chars) | Total=${val.totalDuration}ms`
      );
    } else {
      failureCount++;
      const err = r.reason;
      const detail = err?.cause ? `${err.message} (cause: ${err.cause?.message || err.cause})` : (err?.message || String(err));
      console.error(`[Agent Failure]:`, detail);
    }
  }

  t1Latencies.sort((a, b) => a - b);
  t2Latencies.sort((a, b) => a - b);

  const p50 = (arr) => arr[Math.floor(arr.length * 0.5)] || 0;
  const p95 = (arr) => arr[Math.floor(arr.length * 0.95)] || 0;
  const p99 = (arr) => arr[Math.floor(arr.length * 0.99)] || 0;

  console.log(`\n================================================================`);
  console.log(`Benchmark Complete`);
  console.log(`Success Rate : ${successCount}/${CONCURRENCY} (${((successCount / CONCURRENCY) * 100).toFixed(1)}%)`);
  console.log(`Wall Duration: ${(wallDuration / 1000).toFixed(2)}s`);
  if (successCount > 0) {
    console.log(`Turn 1 Latency: p50=${p50(t1Latencies)}ms, p95=${p95(t1Latencies)}ms, p99=${p99(t1Latencies)}ms`);
    console.log(`Turn 2 Latency: p50=${p50(t2Latencies)}ms, p95=${p95(t2Latencies)}ms, p99=${p99(t2Latencies)}ms`);
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
