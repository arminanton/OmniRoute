import type { Dispatcher } from "undici";
import { createVerifiedHttp2Dispatcher } from "../proxyDispatcher.ts";
import { nonReplayableUpload } from "./nonReplayableUpload.ts";
import { SseCompletionAudit } from "./sseCompletionAudit.ts";
import { BoundedAdmission } from "./boundedAdmission.ts";

export interface ProviderHttp2Policy {
  verifiedOrigins: Readonly<Record<string, readonly string[]>>;
  maxConcurrentRequests?: number;
  maxQueuedRequests?: number;
  queueTimeoutMs?: number;
  /** Explicit TLS trust material only; normal certificate validation stays enabled. */
  ca?: string | Buffer;
  maxPools?: number;
  /** Required application completion markers for negotiated streaming protocols. */
  terminalEvents?: readonly string[];
  maxSseFrameBytes?: number;
}
export interface ProviderTransportContext {
  provider: string;
  hasApplicationProxy: boolean;
  requiresTlsFingerprint: boolean;
}

/** Opt-in H2 transport with native ALPN/H1 fallback, SETTINGS and connection lifecycle. */
export class ProviderHttp2Pool {
  private pools = new Map<string, { dispatcher: Dispatcher; admission: BoundedAdmission }>();
  private closed = false;
  constructor(private readonly policy: ProviderHttp2Policy) {}
  async fetch(
    url: string,
    init: RequestInit,
    context: ProviderTransportContext,
    fallback: (url: string, init: RequestInit) => Promise<Response>
  ): Promise<Response> {
    const parsed = new URL(url);
    const origin = parsed.origin;
    if (
      context.hasApplicationProxy ||
      context.requiresTlsFingerprint ||
      parsed.protocol !== "https:" ||
      !this.policy.terminalEvents?.length ||
      !this.policy.verifiedOrigins[context.provider]?.includes(origin)
    )
      return fallback(url, init);
    if (this.closed) throw new Error("HTTP/2 transport closed");
    const key = `${context.provider}:${origin}`;
    let pool = this.pools.get(key);
    if (!pool) {
      if (this.pools.size >= (this.policy.maxPools ?? 32)) return fallback(url, init);
      const concurrency = this.policy.maxConcurrentRequests ?? 16;
      pool = {
        dispatcher: createVerifiedHttp2Dispatcher(concurrency, this.policy.ca),
        admission: new BoundedAdmission(
          concurrency,
          this.policy.maxQueuedRequests ?? 128,
          this.policy.queueTimeoutMs ?? 30000
        ),
      };
      this.pools.set(key, pool);
    }
    const release = await pool.admission.acquire(init.signal);
    try {
      init.signal?.throwIfAborted();
      // Keep the existing URL/proxy/runtime guards and physical-attempt owner in the fetcher.
      const response = await fallback(url, {
        ...nonReplayableUpload(init),
        dispatcher: pool.dispatcher,
      } as RequestInit);
      if (!response.body) {
        release();
        return new Response(null, {
          status: response.status,
          headers: new Headers(response.headers),
        });
      }
      const audit =
        this.policy.terminalEvents?.length &&
        response.headers.get("content-type")?.toLowerCase().includes("text/event-stream")
          ? new SseCompletionAudit(this.policy.terminalEvents, this.policy.maxSseFrameBytes)
          : null;
      const lengthHeader = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      const expectedLength =
        lengthHeader && /^\d+$/.test(lengthHeader) && (!encoding || encoding === "identity")
          ? Number(lengthHeader)
          : null;
      let receivedBytes = 0;
      const reader = response.body.getReader();
      void reader.closed.then(release, release);
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                if (audit) audit.finish();
                else if (
                  expectedLength === null ||
                  !Number.isSafeInteger(expectedLength) ||
                  receivedBytes !== expectedLength
                )
                  throw new Error("HTTP/2 response lacked verified complete framing");
                release();
                controller.close();
              } else {
                receivedBytes += next.value.byteLength;
                audit?.write(next.value);
                controller.enqueue(next.value);
              }
            } catch (error) {
              await reader.cancel(error).catch(() => {});
              release();
              controller.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          },
        },
        { highWaterMark: 0 }
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    } catch (error) {
      release();
      throw error;
    }
  }
  stats() {
    return [...this.pools.entries()].map(([key, pool]) => ({ key, ...pool.admission.stats() }));
  }
  async close(force = false) {
    this.closed = true;
    for (const pool of this.pools.values()) pool.admission.close();
    await Promise.all(
      [...this.pools.values()].map((pool) =>
        force ? pool.dispatcher.destroy() : pool.dispatcher.close()
      )
    );
    this.pools.clear();
  }
}
