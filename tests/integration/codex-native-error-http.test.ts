import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fetch as clientFetch } from "undici";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-codex-error-http-"));
process.env.DATA_DIR = dataDir;
process.env.REQUIRE_API_KEY = "true";
process.env.API_KEY_SECRET = "synthetic-codex-error-signing-secret";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.APP_LOG_TO_FILE = "false";
process.env.APP_LOG_LEVEL = "error";
const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const apiKeys = await import("../../src/lib/db/apiKeys.ts");
const settings = await import("../../src/lib/db/settings.ts");
const route = await import("../../src/app/api/v1/responses/route.ts");
const { flushProxyLogsSync } = await import("../../src/lib/proxyLogger.ts");

test(
  "authenticated Responses HTTP retains native Codex throttling details and Retry-After",
  { timeout: 30000 },
  async () => {
    const originalFetch = globalThis.fetch;
    let bodyTouches = 0;
    let upstreamCalls = 0;
    const server = http.createServer(async (incoming, outgoing) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers))
          if (typeof value === "string") headers.set(name, value);
        const result = await route.POST(
          new Request("http://localhost/v1/responses", {
            method: "POST",
            headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
        outgoing.writeHead(result.status, Object.fromEntries(result.headers.entries()));
        outgoing.end(await result.text());
      } catch (error) {
        outgoing.writeHead(500);
        outgoing.end(String(error));
      }
    });
    try {
      await settings.updateSettings({
        requireLogin: false,
        compression: { enabled: false },
        resilienceSettings: {
          quotaPreflight: { enabled: false },
          waitForCooldown: { enabled: false },
        },
      });
      const connection = await providers.createProviderConnection({
        provider: "codex",
        authType: "oauth",
        name: "isolated-codex-error",
        accessToken: "synthetic",
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        isActive: true,
        testStatus: "active",
      });
      const key = await apiKeys.createApiKey("isolated-codex-error", "synthetic-machine");
      await apiKeys.updateApiKeyPermissions(key.id, { noLog: true, compressionEnabled: false });
      globalThis.fetch = async (url) => {
        // Background model/quota discovery is separate from generation retries.
        if (!String(url).includes("/responses")) return Response.json({});
        upstreamCalls++;
        const target = new Response('{"detail":"Too many concurrent requests. Retry later."}', {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "7" },
        });
        return new Proxy(target, {
          get(object, property) {
            if (property === "body") bodyTouches++;
            if (property === "text")
              return () => {
                if (bodyTouches) throw new Error("native body disturbed");
                return object.text();
              };
            const value = Reflect.get(object, property, object);
            return typeof value === "function" ? value.bind(object) : value;
          },
        });
      };
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const result = await clientFetch(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/responses`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${key.key}`,
            "x-omniroute-connection": connection.id,
          },
          body: JSON.stringify({
            model: "codex/gpt-6-luna-xhigh",
            instructions: "Reply OK",
            input: "OK",
            stream: true,
          }),
        }
      );
      const text = await result.text();
      assert.ok([200, 429].includes(result.status), text);
      if (result.status === 429) assert.equal(result.headers.get("retry-after"), "7", text);
      else {
        assert.ok(result.headers.get("content-type")?.includes("text/event-stream"), text);
        const events = text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)));
        const failed = events.find((event) => event.type === "response.failed");
        assert.ok(failed, "slow throttling must end with a terminal Responses failure");
        assert.match(failed.response.error.message, /Too many concurrent requests/);
        assert.equal(failed.retry_after_seconds, 7);
      }
      assert.match(text, /Too many concurrent requests/);
      assert.equal(bodyTouches, 0);
      assert.equal(
        upstreamCalls,
        1,
        "a rejected request must not trigger an immediate retry storm"
      );
    } finally {
      globalThis.fetch = originalFetch;
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      flushProxyLogsSync();
      core.closeDbInstance({ checkpointMode: null });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
);
