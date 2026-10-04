import type { CDPSession, Page } from "playwright";
import { parseGeminiWebAccountModels, type GeminiWebAccountModel } from "./accountModels.ts";

export const GEMINI_ACCOUNT_CATALOG_MAX_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const CAPTURE_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 500;
const CATALOG_RPC = "uqlm3e";
const UNSUPPORTED_RPC = "otAQ7b";
const CATALOG_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute";

export type GeminiWebAccountCatalog = {
  models: GeminiWebAccountModel[];
  unsupportedRpcIds: string[];
};

type PausedResponse = {
  requestId: string;
  request: { url: string };
  responseStatusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
};

type CaptureErrorCode = "too_large" | "timeout" | "unavailable" | "invalid" | "capture_aborted";
export class GeminiWebAccountCatalogError extends Error {
  constructor(readonly code: CaptureErrorCode) {
    super(
      code === "too_large"
        ? "Gemini Web account model catalog exceeds 2 MiB"
        : code === "timeout"
          ? "Gemini Web account model catalog capture timed out"
          : code === "unavailable"
            ? "Gemini Web account model catalog unavailable"
            : code === "capture_aborted"
              ? "Gemini Web account model catalog capture aborted"
              : "Invalid Gemini Web account model response"
    );
    this.name = "GeminiWebAccountCatalogError";
  }
}

function rpcIdsForUrl(rawUrl: string): string[] {
  try {
    const url = new URL(rawUrl);
    if (
      url.origin !== "https://gemini.google.com" ||
      url.pathname !== new URL(CATALOG_URL).pathname
    )
      return [];
    return url.searchParams
      .getAll("rpcids")
      .flatMap((value) => value.split(","))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function bytesInChunk(data: string, base64Encoded: boolean): number {
  if (!base64Encoded) return Buffer.byteLength(data, "utf8");
  if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw new GeminiWebAccountCatalogError("invalid");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new GeminiWebAccountCatalogError("timeout"));
    }, timeoutMs);
    const onAbort = () => {
      cleanup();
      reject(new GeminiWebAccountCatalogError("capture_aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

async function boundedSend<T>(
  session: CDPSession,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = COMMAND_TIMEOUT_MS
): Promise<T> {
  return withTimeout(
    session.send(method as never, params as never) as Promise<T>,
    timeoutMs
  );
}

async function closeStream(session: CDPSession, handle: string): Promise<void> {
  try {
    await boundedSend(session, "IO.close", { handle });
  } catch {
    // Closing is best effort; request cancellation below also tears down stream.
  }
}

async function readBoundedResponse(
  session: CDPSession,
  requestId: string,
  readTimeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const deadline = Date.now() + readTimeoutMs;
  let handle: string | undefined;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    const stream = await withTimeout(
      session.send("Fetch.takeResponseBodyAsStream" as never, { requestId } as never) as Promise<{
        stream: string;
      }>,
      Math.max(1, deadline - Date.now()),
      signal
    );
    handle = stream.stream;
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new GeminiWebAccountCatalogError("timeout");
      const read = await withTimeout(
        session.send("IO.read" as never, {
          handle,
          size: Math.min(READ_CHUNK_BYTES, GEMINI_ACCOUNT_CATALOG_MAX_BYTES - totalBytes + 1),
        } as never) as Promise<{ data: string; eof: boolean; base64Encoded?: boolean }>,
        remainingMs,
        signal
      );
      const chunkBytes = bytesInChunk(read.data, read.base64Encoded === true);
      if (chunkBytes > GEMINI_ACCOUNT_CATALOG_MAX_BYTES - totalBytes)
        throw new GeminiWebAccountCatalogError("too_large");
      if (chunkBytes) {
        chunks.push(Buffer.from(read.data, read.base64Encoded ? "base64" : "utf8"));
        totalBytes += chunkBytes;
      }
      if (read.eof) break;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, totalBytes));
  } catch (error) {
    if (handle) await closeStream(session, handle);
    if (error instanceof GeminiWebAccountCatalogError) throw error;
    throw new GeminiWebAccountCatalogError("invalid");
  }
}

