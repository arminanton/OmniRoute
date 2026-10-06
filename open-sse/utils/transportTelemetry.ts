import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type Closure = "eof" | "cancel" | "error" | "no_body";
type Transport = "http" | "websocket";
/** Timings are monotonic request-relative observations, not inferred network timings. */
export class TransportAttempt {
  readonly record = {
    transport: "http" as Transport,
    invokedMs: 0,
    queuedMs: null as number | null,
    dispatchedMs: null as number | null,
    headersMs: null as number | null,
    connectedMs: null as number | null,
    reused: null as boolean | null,
    firstByteMs: null as number | null,
    firstEventMs: null as number | null,
    bytes: 0,
    chunks: 0,
    maxObservedIdleMs: 0,
    status: null as number | null,
    closedMs: null as number | null,
    closure: null as Closure | null,
    dnsMs: null,
    tcpMs: null,
    tlsMs: null,
    uploadMs: null,
    requestSentMs: null as number | null,
    observedUploadBytes: 0,
  };
  private lastByte: number | null = null;
  private prefix = "";
  private data = false;
  private payload = false;
  private lineLength = 0;
  private cr = false;
  private decoder = new TextDecoder();
  constructor(
    private elapsed: () => number,
    transport: Transport
  ) {
    this.record.transport = transport;
    this.record.invokedMs = elapsed();
  }
  queued() {
    this.record.queuedMs ??= this.elapsed();
  }
  dispatched() {
    this.record.dispatchedMs ??= this.elapsed();
  }
  headers(status: number) {
    this.record.headersMs ??= this.elapsed();
    this.record.status = status;
  }
  connected(reused: boolean) {
    this.record.reused = reused;
    if (!reused) this.record.connectedMs ??= this.elapsed();
  }
  bodySent(length: number) {
    if (Number.isSafeInteger(length) && length >= 0) this.record.observedUploadBytes += length;
  }
  requestSent() {
    this.record.requestSentMs ??= this.elapsed();
  }
  firstEvent() {
    this.record.firstEventMs ??= this.elapsed();
  }
  chunk(bytes: Uint8Array, sse = false) {
    if (this.record.closure) return;
    this.bytes(bytes.byteLength);
    // SSE observation below never retains payload text.
    // Store only a five-character field prefix, never event bodies. An SSE comment
    // or incomplete data line does not count as a dispatched semantic event.
    if (sse && this.record.firstEventMs === null) {
      for (const char of this.decoder.decode(bytes, { stream: true })) {
        if (char === "\n" && this.cr) {
          this.cr = false;
          continue;
        }
        if (char === "\n" || char === "\r") {
          if (!this.lineLength && this.data) {
            this.firstEvent();
            return;
          }
          if (this.prefix.startsWith("data:") && this.payload) this.data = true;
          this.prefix = "";
          this.payload = false;
          this.lineLength = 0;
          this.cr = char === "\r";
        } else {
          this.cr = false;
          if (this.prefix.length < 5) this.prefix += char;
          if (this.lineLength >= 5 && !(this.lineLength === 5 && char === " ")) this.payload = true;
          this.lineLength = Math.min(7, this.lineLength + 1);
        }
      }
    }
  }
  bytes(length: number) {
    if (this.record.closure || !Number.isSafeInteger(length) || length <= 0) return;
    const at = this.elapsed();
    this.record.firstByteMs ??= at;
    if (this.lastByte !== null)
      this.record.maxObservedIdleMs = Math.max(this.record.maxObservedIdleMs, at - this.lastByte);
    this.lastByte = at;
    this.record.bytes += length;
    this.record.chunks++;
  }
  close(closure: Closure) {
    if (!this.record.closure) {
      this.record.closure = closure;
      this.record.closedMs = this.elapsed();
    }
  }
}

