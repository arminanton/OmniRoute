import http from "node:http";
import { snapshotProcessMemory } from "./process-memory-snapshot.mjs";

const identities = new Map();
const phases = new Map();
const receivedAtBySession = new Map();
const completedAtBySession = new Map();
const profiles = new Set();
const errors = [];
let received = 0;
let egressProbes = 0;

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = http.createServer(async (incoming, outgoing) => {
  if (incoming.method === "GET" && incoming.url === "/__echo") {
    egressProbes++;
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ ip: "192.0.2.1" }));
    return;
  }

  if (incoming.method === "GET" && incoming.url === "/__stats") {
    outgoing.writeHead(200, { "content-type": "application/json" });
    outgoing.end(
      JSON.stringify({
        received,
        identities: Object.fromEntries(identities),
        phases: Object.fromEntries(phases),
        receivedAtBySession: Object.fromEntries(receivedAtBySession),
        completedAtBySession: Object.fromEntries(completedAtBySession),
        profiles: [...profiles].sort(),
        egressProbes,
        errors,
        processMemory:
          process.env.ANTIGRAVITY_CAPTURE_MEMORY_BENCH === "1"
            ? snapshotProcessMemory()
            : undefined,
      })
    );
    return;
  }

  try {
    const body = await bodyOf(incoming);
    const request = body.request;
    const parts = request.contents.flatMap((content) => content.parts);
    const sessionMarker = parts
      .filter((part) => typeof part.text === "string" && part.text.startsWith("session:"))
      .at(-1)?.text;
    const session = sessionMarker?.slice(8).split(/[|\n]/, 1)[0];
    if (!session) throw new Error("missing synthetic session marker");

    const priorSessionId = identities.get(session);
    if (priorSessionId && request.sessionId !== priorSessionId) {
      throw new Error(`native session changed during tool turn: ${session}`);
    }
    if (!priorSessionId) {
      if ([...identities.values()].includes(request.sessionId)) {
        throw new Error(`native session ID was shared across conversations: ${session}`);
      }
      identities.set(session, request.sessionId);
    }
    profiles.add(String(incoming.headers["user-agent"]).includes("/cli/") ? "cli" : "ide");

    const toolResponse = parts.find((part) => part.functionResponse);
    const phase = toolResponse ? "answer" : "tool";
    phases.set(session, [...(phases.get(session) ?? []), phase]);
    receivedAtBySession.set(session, [...(receivedAtBySession.get(session) ?? []), Date.now()]);
    if (toolResponse) {
      const call = parts.find((part) => part.functionCall);
      if (call?.thoughtSignature !== `signature:${session}`) {
        throw new Error(`thought signature was not preserved for ${session}`);
      }
      if (!JSON.stringify(toolResponse).includes(`result:${session}`)) {
        throw new Error(`tool result was not preserved for ${session}`);
      }
    }

    received++;
    const part = toolResponse
      ? { text: `done:${session}` }
      : {
          functionCall: { id: "same-native-id", name: "lookup", args: { session } },
          thoughtSignature: `signature:${session}`,
        };
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    const frame = `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 } } })}\n\n`;
    outgoing.write(frame.slice(0, 19));
    const timer = setTimeout(
      () => {
        outgoing.write(frame.slice(19));
        outgoing.end("data: [DONE]\n\n");
        completedAtBySession.set(session, [
          ...(completedAtBySession.get(session) ?? []),
          Date.now(),
        ]);
      },
      Number(process.env.ANTIGRAVITY_UPSTREAM_DELAY_MS) || 30
    );
    outgoing.on("close", () => clearTimeout(timer));
  } catch (error) {
    errors.push(String(error));
    outgoing.writeHead(500, { "content-type": "application/json" });
    outgoing.end(JSON.stringify({ error: { message: "synthetic upstream contract failed" } }));
  }
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`LISTENING http://127.0.0.1:${address.port}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
