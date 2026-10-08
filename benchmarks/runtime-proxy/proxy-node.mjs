import http from "node:http";
import { Readable } from "node:stream";

const port = Number(process.env.PORT || 3901);
const upstreamUrl = process.env.UPSTREAM_URL || "http://127.0.0.1:3900";
const maxInflight = Number(process.env.MAX_INFLIGHT || 128);
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 4 * 1024 * 1024);
const active = new Set();

const server = http.createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, active: active.size, limit: maxInflight }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404);
    response.end();
    return;
  }
  if (active.size >= maxInflight) {
    response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
    response.end('{"error":{"message":"proxy capacity reached"}}');
    request.resume();
    return;
  }
  const contentLength = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    response.writeHead(413, { "content-type": "application/json" });
    response.end('{"error":{"message":"request body exceeds benchmark limit"}}');
    request.resume();
    return;
  }

  const controller = new AbortController();
  active.add(response);
  response.on("close", () => {
    active.delete(response);
    if (!response.writableFinished) controller.abort();
  });
  request.on("aborted", () => controller.abort());

  try {
    const body = Readable.toWeb(request);
    const upstream = await fetch(`${upstreamUrl}${request.url}`, {
      method: request.method,
      headers: {
        "content-type": request.headers["content-type"] || "application/json",
        ...(request.headers["x-request-id"]
          ? { "x-request-id": request.headers["x-request-id"] }
          : {}),
      },
      body,
      duplex: "half",
      signal: controller.signal,
    });
    const headers = {
      "content-type": upstream.headers.get("content-type") || "application/octet-stream",
      ...(upstream.headers.get("cache-control")
        ? { "cache-control": upstream.headers.get("cache-control") }
        : {}),
      ...(upstream.headers.get("x-request-id")
        ? { "x-request-id": upstream.headers.get("x-request-id") }
        : {}),
    };
    response.writeHead(upstream.status, headers);
    if (!upstream.body) {
      response.end();
      return;
    }
    Readable.fromWeb(upstream.body).on("error", () => response.destroy()).pipe(response);
  } catch {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end('{"error":{"message":"mock upstream unavailable"}}');
    } else {
      response.destroy();
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`node proxy listening on 127.0.0.1:${port}\n`);
});
