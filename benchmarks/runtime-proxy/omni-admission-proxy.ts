#!/usr/bin/env node
/**
 * Minimal HTTP host around OmniRoute's production chat admission wrapper.
 * The handler parses the admitted body and returns deterministic local SSE;
 * no provider, database account lookup, prompt logging, or model is invoked.
 */
import http from "node:http";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-admission-proxy-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.on("exit", () => fs.rmSync(dataDir, { recursive: true, force: true }));

const originalConsoleLog = console.log;
console.log = () => {};
const [
  { withChatAdmission },
  { perConnectionAdmissionController },
  { resolveIngestByteBudget },
] = await Promise.all([
  import("../../src/shared/middleware/withChatAdmission.ts"),
  import("../../src/shared/middleware/chatBodyAdmission.ts"),
  import("../../src/shared/middleware/admissionBudget.ts"),
]);
console.log = originalConsoleLog;

const port = Number(process.env.PORT || 3901);
const chunks = Number(process.env.CHUNKS || 20);
const delayMs = Number(process.env.CHUNK_DELAY_MS || 3);
const chunkData = "x".repeat(Number(process.env.CHUNK_BYTES || 128));
const encoder = new TextEncoder();

function makeSseResponse() {
  let index = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = () => {
          if (index >= chunks) {
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
            return;
          }
          controller.enqueue(
            encoder.encode(
              `data: {"type":"response.output_text.delta","index":${index},"delta":"${chunkData}"}\n\n`
            )
          );
          index += 1;
          timer = setTimeout(emit, delayMs);
        };
        emit();
      },
      cancel() {
        if (timer) clearTimeout(timer);
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } }
  );
}

const admittedHandler = withChatAdmission(async (request) => {
  await request.json();
  return makeSseResponse();
});

const server = http.createServer(async (incoming, outgoing) => {
  const url = new URL(incoming.url || "/", `http://${incoming.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/health") {
    const memory = process.memoryUsage();
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(
      JSON.stringify({
        ok: true,
        pid: process.pid,
        memory: {
          rss: memory.rss,
          heapUsed: memory.heapUsed,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
        },
        ingestBudget: resolveIngestByteBudget(),
        admission: perConnectionAdmissionController.snapshot(),
      })
    );
    return;
  }
  if (incoming.method !== "POST" || url.pathname !== "/v1/responses") {
    outgoing.writeHead(404);
    outgoing.end();
    return;
  }

  const abort = new AbortController();
  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  incoming.on("aborted", () => abort.abort());
  outgoing.on("close", () => {
    if (!outgoing.writableEnded) {
      abort.abort();
      if (bodyReader) void bodyReader.cancel("client disconnected").catch(() => undefined);
    }
  });

  try {
    const headers = new Headers();
    for (const name of [
      "content-type",
      "content-length",
      "authorization",
      "x-api-key",
      "x-request-id",
      "x-correlation-id",
      "x-omniroute-session-id",
    ]) {
      const value = incoming.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const request = new Request(`http://omniroute.test${url.pathname}${url.search}`, {
      method: incoming.method,
      headers,
      body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
      signal: abort.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await admittedHandler(request);
    const responseHeaders: Record<string, string> = {};
    for (const name of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    outgoing.writeHead(response.status, responseHeaders);
    if (!response.body) {
      outgoing.end();
      return;
    }

    bodyReader = response.body.getReader();
    while (!abort.signal.aborted) {
      const next = await bodyReader.read();
      if (next.done) break;
      if (!outgoing.write(Buffer.from(next.value))) {
        await new Promise<void>((resolve) => outgoing.once("drain", resolve));
      }
    }
    if (!outgoing.writableEnded) outgoing.end();
  } catch (error) {
    if (!outgoing.headersSent) {
      outgoing.writeHead(502, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: { message: "admission benchmark handler failed" } }));
    } else if (!outgoing.destroyed) outgoing.destroy(error as Error);
  } finally {
    bodyReader?.releaseLock();
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`OmniRoute chat-admission benchmark listening on 127.0.0.1:${port}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  const forceClose = setTimeout(() => process.exit(1), 2_000);
  forceClose.unref();
});