async function cancelPausedRequest(session: CDPSession, requestId: string): Promise<void> {
  try {
    await boundedSend(session, "Fetch.failRequest", { requestId, errorReason: "Aborted" });
  } catch {
    // Page is disposable; detach/close is final cancellation fallback.
  }
}

async function continuePausedResponse(session: CDPSession, requestId: string): Promise<void> {
  await boundedSend(session, "Fetch.continueResponse", { requestId });
}

export async function captureGeminiWebAccountCatalog(
  page: Page,
  session: CDPSession,
  timeoutMs = CAPTURE_TIMEOUT_MS,
  readTimeoutMs = READ_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<GeminiWebAccountCatalog> {
  let settled = false;
  let targetRequestId: string | undefined;
  let captureTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<Promise<void>>();
  let resolveResult!: (result: GeminiWebAccountCatalog) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<GeminiWebAccountCatalog>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const resolveOnce = (value: GeminiWebAccountCatalog) => {
    if (settled) return;
    settled = true;
    resolveResult(value);
  };
  const rejectOnce = (error: Error) => {
    if (settled) return;
    settled = true;
    rejectResult(error);
  };
  const onAbort = () => rejectOnce(new GeminiWebAccountCatalogError("capture_aborted"));
  const onPaused = (event: PausedResponse) => {
    const task = (async () => {
      const rpcIds = rpcIdsForUrl(event.request.url);
      if (!rpcIds.includes(CATALOG_RPC) || settled || targetRequestId) {
        try {
          await continuePausedResponse(session, event.requestId);
        } catch {
          await cancelPausedRequest(session, event.requestId);
        }
        return;
      }
      targetRequestId = event.requestId;
      const status = event.responseStatusCode;
      if (status !== undefined && (status < 200 || status >= 300)) {
        await cancelPausedRequest(session, event.requestId);
        rejectOnce(new GeminiWebAccountCatalogError("unavailable"));
        return;
      }
      try {
        const raw = await readBoundedResponse(session, event.requestId, readTimeoutMs, signal);
        // CDP stream extraction consumes the original response. This page is disposable.
        await cancelPausedRequest(session, event.requestId);
        const models = parseGeminiWebAccountModels(raw);
        resolveOnce({
          models,
          unsupportedRpcIds: rpcIds.includes(UNSUPPORTED_RPC) ? [UNSUPPORTED_RPC] : [],
        });
      } catch (error) {
        await cancelPausedRequest(session, event.requestId);
        rejectOnce(
          error instanceof GeminiWebAccountCatalogError
            ? error
            : new GeminiWebAccountCatalogError("invalid")
        );
      }
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
  };

  session.on("Fetch.requestPaused", onPaused);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    if (settled) throw new GeminiWebAccountCatalogError("capture_aborted");
    await withTimeout(
      session.send("Fetch.enable" as never, {
        patterns: [{ urlPattern: `${CATALOG_URL}*`, requestStage: "Response" }],
      } as never) as Promise<void>,
      COMMAND_TIMEOUT_MS,
      signal
    );
    captureTimer = setTimeout(() => {
      if (targetRequestId) void cancelPausedRequest(session, targetRequestId);
      rejectOnce(new GeminiWebAccountCatalogError("timeout"));
    }, timeoutMs);
    // No prompt or chat request is sent. Page load alone triggers catalog discovery.
    const navigation = page.goto("https://gemini.google.com/app", {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    void navigation.catch(() => rejectOnce(new GeminiWebAccountCatalogError("unavailable")));
    return await result;
  } catch (error) {
    if (error instanceof GeminiWebAccountCatalogError) throw error;
    throw new GeminiWebAccountCatalogError("unavailable");
  } finally {
    signal?.removeEventListener("abort", onAbort);
    session.off("Fetch.requestPaused", onPaused);
    if (captureTimer) clearTimeout(captureTimer);
    if (targetRequestId && (!settled || signal?.aborted))
      await cancelPausedRequest(session, targetRequestId);
    while (pending.size) await Promise.allSettled([...pending]);
    try {
      await boundedSend(session, "Fetch.disable", {});
    } catch {
      // Session detach below is the final cleanup path.
    } finally {
      try {
        await session.detach();
      } catch {
        // Page/target may already have closed.
      }
    }
  }
}
