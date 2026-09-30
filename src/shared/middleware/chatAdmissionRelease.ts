import type { ChatAdmissionLease } from "./chatBodyAdmission";

type ReleaseChatAdmissionOptions = { signal?: AbortSignal | null };

/**
 * A pending handler still owns work after client abort. Wait for it to settle,
 * then cancel its late body before releasing. Never admit a replacement early.
 */
export async function releaseChatAdmissionAfterHandler(
  responsePromise: Promise<Response>,
  lease: ChatAdmissionLease | null,
  options: ReleaseChatAdmissionOptions = {}
): Promise<Response> {
  try {
    const response = await responsePromise;
    if (
      options.signal?.aborted &&
      response.body &&
      response.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await response.body.cancel(options.signal.reason).catch(() => undefined);
      lease?.release();
      return response;
    }
    return releaseChatAdmissionWhenDone(response, lease, options);
  } catch (error) {
    lease?.release();
    throw error;
  }
}

/** Hold capacity until SSE EOF/error or confirmed asynchronous cancellation. */
export function releaseChatAdmissionWhenDone(
  response: Response,
  lease: ChatAdmissionLease | null,
  options: ReleaseChatAdmissionOptions = {}
): Response {
  const { signal } = options;
  if (!lease && !signal) return response;
  const isStreaming = response.headers.get("content-type")?.includes("text/event-stream");
  if (!response.body || !isStreaming) {
    lease?.release();
    return response;
  }

  const reader = response.body.getReader();
  let settled = false;
  let cancelling = false;
  let cancellation: Promise<void> | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
    lease?.release();
  };
  const cancelSource = (reason: unknown): Promise<void> => {
    if (cancellation) return cancellation;
    if (settled) return Promise.resolve();
    // reader.cancel() resolves a pending read BEFORE its own cleanup promise.
    // The read completion must not release the lease ahead of that cleanup.
    cancelling = true;
    signal?.removeEventListener("abort", onAbort);
    cancellation = reader
      .cancel(reason)
      .catch(() => undefined)
      .then(() => {
        finish();
        try {
          streamController.close();
        } catch {
          /* already cancelled by the consumer */
        }
      });
    return cancellation;
  };
  const onAbort = () => {
    void cancelSource(signal?.reason);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (settled || cancelling) return;
      try {
        const { done, value } = await reader.read();
        if (settled || cancelling) return;
        if (done) {
          finish();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        if (settled || cancelling) return;
        finish();
        controller.error(error);
      }
    },
    cancel: cancelSource,
  });

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
