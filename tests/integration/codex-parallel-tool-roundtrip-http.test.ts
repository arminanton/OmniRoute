import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fetch as clientFetch } from "undici";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-codex-parallel-e2e-"));
process.env.DATA_DIR = dataDir;
process.env.REQUIRE_API_KEY = "true";
process.env.API_KEY_SECRET = "synthetic-parallel-e2e-signing-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
// Use the live response-start budget here. The separate transport regression
// uses a shortened budget to expose queueing deterministically.
process.env.OMNIROUTE_DIRECT_HEADERS_TIMEOUT_MS = "30000";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const settings = await import("../../src/lib/db/settings.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const route = await import("../../src/app/api/v1/responses/route.ts");

async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function writeEvent(response: http.ServerResponse, event: Record<string, unknown>) {
  response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function parseEvents(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test(
  "authenticated Responses HTTP isolates 1/30/70/100 concurrent conversations across tool round trips",
  { timeout: 120000 },
  async () => {
    const seen = new Map<string, string[]>();
    let received = 0;
    const upstream = http.createServer(async (incoming, outgoing) => {
      try {
        const body = await bodyOf(incoming);
        const session = String(body.prompt_cache_key);
        assert.match(session, /^conversation-\d+-\d+$/);
        const input = body.input as Array<Record<string, unknown>>;
        const toolResult = input.find((item) => item.type === "function_call_output");
        const phase = toolResult ? "answer" : "tool";
        const phases = seen.get(session) ?? [];
        phases.push(phase);
        seen.set(session, phases);
        received++;
        assert.equal(body.service_tier, "priority", "legacy priority must survive the full route");
        const item = toolResult
          ? {
              id: `msg_${session}`,
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: `done:${session}`, annotations: [] }],
            }
          : {
              id: `fc_${session}`,
              type: "function_call",
              name: "lookup",
              call_id: `call_${session}`,
              arguments: JSON.stringify({ session }),
            };
        if (toolResult) assert.equal(toolResult.output, `result:${session}`);
        const response = {
          id: `resp_${phase}_${session}`,
          object: "response",
          status: "in_progress",
          model: body.model,
          output: [],
        };
        outgoing.writeHead(200, { "content-type": "text/event-stream" });
        writeEvent(outgoing, { type: "response.created", response });
        const timer = setTimeout(() => {
          writeEvent(outgoing, { type: "response.output_item.added", output_index: 0, item });
          if (toolResult) {
            writeEvent(outgoing, {
              type: "response.output_text.delta",
              output_index: 0,
              content_index: 0,
              item_id: item.id,
              delta: `done:${session}`,
            });
          } else {
            writeEvent(outgoing, {
              type: "response.function_call_arguments.delta",
              output_index: 0,
              item_id: item.id,
              delta: JSON.stringify({ session }),
            });
          }
          writeEvent(outgoing, { type: "response.output_item.done", output_index: 0, item });
          writeEvent(outgoing, {
            type: "response.completed",
            response: {
              ...response,
              status: "completed",
              output: [item],
              usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
            },
          });
          outgoing.end();
        }, 1200);
        outgoing.on("close", () => clearTimeout(timer));
      } catch {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end('{"error":{"message":"synthetic upstream contract failed"}}');
      }
    });
    const gateway = http.createServer(async (incoming, outgoing) => {
      try {
        const body = await bodyOf(incoming);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (typeof value === "string") headers.set(name, value);
        }
        const response = await route.POST(
          new Request(
            `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/responses`,
            {
              method: "POST",
              headers,
              body: JSON.stringify(body),
            }
          )
        );
        outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
        if (response.body) {
          const reader = response.body.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              if (!outgoing.write(next.value)) await once(outgoing, "drain");
            }
          } finally {
            reader.releaseLock();
          }
        }
        outgoing.end();
      } catch {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end('{"error":{"message":"isolated gateway test failed"}}');
      }
    });
    let executor: Awaited<ReturnType<typeof getExecutor>> | undefined;
    let buildUrl: typeof executor.buildUrl | undefined;
    try {
      await settings.updateSettings({
        requireLogin: false,
        compression: { enabled: false },
        resilience: {
          quotaPreflight: { enabled: false },
          requestQueue: {
            autoEnableApiKeyProviders: false,
            globalConcurrentRequests: 0,
            maxWaitMs: 90000,
            maxQueueDepth: 256,
          },
        },
      });
      await providers.createProviderConnection({
        provider: "codex",
        authType: "oauth",
        name: "isolated-e2e",
        accessToken: "synthetic-codex-token",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        isActive: true,
        testStatus: "active",
        providerSpecificData: {},
      });
      const key = await apiKeys.createApiKey("isolated-http-test", "synthetic-test-machine");
      await apiKeys.updateApiKeyPermissions(key.id, { noLog: true, compressionEnabled: false });
      const upstreamUrl = await listen(upstream);
      const gatewayUrl = await listen(gateway);
      executor = await getExecutor("codex");
      buildUrl = executor.buildUrl;
      // Replace only the upstream address; the real executor, dispatcher, API-key
      // checks, translators, SSE parsing, and tool history processing still run.
      executor.buildUrl = () => `${upstreamUrl}/responses`;

      const tools = [
        {
          type: "function",
          name: "lookup",
          parameters: {
            type: "object",
            properties: { session: { type: "string" } },
            required: ["session"],
            additionalProperties: false,
          },
        },
      ];
      async function turn(session: string, input: Record<string, unknown>[]) {
        const response = await clientFetch(`${gatewayUrl}/v1/responses`, {
          method: "POST",
          signal: AbortSignal.timeout(30000),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key.key}`,
            "session-id": session,
          },
          body: JSON.stringify({
            model: "codex/gpt-5.6-sol",
            stream: true,
            service_tier: "priority",
            prompt_cache_key: session,
            input,
            tools,
          }),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text.slice(0, 500));
        const events = parseEvents(text);
        assert.ok(
          events.some((event) => event.type === "response.completed"),
          text.slice(0, 500)
        );
        assert.ok(!events.some((event) => event.type === "response.failed"));
        return events;
      }
      for (const count of [1, 30, 70, 100]) {
        const conversations = Array.from(
          { length: count },
          (_, index) => `conversation-${count}-${index}`
        );
        await Promise.all(
          conversations.map(async (session) => {
            const user = {
              role: "user",
              content: [{ type: "input_text", text: `lookup:${session}` }],
            };
            const first = await turn(session, [user]);
            const completed = first.find((event) => event.type === "response.completed")!
              .response as { output: Record<string, unknown>[] };
            const call = completed.output.find((item) => item.type === "function_call");
            assert.equal(call?.call_id, `call_${session}`);
            assert.deepEqual(JSON.parse(String(call?.arguments)), { session });
            const second = await turn(session, [
              user,
              call!,
              { type: "function_call_output", call_id: call!.call_id, output: `result:${session}` },
            ]);
            const answer = second.find((event) => event.type === "response.completed")!
              .response as { output: Array<{ content?: Array<{ text?: string }> }> };
            assert.equal(answer.output[0].content?.[0].text, `done:${session}`);
            assert.deepEqual(seen.get(session), ["tool", "answer"]);
          })
        );
        console.log(`CODEX_PARALLEL_E2E conversations=${count} tool_roundtrips=${count} passed`);
      }
      assert.equal(received, (1 + 30 + 70 + 100) * 2);
    } finally {
      if (executor && buildUrl) executor.buildUrl = buildUrl;
      for (const server of [gateway, upstream]) {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      core.closeDbInstance({ checkpointMode: null });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
);
