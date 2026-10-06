import http from "node:http";
const { GET, POST } = await import("../../src/app/api/canary-readiness/route.ts");
const server = http.createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) {
      chunks.push(Buffer.from(chunk));
      if (chunks.reduce((n, data) => n + data.length, 0) > 8192) {
        outgoing.writeHead(413);
        outgoing.end();
        return;
      }
    }
    const request = new Request(`http://127.0.0.1${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      ...(incoming.method === "POST" ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
    });
    const response = incoming.method === "POST" ? await POST(request) : await GET(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500);
    outgoing.end("fixture failure");
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  console.log(JSON.stringify({ port: address.port, pid: process.pid }));
});
process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
