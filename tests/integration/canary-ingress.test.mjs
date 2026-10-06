import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { once } from "node:events";
import test from "node:test";
import { createIngress } from "../../scripts/deploy/canary/ingress.mjs";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}
function get(port, path = "/") {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => resolve(data));
        response.on("error", reject);
      })
      .on("error", reject);
  });
}

test("100 active streams, upload and WebSocket survive admission switch without replay", async (t) => {
  const releases = [];
  const calls = { old: 0, candidate: 0 };
  const seenHeaders = [];
  function backend(name) {
    const server = http.createServer((request, response) => {
      calls[name]++;
      seenHeaders.push(request.headers);
      if (request.url === "/stream") {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(`data: ${name}:first\n\n`);
        releases.push(() => response.end(`data: ${name}:last\n\n`));
      } else {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => response.end(name + body));
      }
    });
    const webSockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSocket.on("message", (bytes, binary) => webSocket.send(bytes, { binary }));
      });
    });
    return server;
  }
  const old = backend("old");
  const candidate = backend("candidate");
  const oldPort = await listen(old);
  const candidatePort = await listen(candidate);
  const generation = (id, port) => ({
    generation: id.repeat(32),
    dashboard: { host: "127.0.0.1", port },
    api: { host: "127.0.0.1", port },
  });
  const proxy = createIngress(generation("a", oldPort));
  const apiServer = proxy.server("api");
  const dashboardServer = proxy.server("dashboard");
  const api = await listen(apiServer);
  const dashboard = await listen(dashboardServer);
  let socket;
  const sockets = new Set();
  for (const server of [old, candidate, apiServer, dashboardServer])
    server.on("connection", (connection) => {
      sockets.add(connection);
      connection.on("close", () => sockets.delete(connection));
    });
  t.after(() => {
    socket?.terminate();
    for (const connection of sockets) connection.destroy();
    for (const server of [old, candidate, apiServer, dashboardServer]) {
      server.closeAllConnections();
      server.close();
    }
  });
  const streams = Array.from({ length: 100 }, () => get(api, "/stream"));
  while (releases.length !== 100) await new Promise((r) => setTimeout(r, 5));
  socket = new WebSocket(`ws://127.0.0.1:${api}/ws`);
  await once(socket, "open");
  let upload;
  const uploadResult = new Promise((resolve, reject) => {
    upload = http.request(
      {
        host: "127.0.0.1",
        port: api,
        method: "POST",
        path: "/upload",
        headers: {
          Authorization: "Bearer fixture",
          "X-Omni-Canary": "forged",
          "X-Forwarded-For": "forged",
        },
      },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => resolve(data));
      }
    );
    upload.on("error", reject);
    upload.write("first-");
  });
  while (proxy.counts("a".repeat(32)).uploads === 0) await new Promise((r) => setTimeout(r, 5));
  proxy.select(generation("b", candidatePort));
  assert.equal(await get(api), "candidate");
  assert.equal(await get(dashboard), "candidate");
  assert.equal(proxy.counts("a".repeat(32)).bodies, 101);
  assert.equal(proxy.counts("a".repeat(32)).webSockets, 1);
  upload.end("last");
  assert.equal(await uploadResult, "oldfirst-last");
  socket.send("still-alive");
  assert.equal((await once(socket, "message"))[0].toString(), "still-alive");
  releases.forEach((finish) => finish());
  const values = await Promise.all(streams);
  assert(values.every((value) => value === "data: old:first\n\ndata: old:last\n\n"));
  assert.equal(calls.old, 101);
  assert.equal(calls.candidate, 2);
  const uploadHeaders = seenHeaders.find((headers) => headers.authorization);
  assert.equal(uploadHeaders.authorization, "Bearer fixture");
  assert.equal(uploadHeaders["x-omni-canary"], undefined);
  assert.notEqual(uploadHeaders["x-forwarded-for"], "forged");
  socket.terminate();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(proxy.counts("a".repeat(32)), { bodies: 0, uploads: 0, webSockets: 0 });
  await proxy.close();
  await Promise.all([old, candidate].map((s) => new Promise((r) => s.close(r))));
});

test("failed POST is dispatched once and cancellation releases body ownership", async (t) => {
  let calls = 0;
  let cancelled;
  const aborted = new Promise((resolve) => {
    cancelled = resolve;
  });
  const backend = http.createServer((request, response) => {
    calls++;
    request.resume();
    if (request.url === "/cancel") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: first\n\n");
      response.once("close", cancelled);
    } else {
      request.once("end", () => {
        response.writeHead(503);
        response.end("upstream unavailable");
      });
    }
  });
  const backendPort = await listen(backend);
  const endpoint = { host: "127.0.0.1", port: backendPort };
  const proxy = createIngress({ generation: "c".repeat(32), api: endpoint, dashboard: endpoint });
  const server = proxy.server("api");
  const port = await listen(server);
  t.after(() => {
    backend.closeAllConnections();
    backend.close();
    server.closeAllConnections();
    server.close();
  });
  const result = await new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST" }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end("tool-bearing-body");
  });
  assert.equal(result, 503);
  assert.equal(calls, 1);
  await new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/cancel" }, (response) => {
      response.once("data", () => {
        response.destroy();
        request.destroy();
        resolve();
      });
    });
    request.on("error", reject);
  });
  await aborted;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 2);
  assert.deepEqual(proxy.counts("c".repeat(32)), { bodies: 0, uploads: 0, webSockets: 0 });
  await proxy.close();
  await new Promise((resolve) => backend.close(resolve));
});
