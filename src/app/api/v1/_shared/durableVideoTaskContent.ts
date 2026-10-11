import { acquireSharedSemaphore } from "@omniroute/open-sse/services/coordination/sharedSemaphore.ts";
import { releaseAccountRequestAfterResponseBody } from "@omniroute/open-sse/services/accountRequestLease.ts";
import type { FileRecord } from "@/lib/db/files";
import { CORS_HEADERS } from "@/shared/utils/cors";

const CONTENT_READ_KEY = "async-video-artifact-read";
const CONTENT_READ_MAX_CONCURRENCY = 2;
const CONTENT_CHUNK_BYTES = 64 * 1024;

/**
 * Acquire a cross-process content-read lease before materializing the private
 * SQLite BLOB. The lease remains held while the response is unread or being
 * drained, and is released on EOF, read failure, cancellation, or any setup
 * error. This bounds simultaneous full-size result buffers across replicas.
 */
export async function getLeasedDurableVideoTaskContentResponse(
  request: Request,
  loadFile: () => FileRecord | null
): Promise<Response | null> {
  let release: (() => void) | undefined;
  let responseOwnsLease = false;
  let sourceController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let response: Response | undefined;
  let leaseLostError: Error | undefined;
  let cleanedUp = false;
  let permitReleased = false;
  let content: Buffer | null = null;

  const cleanupListeners = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    request.signal.removeEventListener("abort", abortResponse);
  };
  const abortResponse = () => {
    const reason = request.signal.reason;
    const error = reason instanceof Error ? reason : new Error("video_task_content_client_aborted");
    leaseLostError = error;
    content = null;
    try {
      sourceController?.error(error);
    } catch {
      // The source may already be closed or cancelled.
    }
    void response?.body?.cancel(error).catch(() => {});
    releaseOnce();
  };
  const releaseOnce = () => {
    cleanupListeners();
    content = null;
    if (release && !permitReleased) {
      permitReleased = true;
      release();
    }
  };

  try {
    release = await acquireSharedSemaphore(
      [{ key: CONTENT_READ_KEY, maxConcurrency: CONTENT_READ_MAX_CONCURRENCY }],
      {
        timeoutMs: 30_000,
        signal: request.signal,
        onLeaseLost: (error) => {
          leaseLostError = error;
          content = null;
          try {
            sourceController?.error(error);
          } catch {
            // The source may already be closed or cancelled.
          }
          void response?.body?.cancel(error).catch(() => {});
          releaseOnce();
        },
      }
    );
    if (request.signal.aborted) throw request.signal.reason ?? new Error("Request aborted");

    // This may materialize a bounded (<=64 MiB) SQLite BLOB, so it must stay
    // after the shared permit acquisition.
    const file = loadFile();
    if (!file?.content) return null;
    content = file.content;
    const contentBytes = file.bytes;
    const contentType = file.mimeType || "video/mp4";
    const filename = file.filename;
    file.content = null;
    let offset = 0;

    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          sourceController = controller;
          if (leaseLostError) controller.error(leaseLostError);
          else if (request.signal.aborted) abortResponse();
          else request.signal.addEventListener("abort", abortResponse, { once: true });
        },
        pull(controller) {
          if (leaseLostError) {
            controller.error(leaseLostError);
            return;
          }
          const currentContent = content;
          if (!currentContent) {
            controller.error(leaseLostError ?? new Error("video_task_content_unavailable"));
            return;
          }
          if (offset >= currentContent.byteLength) {
            content = null;
            controller.close();
            return;
          }
          const end = Math.min(offset + CONTENT_CHUNK_BYTES, currentContent.byteLength);
          controller.enqueue(currentContent.subarray(offset, end));
          offset = end;
        },
        cancel() {
          content = null;
          releaseOnce();
        },
      },
      { highWaterMark: 1 }
    );

    const safeFilename = filename.replace(/[^\w.\-()[\] ]/g, "_").slice(0, 255);
    const rawResponse = new Response(body, {
      headers: {
        ...CORS_HEADERS,
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${safeFilename}"`,
        "Content-Length": String(contentBytes),
        "Cache-Control": "private, no-store",
      },
    });
    response = releaseAccountRequestAfterResponseBody(rawResponse, releaseOnce);
    responseOwnsLease = true;
    return response;
  } finally {
    if (!responseOwnsLease) releaseOnce();
  }
}