export class RequestTransportTelemetry {
  readonly id = randomUUID();
  private started: number;
  private attempts: TransportAttempt[] = [];
  private dropped = 0;
  private transportAdmissionWaitMs = 0;
  private transportAdmissionCount = 0;
  private admissionWaitMs = 0;
  private admissionCount = 0;
  private backoffMs = 0;
  private backoffCount = 0;
  private final: Closure | null = null;
  private forwardedBytes = 0;
  constructor(
    private clock = () => performance.now(),
    private sink = (snapshot: unknown) =>
      console.info("TRANSPORT_TELEMETRY", JSON.stringify(snapshot))
  ) {
    this.started = clock();
  }
  elapsed = () => Math.max(0, this.clock() - this.started);
  attempt(transport: Transport) {
    const attempt = new TransportAttempt(this.elapsed, transport);
    if (this.attempts.length < 24) this.attempts.push(attempt);
    else this.dropped++;
    return attempt;
  }
  wait(kind: "admission" | "backoff" | "transportAdmission") {
    const started = this.elapsed();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const ms = this.elapsed() - started;
      if (kind === "transportAdmission") {
        this.transportAdmissionCount++;
        this.transportAdmissionWaitMs += ms;
      } else if (kind === "admission") {
        this.admissionCount++;
        this.admissionWaitMs += ms;
      } else {
        this.backoffCount++;
        this.backoffMs += ms;
      }
    };
  }
  forward(bytes: number) {
    this.forwardedBytes += bytes;
  }
  snapshot() {
    return {
      schema: "omni-transport-telemetry/v1",
      id: this.id,
      elapsedMs: this.elapsed(),
      transportAdmissionWaitMs: this.transportAdmissionWaitMs,
      transportAdmissionCount: this.transportAdmissionCount,
      admissionWaitMs: this.admissionWaitMs,
      admissionCount: this.admissionCount,
      backoffMs: this.backoffMs,
      backoffCount: this.backoffCount,
      forwardedBytes: this.forwardedBytes,
      closure: this.final,
      droppedAttempts: this.dropped,
      attempts: this.attempts.map((a) => ({ ...a.record })),
    };
  }
  finish(closure: Closure) {
    if (this.final) return;
    this.final = closure;
    try {
      this.sink(this.snapshot());
    } catch {
      /* Telemetry cannot change request outcome. */
    }
  }
}
declare global {
  var __omniTransportTelemetry: AsyncLocalStorage<RequestTransportTelemetry> | undefined;
  var __omniTransportAttempt: AsyncLocalStorage<TransportAttempt> | undefined;
}
const requests = (globalThis.__omniTransportTelemetry ??=
  new AsyncLocalStorage<RequestTransportTelemetry>());
const attempts = (globalThis.__omniTransportAttempt ??= new AsyncLocalStorage<TransportAttempt>());
export const getRequestTransportTelemetry = () => requests.getStore();
export const getTransportAttempt = () => attempts.getStore();
export const runWithRequestTransportTelemetry = <T>(
  record: RequestTransportTelemetry,
  run: () => T
): T => requests.run(record, run);
export const runWithTransportAttempt = <T>(
  record: TransportAttempt | undefined,
  run: () => T
): T => (record ? attempts.run(record, run) : run());

/** Pull-owned byte tap: no cloning, no speculative read, exactly one cancellation owner. */
export function tapTelemetryBody(
  body: ReadableStream<Uint8Array>,
  chunk: (bytes: Uint8Array) => void,
  close: (reason: Closure) => void
) {
  const reader = body.getReader();
  let ended = false;
  const finish = (reason: Closure) => {
    if (ended) return;
    ended = true;
    close(reason);
    try {
      reader.releaseLock();
    } catch {}
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await reader.read();
          if (ended) return;
          if (next.done) {
            finish("eof");
            controller.close();
          } else {
            chunk(next.value);
            controller.enqueue(next.value);
          }
        } catch (error) {
          if (!ended) {
            finish("error");
            controller.error(error);
          }
        }
      },
      async cancel(reason) {
        if (ended) return;
        try {
          await reader.cancel(reason);
        } finally {
          finish("cancel");
        }
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 0 })
  );
}
