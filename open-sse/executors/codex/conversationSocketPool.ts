import {
  getLogicalRetryBudget,
  LogicalRetryBudgetError,
  isLogicalRetryBudgetError,
  type LogicalRetryBudget,
} from "../../services/logicalRetryBudget.ts";
import { createHash } from "node:crypto";
import {
  prepareCodexContinuation,
  commitCodexContinuation,
  type CodexContinuationState,
} from "./deltaContinuation.ts";

export interface CodexConversationSocket {
  send(data: string): void | Promise<void>;
  close(code?: number, reason?: string): void;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  onclose: (() => void) | null;
  bufferedAmount?: number;
}
export type CodexConversationConnect = (
  url: string,
  options?: Record<string, unknown>
) => Promise<CodexConversationSocket>;
export interface CodexSocketOptions {
  maxSessions?: number;
  maxWaiters?: number;
  queueTimeoutMs?: number;
  connectTimeoutMs?: number;
  firstEventTimeoutMs?: number;
  idleTimeoutMs?: number;
  retentionMs?: number;
  maxBufferedBytes?: number;
  maxFrameBytes?: number;
  maxBaselineBytes?: number;
  maxTotalBaselineBytes?: number;
  maxSendBytes?: number;
}
interface ActiveTurn {
  frame(raw: string): void;
  fail(code: string): void;
}
interface Session {
  key: string;
  busy: boolean;
  socket: CodexConversationSocket | null;
  baseline: CodexContinuationState | null;
  active: ActiveTurn | null;
  lastResponseId: string | null;
  touched: number;
  wake: Set<() => void>;
}
export interface CodexSocketRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  connect: CodexConversationConnect;
  signal?: AbortSignal | null;
  reuse?: boolean;
  /** Trusted private principal/conversation scope; never derived solely from native headers. */
  ownerKey?: string | null;
  encode: (raw: string) => { sse: string; terminal: boolean };
  failure: (code: string) => string;
  beforeSend?: (wireBody: string) => Promise<void>;
  onSend?: () => void;
  onCompleted?: (response: Record<string, unknown>) => void;
  observe?: (event: {
    phase: string;
    elapsedMs: number;
    reused?: boolean;
    incremental?: boolean;
    bytes?: number;
  }) => void;
}

/** Private auth/conversation key; never expose it or bearer headers in diagnostics. */
function keyFor(request: CodexSocketRequest): string {
  const headers = Object.entries(request.headers)
    .map(([k, v]) => [k.toLowerCase(), v])
    .filter(([k]) => !["x-request-id", "x-client-request-id", "x-correlation-id"].includes(k))
    .sort();
  return createHash("sha256")
    .update(JSON.stringify([request.ownerKey ?? null, request.url, headers]))
    .digest("hex");
}
function abortReason(signal?: AbortSignal | null): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException("Request cancelled", "AbortError");
}
function bounded<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal | null,
  budget?: LogicalRetryBudget
): Promise<T> {
  const remaining = budget?.remainingTimeMs();
  const logicalWins = remaining !== undefined && remaining <= ms;
  ms = Math.max(1, Math.min(ms, remaining ?? ms));
  return new Promise((resolve, reject) => {
    let done = false;
    const end = (error: unknown, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve(value as T);
    };
    const timer = setTimeout(
      () =>
        end(
          logicalWins
            ? new LogicalRetryBudgetError("Logical pre-output deadline exhausted")
            : new Error("Codex transport phase timed out")
        ),
      ms
    );
    const aborted = () => end(abortReason(signal));
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
    promise.then(
      (v) => end(null, v),
      (e) => end(e)
    );
  });
}

