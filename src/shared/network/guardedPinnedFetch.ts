import { isIP } from "node:net";
import {
  resolveHostnameAddresses,
  defaultDnsLookup,
  type DnsLookup,
  type DnsLookupResult,
} from "./dnsPinnedFetch";
import {
  OutboundUrlGuardError,
  type OutboundUrlGuardMode,
  parseAndValidatePublicUrl,
  parseAndValidateNonMetadataUrl,
  parseOutboundUrl,
} from "./outboundUrlGuard";

export function validateGuardedUrl(input: string | URL, guard: OutboundUrlGuardMode): URL {
  if (guard === "public-only") return parseAndValidatePublicUrl(input);
  if (guard === "block-metadata") return parseAndValidateNonMetadataUrl(input);
  return parseOutboundUrl(input);
}

/** One deadline covers policy resolution, DNS, every redirect and the complete body. */
export function createOutboundDeadline(signal: AbortSignal | undefined, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid outbound timeout");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Outbound request timed out", "TimeoutError")),
    timeoutMs
  );
  return {
    signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

/** DNS APIs and injected test transports need not implement AbortSignal themselves. */
export async function withOutboundAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  lateResult?: (value: T) => void
): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const pending = operation().then((value) => {
      if (signal.aborted) lateResult?.(value);
      return value;
    });
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function resolveGuardedAddresses(
  url: URL,
  guard: OutboundUrlGuardMode,
  signal: AbortSignal,
  lookup: DnsLookup = defaultDnsLookup
): Promise<DnsLookupResult[]> {
  validateGuardedUrl(url, guard);
  let addresses: DnsLookupResult[];
  try {
    addresses = await withOutboundAbort(
      () => resolveHostnameAddresses(url.hostname, lookup),
      signal
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new OutboundUrlGuardError("Outbound host could not be resolved (blocked)", {
      code: "OUTBOUND_URL_GUARD_BLOCKED",
      url: url.toString(),
      hostname: url.hostname,
    });
  }
  signal.throwIfAborted();
  if (!addresses.length) throw new Error("Empty DNS answer set (blocked)");
  for (const { address, family } of addresses) {
    if ((family !== 4 && family !== 6) || isIP(address) !== family || address.includes("%")) {
      throw new OutboundUrlGuardError("Invalid DNS answer (blocked)", {
        code: "OUTBOUND_URL_GUARD_BLOCKED",
        url: url.toString(),
        hostname: url.hostname,
      });
    }
    validateGuardedUrl(`http://${family === 6 ? `[${address}]` : address}/`, guard);
  }
  return addresses;
}

export function cancelOutboundBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

export async function readBoundedOutboundBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<Buffer<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    cancelOutboundBody(response);
    throw new Error("Invalid outbound byte limit");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    cancelOutboundBody(response);
    throw new Error(`Outbound response exceeds ${maxBytes} byte limit`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await withOutboundAbort(() => reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`Outbound response exceeds ${maxBytes} byte limit`);
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Keep the deadline/pin alive until EOF or cancellation without pre-reading diagnostics. */
export function boundOutboundResponse(
  response: Response,
  maxBytes: number,
  deadline: ReturnType<typeof createOutboundDeadline>
): Response {
  if (!response.body) {
    deadline.dispose();
    return response;
  }
  const reader = response.body.getReader();
  let bytes = 0;
  let finished = false;
  let onAbort: () => void;
  const finish = () => {
    if (finished) return;
    finished = true;
    deadline.dispose();
    deadline.signal.removeEventListener("abort", onAbort);
  };
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        onAbort = () => {
          if (finished) return;
          finish();
          void reader.cancel().catch(() => {});
          controller.error(deadline.signal.reason);
        };
        deadline.signal.addEventListener("abort", onAbort, { once: true });
        if (deadline.signal.aborted) onAbort();
      },
      async pull(controller) {
        try {
          const { done, value } = await withOutboundAbort(() => reader.read(), deadline.signal);
          if (finished) return;
          if (done) {
            finish();
            reader.releaseLock();
            controller.close();
            return;
          }
          bytes += value.byteLength;
          if (bytes > maxBytes) throw new Error(`Outbound response exceeds ${maxBytes} byte limit`);
          controller.enqueue(value);
        } catch (error) {
          if (finished) return;
          finish();
          void reader.cancel().catch(() => {});
          controller.error(error);
        }
      },
      cancel(reason) {
        finish();
        void reader.cancel(reason).catch(() => {});
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
