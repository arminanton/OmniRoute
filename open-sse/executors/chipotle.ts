import { randomInt, randomUUID } from "node:crypto";

import { BaseExecutor, type ExecuteInput } from "./base.ts";
import type { ProviderCredentials } from "./base.ts";
import { sanitizeErrorMessage } from "../utils/error.ts";

const BASE_URL = "https://amelia.chipotle.com";
const DOMAIN_CODE = "chipotle";
const DOMAIN_ID = "23700760-e1e5-4c3c-931d-8804e29a6775";

// Exported for unit testing — these run at WS-connect time, so a missing
// node:crypto import (crypto.randomInt is NOT on the Web Crypto global) would
// otherwise only surface as a runtime crash deep in _connect().
export function randomServerId(): string {
  return String(randomInt(0, 1000)).padStart(3, "0");
}

export function randomSessionId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 32);
}

interface AmeliaSession {
  csrfToken: string;
  userId: string;
  cookieHeader: string;
}

export class AmeliaClient {
  private session: AmeliaSession | null = null;
  private ws: import("ws").WebSocket | null = null;
  private stompConnected = false;
  private messageCallbacks: Map<string, (msg: string) => void> = new Map();
  private connectPromise: Promise<void> | null = null;

  async init(signal?: AbortSignal | null): Promise<void> {
    const timeout = AbortSignal.timeout(15_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    requestSignal.throwIfAborted();
    const res = await fetch(`${BASE_URL}/Amelia/api/init`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        Origin: BASE_URL,
        Referer: `${BASE_URL}/Amelia/ui/chipotle/chat?embed=iframe`,
      },
      redirect: "manual",
      signal: requestSignal,
    });

    if (!res.ok) throw new Error(`Amelia init failed: ${res.status}`);

    const data = (await res.json()) as {
      csrfToken: string;
      user: { userId: string; anonymous: boolean };
    };

    const setCookies = res.headers.getSetCookie?.() ?? [];
    const cookieHeader = setCookies.map((c) => c.split(";")[0]).join("; ");

    this.session = {
      csrfToken: data.csrfToken,
      userId: data.user.userId,
      cookieHeader,
    };
  }

  async connect(signal?: AbortSignal | null): Promise<void> {
    if (!this.session) throw new Error("Call init() first");
    if (this.connectPromise !== null) return this.connectPromise;

    signal?.throwIfAborted();
    this.connectPromise = this._connect(signal);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  protected async openSocket(url: string): Promise<import("ws").WebSocket> {
    const { WebSocket } = await import("ws");
    return new WebSocket(url, {
      headers: {
        Cookie: this.session!.cookieHeader,
        Origin: BASE_URL,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
    });
  }

  private async _connect(signal?: AbortSignal | null): Promise<void> {
    const server = randomServerId();
    const sessionId = randomSessionId();
    const wsUrl = `wss://amelia.chipotle.com/Amelia/api/sock/${server}/${sessionId}/websocket`;
    const ws = await this.openSocket(wsUrl);
    this.ws = ws;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.stompConnected = false;
        this.ws = null;
        ws.terminate();
        reject(error);
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => fail(new DOMException("Aborted", "AbortError"));
      const timeout = setTimeout(() => fail(new Error("WS connect timeout")), 15_000);
      ws.on("message", (raw: Buffer | string) => {
        if (!settled) this.handleSockJSFrame(raw.toString(), succeed, fail, timeout);
        else if (this.stompConnected) {
          this.handleSockJSFrame(raw.toString(), succeed, fail, timeout);
        }
      });
      ws.on("error", fail);
      ws.on("close", () => {
        this.stompConnected = false;
        if (this.ws === ws) this.ws = null;
        fail(new Error("WebSocket closed before STOMP connection"));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private handleSockJSFrame(
    frame: string,
    resolveConnect: () => void,
    rejectConnect: (e: Error) => void,
    timeout: NodeJS.Timeout
  ): void {
    if (frame === "o") {
      this.sendSockJS(this.buildStompConnect());
      return;
    }
    if (frame === "h") return;
    if (frame.startsWith("a")) {
      try {
        const arr = JSON.parse(frame.slice(1)) as string[];
        for (const msg of arr) {
          this.handleStompFrame(msg, resolveConnect, rejectConnect, timeout);
        }
      } catch {
        // ignore
      }
    }
  }

  private handleStompFrame(
    frame: string,
    resolveConnect: () => void,
    rejectConnect: (e: Error) => void,
    timeout: NodeJS.Timeout
  ): void {
    const command = frame.split("\n")[0].replace(/\r$/, "");

    if (command === "CONNECTED") {
      this.stompConnected = true;
      this.sendSockJS(this.buildStompSubscribe(`/queue/session.${this.session!.userId}`, "sub-0"));
      this.sendSockJS(this.buildStompSubscribe("/user/queue/session", "sub-1"));
      clearTimeout(timeout);
      resolveConnect();
      return;
    }

    if (command === "MESSAGE") {
      this.handleStompMessage(frame);
      return;
    }

    if (command === "ERROR") {
      clearTimeout(timeout);
      rejectConnect(new Error(`STOMP ERROR: ${frame}`));
    }
  }

  private handleStompMessage(frame: string): void {
    const nullIdx = frame.indexOf("\0");
    let bodyStart = frame.indexOf("\n\n");
    if (bodyStart === -1) bodyStart = frame.indexOf("\r\n\r\n");
    const headerLen = bodyStart !== -1 ? (frame[bodyStart + 2] === "\r" ? 4 : 2) : 0;
    let body = "";
    if (bodyStart !== -1) {
      body = frame
        .substring(bodyStart + headerLen, nullIdx !== -1 ? nullIdx : undefined)
        .replace(/\0$/, "");
    }
    if (!body) return;

    let text = body;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (parsed.type === "message" && parsed.body) {
        const b = parsed.body as Record<string, unknown>;
        text = (b.text as string) || JSON.stringify(b);
      } else if (parsed.text) {
        text = parsed.text as string;
      } else if (parsed.message) {
        text = parsed.message as string;
      } else {
        return;
      }
    } catch {
      // plain text
    }

    for (const [id, cb] of this.messageCallbacks.entries()) {
      cb(text);
      this.messageCallbacks.delete(id);
    }
  }

  async chat(message: string, timeoutMs = 15_000, signal?: AbortSignal | null): Promise<string> {
    if (!this.stompConnected) {
      await this.init(signal);
      await this.connect(signal);
    }

    if (signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    const callbackId = crypto.randomUUID();

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.messageCallbacks.delete(callbackId);
        reject(new Error("Response timeout"));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        this.messageCallbacks.delete(callbackId);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.messageCallbacks.set(callbackId, (text) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(text);
      });

      const payload = JSON.stringify({
        message,
        domainCode: DOMAIN_CODE,
        conversationId: null,
        type: "text",
      });

      this.sendSockJS(this.buildStompSend("/app/send", payload));
    });
  }

  private buildStompConnect(): string {
    return `CONNECT\naccept-version:1.1,1.0\nheart-beat:0,0\nX-CSRF-TOKEN:${this.session!.csrfToken}\n\n\0`;
  }

  private buildStompSubscribe(destination: string, id: string): string {
    return `SUBSCRIBE\ndestination:${destination}\nid:${id}\n\n\0`;
  }

  private buildStompSend(destination: string, body: string): string {
    return `SEND\ndestination:${destination}\ncontent-type:application/json\ncontent-length:${Buffer.byteLength(body)}\n\n${body}\0`;
  }

  private sendSockJS(stompFrame: string): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error("WebSocket not open");
    }
    this.ws.send(JSON.stringify([stompFrame]));
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.stompConnected = false;
    this.session = null;
  }
}

