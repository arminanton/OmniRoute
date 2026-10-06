import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { fetch as clientFetch } from "undici";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-antigravity-parallel-e2e-"));
process.env.DATA_DIR = dataDir;
process.env.REQUIRE_API_KEY = "true";
process.env.API_KEY_SECRET = "synthetic-antigravity-e2e-signing-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.APP_LOG_LEVEL = "error";
process.env.OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS = "8";
process.env.ANTIGRAVITY_CREDITS = "never";
// Leave the background quota timer outside this isolated test lifetime.
process.env.PROVIDER_LIMITS_POST_USAGE_REFRESH_DELAY_MS = "3600000";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const settings = await import("../../src/lib/db/settings.ts");
const { getExecutor } = await import("../../open-sse/executors/index.ts");
const route = await import("../../src/app/api/v1/chat/completions/route.ts");
const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");
const versions = await import("../../open-sse/services/antigravityVersion.ts");

async function bodyOf(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test(
  "authenticated Antigravity HTTP isolates 1/30/70/100 conversations and tool signatures",
  { timeout: 120000 },
  async () => {
    const identities = new Map<string, string>();
    const phases = new Map<string, string[]>();
    let received = 0;
    const errors: string[] = [];
    const profiles = new Set<string>();
    const upstream = http.createServer(async (incoming, outgoing) => {
      try {
        const body = await bodyOf(incoming);
        const request = body.request as {
          sessionId: string;
          contents: Array<{
            parts: Array<{
              text?: string;
              functionCall?: Record<string, unknown>;
              functionResponse?: Record<string, unknown>;
              thoughtSignature?: string;
            }>;
          }>;
        };
        const parts = request.contents.flatMap((c) => c.parts);
        const session = parts
          .find((p) => typeof p.text === "string" && p.text.startsWith("session:"))
          ?.text?.slice(8);
        assert.ok(session);
        const previous = identities.get(session);
        if (previous)
          assert.equal(
            request.sessionId,
            previous,
            "native session must remain stable through tool turn"
          );
        else {
          assert.ok(![...identities.values()].includes(request.sessionId));
          identities.set(session, request.sessionId);
        }
        profiles.add(String(incoming.headers["user-agent"]).includes("/cli/") ? "cli" : "ide");
        const toolResponse = parts.find((p) => p.functionResponse);
        const phase = toolResponse ? "answer" : "tool";
        phases.set(session, [...(phases.get(session) ?? []), phase]);
        received++;
        if (toolResponse) {
          const call = parts.find((p) => p.functionCall);
          assert.equal(call?.thoughtSignature, `signature:${session}`);
          assert.ok(JSON.stringify(toolResponse).includes(`result:${session}`));
        }
        const part = toolResponse
          ? { text: `done:${session}` }
          : {
              functionCall: { id: "same-native-id", name: "lookup", args: { session } },
              thoughtSignature: `signature:${session}`,
            };
        outgoing.writeHead(200, { "content-type": "text/event-stream" });
        // Exercise fragmented frames, not only whole JSON payloads.
        const frame = `data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [part] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 } } })}\n\n`;
        outgoing.write(frame.slice(0, 19));
        const timer = setTimeout(() => {
          outgoing.write(frame.slice(19));
          outgoing.end("data: [DONE]\n\n");
        }, 30);
        outgoing.on("close", () => clearTimeout(timer));
      } catch (error) {
        errors.push(String(error));
        outgoing.writeHead(500);
        outgoing.end('{"error":{"message":"synthetic upstream contract failed"}}');
      }
    });
    const gateway = http.createServer(async (incoming, outgoing) => {
      try {
        const body = await bodyOf(incoming);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (typeof value === "string") headers.set(name, value);
        const response = await route.POST(
          new Request(
            `http://127.0.0.1:${(gateway.address() as { port: number }).port}/v1/chat/completions`,
            { method: "POST", headers, body: JSON.stringify(body) }
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
      } catch (error) {
        errors.push(String(error));
        outgoing.writeHead(500);
        outgoing.end('{"error":{"message":"isolated gateway test failed"}}');
      }
    });
    let restoreUrl = () => {};
    try {
      versions.seedAntigravityIdeVersionCache("2.5.5-test");
      versions.seedAntigravityCliVersionCache("1.2.16-test");
      await settings.updateSettings({
        requireLogin: false,
        sessionAffinityTtlMs: 60000,
        compression: { enabled: false },
        resilienceSettings: {
          quotaPreflight: { enabled: false },
          requestQueue: {
            autoEnableApiKeyProviders: false,
            globalConcurrentRequests: 0,
            maxWaitMs: 90000,
            maxQueueDepth: 256,
          },
        },
      });
      for (const profile of ["cli", "ide"])
        await providers.createProviderConnection({
          provider: "antigravity",
          authType: "oauth",
          name: `isolated-${profile}`,
          accessToken: `synthetic-${profile}`,
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          isActive: true,
          testStatus: "active",
          providerSpecificData: { projectId: "synthetic-project", clientProfile: profile },
        });
      const key = await apiKeys.createApiKey("isolated-antigravity-http", "synthetic-test-machine");
      await apiKeys.updateApiKeyPermissions(key.id, { noLog: true, compressionEnabled: false });
      const upstreamUrl = await listen(upstream),
        gatewayUrl = await listen(gateway);
      const executor = await getExecutor("antigravity");
      const originalUrl = executor.buildUrl;
      restoreUrl = () => {
        executor.buildUrl = originalUrl;
      };
      executor.buildUrl = () => `${upstreamUrl}/generate`;
      const tools = [
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
      ];
      async function turn(session: string, messages: unknown[], stream: boolean) {
        const response = await clientFetch(`${gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          signal: AbortSignal.timeout(30000),
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key.key}`,
            "x-omniroute-session-id": session,
          },
          body: JSON.stringify({ model: "antigravity/gemini-2.5-flash", stream, messages, tools }),
        });
        const text = await response.text();
        assert.equal(response.status, 200, text.slice(0, 500) + errors.join("\n"));
        if (!stream) return JSON.parse(text).choices[0].message;
        const calls = new Map<
          number,
          { id: string; type: string; function: { name: string; arguments: string } }
        >();
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
        return {
          content: content || null,
          ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
        };
      }
      for (const count of [1, 30, 70, 100]) {
        await Promise.all(
          Array.from({ length: count }, async (_, i) => {
            const session = `conversation-${count}-${i}`,
              user = { role: "user", content: `session:${session}` };
            const first = await turn(session, [user], i % 2 === 0);
            assert.deepEqual(JSON.parse(first.tool_calls[0].function.arguments), { session });
            const second = await turn(
              session,
              [
                user,
                { role: "assistant", ...first },
                {
                  role: "tool",
                  tool_call_id: first.tool_calls[0].id,
                  content: `result:${session}`,
                },
              ],
              i % 2 === 0
            );
            assert.equal(second.content, `done:${session}`);
            assert.deepEqual(phases.get(session), ["tool", "answer"]);
          })
        );
        console.log(
          `ANTIGRAVITY_PARALLEL_HTTP conversations=${count} tool_roundtrips=${count} passed`
        );
      }
      assert.equal(received, 402);
      assert.deepEqual(errors, []);
      assert.deepEqual([...profiles].sort(), ["cli", "ide"]);
    } finally {
      restoreUrl();
      for (const server of [gateway, upstream]) {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await new Promise((resolve) => setImmediate(resolve));
      flushProxyLogsSync();
      core.closeDbInstance({ checkpointMode: null });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
);
