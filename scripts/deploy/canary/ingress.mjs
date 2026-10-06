/** Persistent ingress core. Host/bootstrap installation remains separately reviewed.
 * Every request/upgrade chooses one generation once. No retry, replay or mirroring.
 * Admission switches do not close old sockets. No public canary-selection endpoint.
 */
import http from "node:http";
import net from "node:net";

function validateGeneration(value) {
  if (!value || !/^[a-f0-9]{32}$/.test(value.generation)) {
    throw new Error("invalid generation");
  }
  for (const role of ["dashboard", "api"]) {
    const endpoint = value[role];
    if (
      !endpoint ||
      net.isIP(endpoint.host) !== 4 ||
      !Number.isInteger(endpoint.port) ||
      endpoint.port < 1024 ||
      endpoint.port > 65535
    ) {
      throw new Error("invalid backend listener");
    }
  }
  return Object.freeze({
    generation: value.generation,
    dashboard: Object.freeze({ ...value.dashboard }),
    api: Object.freeze({ ...value.api }),
  });
}

function headersFor(request, upgrade, trustedProto) {
  const headers = { ...request.headers };
  const tokens = String(headers.connection ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase());
  for (const name of [
    ...tokens,
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "x-omni-generation",
    "x-omni-canary",
    "x-omni-internal-authorization",
    "x-omniroute-route-class",
    "x-omniroute-auth-kind",
    "x-omniroute-auth-id",
    "x-omniroute-auth-label",
    "x-omniroute-auth-scopes",
    "x-omniroute-cli-token",
    "x-omniroute-peer-ip",
    "x-omniroute-via-proxy",
    "x-omniroute-peer-locality",
    "x-omniroute-trusted-peer-ip",
    "x-forwarded-for",
    "x-forwarded-proto",
  ]) {
    delete headers[name];
  }
  // Caller Authorization, Host and Origin pass through unchanged; upstream must still
  // authenticate every caller. Ingress must never imply trusted-local authorization.
  headers["x-forwarded-for"] = request.socket.remoteAddress;
  headers["x-forwarded-proto"] = trustedProto;
  if (upgrade) {
    headers.connection = "Upgrade";
    headers.upgrade = request.headers.upgrade;
  }
  return headers;
}

export function createIngress(initial, { trustedProto = "http" } = {}) {
  if (!["http", "https"].includes(trustedProto)) throw new Error("invalid trusted protocol");
  let selected = validateGeneration(initial);
  const counts = new Map();
  const servers = [];
  function increment(generation, field, delta) {
    const value = counts.get(generation) ?? { bodies: 0, uploads: 0, webSockets: 0 };
    value[field] += delta;
    counts.set(generation, value);
  }
  function tracked(generation, field) {
    increment(generation, field, 1);
    let closed = false;
    return () => {
      if (!closed) {
        closed = true;
        increment(generation, field, -1);
      }
    };
  }
  function server(role) {
    if (!["dashboard", "api"].includes(role)) throw new Error("invalid ingress role");
    const instance = http.createServer((request, response) => {
      const chosen = selected;
      const bodyDone = tracked(chosen.generation, "bodies");
      const uploadDone = tracked(chosen.generation, "uploads");
      request.once("end", uploadDone);
      request.once("close", uploadDone);
      response.once("finish", bodyDone);
      response.once("close", bodyDone);
      const upstream = http.request(
        {
          hostname: chosen[role].host,
          port: chosen[role].port,
          path: request.url,
          method: request.method,
          headers: headersFor(request, false, trustedProto),
        },
        (reply) => {
          const headers = { ...reply.headers };
          // No stable callback needs an upstream trust header added to request.
          headers["x-omni-ingress-generation"] = chosen.generation;
          response.writeHead(reply.statusCode ?? 502, headers);
          reply.once("error", () => response.destroy());
          reply.once("aborted", () => response.destroy());
          reply.pipe(response);
        }
      );
      upstream.once("error", () => {
        if (!response.headersSent) {
          response.writeHead(502);
          response.end("Backend unavailable");
        } else response.destroy();
      });
      request.once("aborted", () => upstream.destroy());
      request.once("error", () => {
        upstream.destroy();
        response.destroy();
      });
      response.once("close", () => upstream.destroy());
      request.pipe(upstream);
    });
    instance.on("upgrade", (request, socket, head) => {
      const chosen = selected;
      const done = tracked(chosen.generation, "webSockets");
      const upstream = http.request({
        hostname: chosen[role].host,
        port: chosen[role].port,
        path: request.url,
        method: request.method,
        headers: headersFor(request, true, trustedProto),
      });
      let peer;
      socket.once("close", () => {
        done();
        upstream.destroy();
        peer?.destroy();
      });
      socket.once("end", () => {
        socket.destroy();
        upstream.destroy();
        peer?.destroy();
      });
      socket.once("error", () => {
        socket.destroy();
        upstream.destroy();
        peer?.destroy();
      });
      upstream.once("error", () => socket.destroy());
      upstream.once("response", (reply) => {
        reply.resume();
        socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
      });
      upstream.once("upgrade", (reply, backend, backendHead) => {
        peer = backend;
        const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`];
        for (let index = 0; index < reply.rawHeaders.length; index += 2) {
          lines.push(`${reply.rawHeaders[index]}: ${reply.rawHeaders[index + 1]}`);
        }
        socket.write(lines.join("\r\n") + "\r\n\r\n");
        if (backendHead.length) socket.write(backendHead);
        if (head.length) backend.write(head);
        backend.once("end", () => {
          backend.destroy();
          socket.destroy();
        });
        backend.once("close", () => socket.destroy());
        backend.once("error", () => socket.destroy());
        socket.pipe(backend);
        backend.pipe(socket);
      });
      upstream.end();
    });
    // Healthy long generation streams and upgrades have no forced drain timer.
    instance.requestTimeout = 0;
    instance.timeout = 0;
    servers.push(instance);
    return instance;
  }
  return {
    server,
    select(value) {
      selected = validateGeneration(value);
      return selected.generation;
    },
    selected() {
      return selected.generation;
    },
    counts(generation) {
      return { ...(counts.get(generation) ?? { bodies: 0, uploads: 0, webSockets: 0 }) };
    },
    async close() {
      await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    },
  };
}
