import { Agent, setGlobalDispatcher } from "undici";

// Configure client dispatcher so local fetch doesn't bottleneck on socket limits
setGlobalDispatcher(
  new Agent({
    connections: 256,
    pipelining: 1,
    connectTimeout: 30000,
    headersTimeout: 120000,
    bodyTimeout: 120000,
  })
);

const ENDPOINT = process.env.OMNIROUTE_URL || "http://127.0.0.1:20129/v1/chat/completions";
const AUTH_KEY = process.env.OMNIROUTE_KEY || "sk-cef4c81993033beb-1e1c29-a1426079";
const MODEL = process.env.OMNIROUTE_MODEL || "agy/gemini-3.8-flash-high";
const CONCURRENCY = parseInt(process.argv[2] || "5", 10);

console.log(`Starting sanity test: ${CONCURRENCY} parallel multi-turn conversations...`);

async function runConversation(id) {
  const startTime = Date.now();
  const a = id + 1;
  const b = 10;
  const expectedSum = a + b;

  // Turn 1
  const t1Start = Date.now();
  const turn1Res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AUTH_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "user", content: `Question: What is ${a} + ${b}? Reply with ONLY the number.` }
      ],
      max_tokens: 30,
    }),
  });
  const t1Latency = Date.now() - t1Start;
  const t1Data = await turn1Res.json();
  if (!turn1Res.ok) {
    throw new Error(`Turn 1 failed: HTTP ${turn1Res.status}: ${JSON.stringify(t1Data)}`);
  }
  const reply1 = t1Data.choices?.[0]?.message?.content?.trim();

  // Turn 2
  const t2Start = Date.now();
  const c = 2;
  const turn2Res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${AUTH_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "user", content: `Question: What is ${a} + ${b}? Reply with ONLY the number.` },
        { role: "assistant", content: reply1 },
        { role: "user", content: `Multiply that by ${c}. Reply with ONLY the number.` }
      ],
      max_tokens: 30,
    }),
  });
  const t2Latency = Date.now() - t2Start;
  const t2Data = await turn2Res.json();
  if (!turn2Res.ok) {
    throw new Error(`Turn 2 failed: HTTP ${turn2Res.status}: ${JSON.stringify(t2Data)}`);
  }
  const reply2 = t2Data.choices?.[0]?.message?.content?.trim();
  const totalDuration = Date.now() - startTime;

  return {
    id,
    ok: true,
    t1Latency,
    t2Latency,
    totalDuration,
    reply1,
    reply2,
  };
}

async function main() {
  const start = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: CONCURRENCY }, (_, i) => runConversation(i))
  );
  const duration = Date.now() - start;

  let successCount = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      successCount++;
      console.log(`Conv #${r.value.id}: T1=${r.value.t1Latency}ms (reply: "${r.value.reply1}"), T2=${r.value.t2Latency}ms (reply: "${r.value.reply2}") Total=${r.value.totalDuration}ms`);
    } else {
      console.error(`Conv failed:`, r.reason);
    }
  }

  console.log(`Finished ${successCount}/${CONCURRENCY} conversations in ${(duration / 1000).toFixed(2)}s`);
}

main().catch(console.error);
