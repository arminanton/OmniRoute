import { reserveAccountRequest } from "@omniroute/open-sse/services/accountRequestOccupancy.ts";

type AccountRequestCredentials =
  | {
      connectionId?: string | null;
      releaseAccountRequest?: () => void;
    }
  | null
  | undefined;

/** Use the reservation created during credential selection, with a defensive
 * fallback for synthetic/test credentials that carry only a connection id. */
export function reserveSelectedAccountRequest(credentials: AccountRequestCredentials): () => void {
  if (typeof credentials?.releaseAccountRequest === "function") {
    return credentials.releaseAccountRequest;
  }
  return reserveAccountRequest(credentials?.connectionId);
}

/** Keep an upstream request slot occupied while a streamed response is still
 * being delivered, releasing it on EOF, read failure, or downstream cancel. */
export function releaseAccountRequestAfterResponseBody(
  response: Response,
  release: () => void
): Response {
  if (!response.body) {
    release();
    return response;
  }

  const reader = response.body.getReader();
  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    release();
  };

  try {
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            releaseOnce();
          } else {
            controller.enqueue(chunk.value);
          }
        } catch (error) {
          releaseOnce();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          releaseOnce();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    releaseOnce();
    throw error;
  }
}