// ── Client pool ──────────────────────────────────────────────────────────

const POOL_MAX = 5;
const pool: AmeliaClient[] = [];

async function getClient(signal?: AbortSignal | null): Promise<AmeliaClient> {
  if (pool.length > 0) return pool.pop()!;
  const client = new AmeliaClient();
  try {
    await client.init(signal);
    await client.connect(signal);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

function releaseClient(client: AmeliaClient): void {
  if (pool.length < POOL_MAX) {
    pool.push(client);
  } else {
    client.close().catch(() => {});
  }
}

// ── Executor ─────────────────────────────────────────────────────────────

export class ChipotleExecutor extends BaseExecutor {
  constructor() {
    super("chipotle", { format: "openai" });
  }

  buildUrl(_model: string, _stream: boolean): string {
    return `${BASE_URL}/Amelia/api/chat`;
  }

  buildHeaders(_credentials: ProviderCredentials): Record<string, string> {
    return { "Content-Type": "application/json" };
  }

  transformRequest(model: string, body: unknown, _stream: boolean): unknown {
    if (typeof body === "object" && body !== null) {
      return { ...(body as Record<string, unknown>), model };
    }
    return body;
  }

  async execute(input: ExecuteInput): Promise<{
    response: Response;
    url: string;
    headers: Record<string, string>;
    transformedBody: unknown;
  }> {
    const { model, stream, body, signal, log } = input;
    const encoder = new TextEncoder();

    if (signal?.aborted) {
      return {
        response: new Response(
          encoder.encode(
            JSON.stringify({
              error: {
                message: "Request aborted",
                type: "abort",
                code: "ABORTED",
              },
            })
          ),
          { status: 499, headers: { "Content-Type": "application/json" } }
        ),
        url: this.buildUrl(model, stream),
        headers: this.buildHeaders(input.credentials),
        transformedBody: body,
      };
    }

    const messages =
      (body as { messages?: Array<{ role: string; content: string }> })?.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const prompt = lastUser?.content ?? "";

    let client: AmeliaClient | null = null;
    try {
      client = await getClient(signal);
      log?.info?.("CHIPOTLE", `Sending to Pepper (model=${model})`);

      const responseText = await client.chat(prompt, 15_000, signal);
      releaseClient(client);
      client = null;

      const requestId = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        const sse = [
          `data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: responseText }, finish_reason: null }] })}`,
          `data: ${JSON.stringify({ id: requestId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
          "data: [DONE]",
          "",
        ].join("\n");

        return {
          response: new Response(encoder.encode(sse), {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
            },
          }),
          url: this.buildUrl(model, stream),
          headers: this.buildHeaders(input.credentials),
          transformedBody: body,
        };
      }

      const json = JSON.stringify({
        id: requestId,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: responseText },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });

      return {
        response: new Response(encoder.encode(json), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url: this.buildUrl(model, stream),
        headers: this.buildHeaders(input.credentials),
        transformedBody: body,
      };
    } catch (err) {
      if (client) client.close().catch(() => {});
      const aborted = signal?.aborted === true;
      const msg = aborted ? "Request aborted" : err instanceof Error ? err.message : String(err);
      log?.error?.("CHIPOTLE", `Error: ${msg}`);

      return {
        response: new Response(
          encoder.encode(
            JSON.stringify({
              error: {
                message: sanitizeErrorMessage(msg),
                type: aborted ? "abort" : "upstream_error",
                code: aborted ? "ABORTED" : "CHIPOTLE_ERROR",
              },
            })
          ),
          { status: aborted ? 499 : 502, headers: { "Content-Type": "application/json" } }
        ),
        url: this.buildUrl(model, stream),
        headers: this.buildHeaders(input.credentials),
        transformedBody: body,
      };
    }
  }
}

export default ChipotleExecutor;
