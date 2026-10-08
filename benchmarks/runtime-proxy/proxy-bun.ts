const port = Number(Bun.env.PORT || 3901);
const upstreamUrl = Bun.env.UPSTREAM_URL || "http://127.0.0.1:3900";
const apiPath = Bun.env.API_PATH || "/v1/responses";
const maxInflight = Number(Bun.env.MAX_INFLIGHT || 128);
const maxBodyBytes = Number(Bun.env.MAX_BODY_BYTES || 4 * 1024 * 1024);
let active = 0;

function trackedBody(body: ReadableStream<Uint8Array> | null, onClose: () => void) {
  if (!body) {
    onClose();
    return null;
  }
  const reader = body.getReader();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    onClose();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
}

Bun.serve({
  port,
  hostname: "127.0.0.1",
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, active, limit: maxInflight });
    }
    if (request.method !== "POST" || url.pathname !== apiPath) {
      return new Response(null, { status: 404 });
    }
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
      return Response.json(
        { error: { message: "request body exceeds benchmark limit" } },
        { status: 413 }
      );
    }
    if (active >= maxInflight) {
      return Response.json(
        { error: { message: "proxy capacity reached" } },
        { status: 503, headers: { "retry-after": "1" } }
      );
    }

    active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
    };
    try {
      const upstream = await fetch(`${upstreamUrl}${url.pathname}${url.search}`, {
        method: request.method,
        headers: {
          "content-type": request.headers.get("content-type") || "application/json",
          ...(request.headers.has("x-request-id")
            ? { "x-request-id": request.headers.get("x-request-id")! }
            : {}),
        },
        body: request.body,
        duplex: "half",
        signal: request.signal,
      });
      const body = trackedBody(upstream.body, release);
      return new Response(body, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") || "application/octet-stream",
          ...(upstream.headers.has("cache-control")
            ? { "cache-control": upstream.headers.get("cache-control")! }
            : {}),
        },
      });
    } catch {
      release();
      return Response.json({ error: { message: "mock upstream unavailable" } }, { status: 502 });
    }
  },
});

process.stdout.write(`bun proxy listening on 127.0.0.1:${port}\n`);
