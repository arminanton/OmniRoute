import http from "node:http";

const port = Number(process.env.PORT || 3900);
const apiPath = process.env.API_PATH || "/v1/responses";
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
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "gpt-4o-mini", object: "model", created: 0, owned_by: "benchmark" }],
      })
    );
    return;
  }
  if (request.method !== "POST" || request.url !== apiPath) {
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
      if (apiPath === "/v1/chat/completions") {
        response.end(
          "data: " +
            JSON.stringify({
              id: "chatcmpl-bench",
              object: "chat.completion.chunk",
              created: 0,
              model: "gpt-4o-mini",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            }) +
            "\n\ndata: [DONE]\n\n"
        );
      } else {
        response.end("data: [DONE]\n\n");
      }
      release();
      return;
    }
    if (apiPath === "/v1/chat/completions") {
      response.write(
        "data: " +
          JSON.stringify({
            id: "chatcmpl-bench",
            object: "chat.completion.chunk",
            created: 0,
            model: "gpt-4o-mini",
            choices: [{ index: 0, delta: { content: chunkData }, finish_reason: null }],
          }) +
          "\n\n"
      );
    } else {
      response.write(
        "data: " +
          JSON.stringify({
            type: "response.output_text.delta",
            index,
            delta: chunkData,
          }) +
          "\n\n"
      );
    }
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