/** One active response per conversation socket; separate conversations are independent. */
export class CodexConversationSocketPool {
  private sessions = new Map<string, Session>();
  private waiters = 0;
  private closed = false;
  private sweep: ReturnType<typeof setInterval>;
  private options: Required<CodexSocketOptions>;
  constructor(options: CodexSocketOptions = {}) {
    this.options = {
      maxSessions: 128,
      maxWaiters: 256,
      queueTimeoutMs: 90000,
      connectTimeoutMs: 30000,
      firstEventTimeoutMs: 120000,
      idleTimeoutMs: 300000,
      retentionMs: 300000,
      maxBufferedBytes: 8 * 1024 * 1024,
      maxFrameBytes: 4 * 1024 * 1024,
      maxBaselineBytes: 4 * 1024 * 1024,
      maxTotalBaselineBytes: 32 * 1024 * 1024,
      maxSendBytes: 16 * 1024 * 1024,
      ...options,
    };
    for (const value of Object.values(this.options))
      if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid Codex socket budget");
    this.sweep = setInterval(() => this.trim(), Math.min(this.options.retentionMs, 30000));
    this.sweep.unref?.();
  }
  private discard(session: Session): void {
    session.baseline = null;
    const socket = session.socket;
    session.socket = null;
    if (socket) {
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(1000, "conversation reset");
      } catch {
        /* Already closed. */
      }
    }
  }
  private trim(): void {
    const now = Date.now();
    for (const [key, s] of this.sessions)
      if (!s.busy && !s.wake.size && now - s.touched >= this.options.retentionMs) {
        this.discard(s);
        this.sessions.delete(key);
      }
    let bytes = [...this.sessions.values()].reduce((n, s) => n + (s.baseline?.bytes ?? 0), 0);
    for (const s of [...this.sessions.values()].sort((a, b) => a.touched - b.touched)) {
      if (bytes <= this.options.maxTotalBaselineBytes) break;
      bytes -= s.baseline?.bytes ?? 0;
      s.baseline = null;
    }
  }
  private async acquire(
    key: string,
    signal?: AbortSignal | null,
    budget?: LogicalRetryBudget
  ): Promise<Session> {
    if (this.closed) throw new Error("Codex socket pool is closed");
    if (signal?.aborted) throw abortReason(signal);
    this.trim();
    let session = this.sessions.get(key);
    if (!session) {
      if (this.sessions.size >= this.options.maxSessions) {
        const oldest = [...this.sessions.values()]
          .filter((s) => !s.busy && !s.wake.size)
          .sort((a, b) => a.touched - b.touched)[0];
        if (!oldest) throw new Error("Codex conversation socket capacity exhausted");
        this.discard(oldest);
        this.sessions.delete(oldest.key);
      }
      session = {
        key,
        busy: false,
        socket: null,
        baseline: null,
        active: null,
        lastResponseId: null,
        touched: Date.now(),
        wake: new Set(),
      };
      this.sessions.set(key, session);
    }
    const deadline = Date.now() + this.options.queueTimeoutMs;
    while (session.busy) {
      if (this.waiters >= this.options.maxWaiters)
        throw new Error("Codex conversation queue exhausted");
      this.waiters++;
      let wake: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        wake = resolve;
        session!.wake.add(wake);
      });
      try {
        await bounded(pending, Math.max(1, deadline - Date.now()), signal, budget);
      } finally {
        this.waiters--;
        session.wake.delete(wake);
      }
      if (this.closed) throw new Error("Codex socket pool is closed");
      if (Date.now() >= deadline) throw new Error("Codex conversation queue timed out");
    }
    session.busy = true;
    return session;
  }
  private release(session: Session): void {
    session.busy = false;
    session.active = null;
    session.touched = Date.now();
    for (const wake of session.wake) wake();
    this.trim();
  }
  async request(request: CodexSocketRequest): Promise<Response> {
    const started = Date.now();
    const budget = getLogicalRetryBudget();
    if (budget && budget.remainingTimeMs() <= 0)
      throw new LogicalRetryBudgetError("Logical pre-output deadline exhausted");
    const reusable = request.reuse === true && Boolean(request.ownerKey);
    const session = await this.acquire(
      reusable ? keyFor(request) : `${keyFor(request)}:${crypto.randomUUID()}`,
      request.signal,
      budget
    );
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.release(session);
      if (!reusable) {
        this.discard(session);
        this.sessions.delete(session.key);
      }
    };
    let socket = session.socket;
    try {
      if (budget && budget.remainingTimeMs() <= 0)
        throw new LogicalRetryBudgetError("Logical pre-output deadline exhausted");
      if (!socket) {
        const connecting = request.connect(request.url, {
          browser: "chrome_142",
          os: "windows",
          headers: request.headers,
        });
        let accepted = false;
        connecting.then(
          (s) => {
            if (!accepted && released)
              try {
                s.close(1000, "connection cancelled");
              } catch {}
          },
          () => {}
        );
        socket = await bounded(connecting, this.options.connectTimeoutMs, request.signal, budget);
        accepted = true;
        if (request.signal?.aborted) {
          socket.close(1000, "connection cancelled");
          throw abortReason(request.signal);
        }
        session.socket = socket;
        session.baseline = null;
        socket.onmessage = (event) => {
          let raw: string;
          try {
            if (typeof event.data === "string") raw = event.data;
            else if (event.data instanceof Uint8Array)
              raw = Buffer.from(event.data).toString("utf8");
            else if (event.data instanceof ArrayBuffer)
              raw = Buffer.from(event.data).toString("utf8");
            else {
              session.active?.fail("upstream_websocket_invalid_frame");
              return;
            }
          } catch {
            session.active?.fail("upstream_websocket_invalid_frame");
            return;
          }
          if (Buffer.byteLength(raw) > this.options.maxFrameBytes) {
            session.active?.fail("upstream_websocket_frame_limit");
            return;
          }
          session.active?.frame(raw);
        };
        socket.onerror = () => {
          if (session.active) session.active.fail("upstream_websocket_error");
          else this.discard(session);
        };
        socket.onclose = () => {
          session.socket = null;
          session.baseline = null;
          session.active?.fail("upstream_websocket_closed");
        };
        request.observe?.({ phase: "connected", elapsedMs: Date.now() - started, reused: false });
      } else
        request.observe?.({ phase: "connected", elapsedMs: Date.now() - started, reused: true });
      const fullBody = request.body;
      const prepared = prepareCodexContinuation(fullBody, reusable ? session.baseline : null);
      const wire = JSON.stringify({ type: "response.create", ...prepared.body });
      const encoder = new TextEncoder();
      let finished = false;
      let first = true;
      let expectedId: string | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let control: ReadableStreamDefaultController<Uint8Array>;
      const finish = (error: string | null, emitFailure = true) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        if (error) {
          this.discard(session);
          if (emitFailure)
            try {
              control.enqueue(encoder.encode(request.failure(error)));
            } catch {}
        }
        try {
          control.enqueue(encoder.encode("data: [DONE]\n\n"));
          control.close();
        } catch {}
        request.observe?.({
          phase: error ? "failed" : "completed",
          elapsedMs: Date.now() - started,
          incremental: prepared.incremental,
        });
        release();
      };
      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        const remaining = first ? budget?.remainingTimeMs() : undefined;
        const phaseMs = first ? this.options.firstEventTimeoutMs : this.options.idleTimeoutMs;
        const logicalWins = remaining !== undefined && remaining <= phaseMs;
        timer = setTimeout(
          () => {
            if (logicalWins) {
              const error = new LogicalRetryBudgetError("Logical pre-output deadline exhausted");
              budget?.denyFurtherAttempts(error);
              finish(error.code);
            } else
              finish(
                first ? "upstream_websocket_first_event_timeout" : "upstream_websocket_idle_timeout"
              );
          },
          Math.max(1, Math.min(phaseMs, remaining ?? phaseMs))
        );
      };
      const onAbort = () => finish("client_aborted");
      const stream = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            control = controller;
            session.active = {
              fail: (code) => finish(code),
              frame: (raw) => {
                if (finished) return;
                request.observe?.({
                  phase: "frame",
                  elapsedMs: Date.now() - started,
                  bytes: Buffer.byteLength(raw),
                });
                let data: Record<string, unknown> | null = null;
                try {
                  data = JSON.parse(raw) as Record<string, unknown>;
                } catch {}
                const response =
                  data?.response && typeof data.response === "object"
                    ? (data.response as Record<string, unknown>)
                    : null;
                const id =
                  typeof data?.response_id === "string"
                    ? data.response_id
                    : typeof response?.id === "string"
                      ? response.id
                      : null;
                if (id && id === session.lastResponseId && id !== expectedId) return;
                if (expectedId && id && id !== expectedId) {
                  finish("upstream_websocket_response_mismatch");
                  return;
                }
                if (data?.type === "response.created" && id) expectedId = id;
                const event = request.encode(raw);
                if (!event.sse) return;
                if (first) {
                  first = false;
                  request.observe?.({ phase: "first_event", elapsedMs: Date.now() - started });
                }
                resetTimer();
                const bytes = encoder.encode(event.sse);
                const queued = Math.max(0, 16384 - (controller.desiredSize ?? 0));
                if (queued + bytes.byteLength > this.options.maxBufferedBytes) {
                  finish("downstream_websocket_buffer_limit");
                  return;
                }
                controller.enqueue(bytes);
                if (event.terminal) {
                  if (data?.type === "response.completed" && response) {
                    request.onCompleted?.(response);
                    session.baseline = commitCodexContinuation(
                      fullBody,
                      response,
                      this.options.maxBaselineBytes
                    );
                    session.lastResponseId = typeof response.id === "string" ? response.id : null;
                    finish(null);
                  } else finish("upstream_websocket_failed", false);
                }
              },
            };
            request.signal?.addEventListener("abort", onAbort, { once: true });
          },
          cancel: () => {
            if (!finished) {
              finished = true;
              if (timer) clearTimeout(timer);
              request.signal?.removeEventListener("abort", onAbort);
              this.discard(session);
              request.observe?.({ phase: "cancelled", elapsedMs: Date.now() - started });
              release();
            }
          },
        },
        new ByteLengthQueuingStrategy({ highWaterMark: 16384 })
      );
      // Set callbacks before sending: a synchronous/mock response must not be lost.
      try {
        if (request.signal?.aborted) onAbort();
        else {
          await bounded(
            Promise.resolve(request.beforeSend?.(wire)),
            this.options.connectTimeoutMs,
            request.signal,
            budget
          );
          if (!finished) {
            if (
              typeof socket.bufferedAmount === "number" &&
              socket.bufferedAmount + Buffer.byteLength(wire) > this.options.maxSendBytes
            )
              finish("upstream_websocket_send_buffer_limit");
            else {
              if (budget && budget.remainingTimeMs() <= 0)
                throw new LogicalRetryBudgetError("Logical pre-output deadline exhausted");
              resetTimer();
              request.onSend?.();
              await bounded(
                Promise.resolve(socket.send(wire)),
                this.options.connectTimeoutMs,
                request.signal,
                budget
              );
            }
          }
        }
      } catch (error) {
        if (isLogicalRetryBudgetError(error)) {
          budget?.denyFurtherAttempts(error);
          finish(error.code);
        } else
          finish(request.signal?.aborted ? "client_aborted" : "upstream_websocket_send_failed");
      }
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    } catch (error) {
      this.discard(session);
      release();
      throw error;
    }
  }
  close(): void {
    this.closed = true;
    clearInterval(this.sweep);
    for (const s of this.sessions.values()) {
      s.active?.fail("upstream_websocket_pool_closed");
      this.discard(s);
      for (const wake of s.wake) wake();
    }
    this.sessions.clear();
  }
  stats(): { sessions: number; active: number; waiters: number; baselineBytes: number } {
    return {
      sessions: this.sessions.size,
      active: [...this.sessions.values()].filter((s) => s.busy).length,
      waiters: this.waiters,
      baselineBytes: [...this.sessions.values()].reduce((n, s) => n + (s.baseline?.bytes ?? 0), 0),
    };
  }
}
