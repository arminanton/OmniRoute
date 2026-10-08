#!/usr/bin/env node
/**
 * Exercise OmniRoute's real chat admission wrapper with independent, multi-turn
 * Responses-shaped sessions and a deterministic local SSE responder. This does
 * not load a Next production bundle or contact a provider; it measures body
 * parsing, process-local leases, and stream-lifetime release in production code.
 *
 * Run with: node --import tsx/esm benchmarks/runtime-proxy/chat-admission-sessions.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-admission-bench-"));
process.env.DATA_DIR = tempDataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.on("exit", () => fs.rmSync(tempDataDir, { recursive: true, force: true }));

const originalConsoleLog = console.log;
console.log = () => {};
const [{ ChatAdmissionController, defaultPressureSeverity }, { withChatAdmission }] =
  await Promise.all([
    import("../../src/shared/middleware/chatBodyAdmission.ts"),
    import("../../src/shared/middleware/withChatAdmission.ts"),
  ]);
console.log = originalConsoleLog;

function intArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const parsed = Number(process.argv[index + 1]);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

const clients = intArg("--clients", 100);
const rounds = intArg("--rounds", 5);
const contextBytes = intArg("--context-bytes", 65_536);
const streamChunks = intArg("--chunks", 20);
const chunkDelayMs = intArg("--chunk-delay-ms", 3);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_INFLIGHT_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();

function buildTurnBody(session: number, turn: number): string {
  const context = "x".repeat(contextBytes);
  const input: Array<Record<string, unknown>> = [];
  for (let step = 0; step < turn; step += 1) {
    input.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `agent ${session} step ${step} ${context}` }],
    });
    const callId = `tool-${session}-${step}`;
    input.push({ type: "function_call", call_id: callId, name: "inspect_workspace", arguments: "{}" });
    input.push({
      type: "function_call_output",
      call_id: callId,
      output: `synthetic tool result for step ${step}`,
    });
  }
  input.push({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: `agent ${session} step ${turn} ${context}` }],
  });
  return JSON.stringify({ model: "mock/model", stream: true, input });
}

function mockStream(): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = () => {
        if (index >= streamChunks) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode(
            `data: {"type":"response.output_text.delta","index":${index},"delta":"x"}\n\n`
          )
        );
        index += 1;
        timer = setTimeout(emit, chunkDelayMs);
      };
      emit();
    },
    cancel() {
      if (timer) clearTimeout(timer);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

const controller = new ChatAdmissionController(
  clients,
  MAX_INFLIGHT_BYTES,
  0,
  () => {},
  {
    maxInflightBytes: MAX_INFLIGHT_BYTES,
    budgetSource: "v8_heap",
    checkPressureSeverity: defaultPressureSeverity,
  }
);

const admittedHandler = withChatAdmission(
  async (request) => {
    // Parse the admitted body as the route would before entering chatCore.
    await request.json();
    return mockStream();
  },
  { controller, queueMs: 30_000, largeBodyBytes: 64 * 1024, hardMaxBytes: MAX_BODY_BYTES }
);

async function runTurn(session: number, turn: number) {
  const body = buildTurnBody(session, turn);
  const requestId = randomUUID();
  const request = new Request("http://omniroute.test/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "x-request-id": requestId,
      "x-omniroute-session-id": `bench-agent-${session}`,
    },
    body,
  });
  const started = performance.now();
  const response = await admittedHandler(request);
  if (response.status !== 200 || !response.body) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      status: response.status,
      requestBytes: Buffer.byteLength(body),
      elapsedMs: performance.now() - started,
      error: text.slice(0, 256),
    };
  }

  const reader = response.body.getReader();
  let outputBytes = 0;
  let firstChunkMs: number | null = null;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (firstChunkMs === null) firstChunkMs = performance.now() - started;
      outputBytes += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    ok: true,
    status: response.status,
    requestBytes: Buffer.byteLength(body),
    elapsedMs: performance.now() - started,
    firstChunkMs,
    outputBytes,
  };
}

async function runSession(session: number) {
  const turns = [];
  for (let turn = 0; turn < rounds; turn += 1) {
    const result = await runTurn(session, turn);
    turns.push(result);
    if (!result.ok) break;
  }
  return { ok: turns.length === rounds && turns.every((turn) => turn.ok), turns };
}

const peak = {
  rssBytes: process.memoryUsage().rss,
  heapUsedBytes: process.memoryUsage().heapUsed,
  activeHeavy: controller.activeHeavy,
  inflightBytes: controller.inflightBytes,
};
const sampler = setInterval(() => {
  const current = process.memoryUsage();
  peak.rssBytes = Math.max(peak.rssBytes, current.rss);
  peak.heapUsedBytes = Math.max(peak.heapUsedBytes, current.heapUsed);
  peak.activeHeavy = Math.max(peak.activeHeavy, controller.activeHeavy);
  peak.inflightBytes = Math.max(peak.inflightBytes, controller.inflightBytes);
}, 10);
const started = performance.now();
const sessions = await Promise.all(Array.from({ length: clients }, (_, session) => runSession(session)));
clearInterval(sampler);
const elapsedMs = performance.now() - started;
const turns = sessions.flatMap((session) => session.turns);
const sorted = (values: number[]) => values.slice().sort((a, b) => a - b);
const percentile = (values: number[], p: number) => {
  const ordered = sorted(values);
  return ordered.length ? Number(ordered[Math.min(ordered.length - 1, Math.floor(p * ordered.length))].toFixed(3)) : null;
};
const firstChunkTimes = turns
  .map((turn) => turn.firstChunkMs)
  .filter((value): value is number => typeof value === "number");
const failures = turns.filter((turn) => !turn.ok);
const result = {
  runtime: process.version,
  harness: "production ChatAdmissionController + withChatAdmission; local deterministic SSE handler",
  clients,
  roundsPerSession: rounds,
  sessionsCompleted: sessions.filter((session) => session.ok).length,
  turnsCompleted: turns.filter((turn) => turn.ok).length,
  turnsAttempted: turns.length,
  maxBodyBytes: Math.max(...turns.map((turn) => turn.requestBytes)),
  responseChunksPerTurn: streamChunks,
  chunkDelayMs,
  wallMs: Number(elapsedMs.toFixed(3)),
  turnsPerSecond: Number((turns.filter((turn) => turn.ok).length / (elapsedMs / 1000)).toFixed(3)),
  firstChunkP50Ms: percentile(firstChunkTimes, 0.5),
  firstChunkP95Ms: percentile(firstChunkTimes, 0.95),
  completionP50Ms: percentile(turns.filter((turn) => turn.ok).map((turn) => turn.elapsedMs), 0.5),
  completionP95Ms: percentile(turns.filter((turn) => turn.ok).map((turn) => turn.elapsedMs), 0.95),
  peakRssMiB: Number((peak.rssBytes / (1024 * 1024)).toFixed(3)),
  peakHeapUsedMiB: Number((peak.heapUsedBytes / (1024 * 1024)).toFixed(3)),
  peakActiveHeavy: peak.activeHeavy,
  peakInflightBytes: peak.inflightBytes,
  controller: {
    activeHeavyAfter: controller.activeHeavy,
    activeHealthyHeadroomAfter: controller.activeHealthyHeadroom,
    inflightBytesAfter: controller.inflightBytes,
    maxInflightBytes: controller.maxInflightBytes,
    shedTotal: controller.shedTotal,
  },
  failures: failures.slice(0, 5),
};
console.log(JSON.stringify(result));
if (sessions.some((session) => !session.ok) || controller.activeHeavy !== 0 || controller.inflightBytes !== 0) {
  process.exitCode = 1;
}
