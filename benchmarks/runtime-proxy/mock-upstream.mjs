import http from "node:http";

const port = Number(process.env.PORT || 3900);
const chunks = Number(process.env.CHUNKS || 50);
const delayMs = Number(process.env.CHUNK_DELAY_MS || 10);
const chunkData = "x".repeat(Number(process.env.CHUNK_BYTES || 128));
let activeStreams = 0;

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, activeStreams }));
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    response.writeHead(404);
    response.end();
    return;
  }

  request.resume();
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  activeStreams++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeStreams--;
  };
  let index = 0;
  const timer = setInterval(() => {
    if (response.destroyed) {
      clearInterval(timer);
      release();
      return;
    }
    if (index >= chunks) {
      clearInterval(timer);
      response.end("data: [DONE]\n\n");
      release();
      return;
    }
    response.write(`data: {"type":"response.output_text.delta","index":${index},"delta":"${chunkData}"}\n\n`);
    index++;
  }, delayMs);
  response.on("close", () => {
    clearInterval(timer);
    release();
  });
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock upstream listening on 127.0.0.1:${port}\n`);
});
