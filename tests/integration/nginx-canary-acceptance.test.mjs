/** Opt-in real NGINX fixture: only private binary, own PID/temp files, loopback backends. */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

const binary = process.env.OMNI_TEST_NGINX_BINARY;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error("fixture wait expired");
    await wait(10);
  }
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function request(port, route = "/", options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: route, ...options }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body);
  });
}
function frame(text, masked = true) {
  const payload = Buffer.from(text);
  assert(payload.length < 126);
  if (!masked) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const key = crypto.randomBytes(4),
    encoded = Buffer.from(payload);
  encoded.forEach((_, i) => {
    encoded[i] ^= key[i % 4];
  });
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), key, encoded]);
}
function decodeFrame(bytes) {
  assert.equal(bytes[0] & 15, 1);
  const masked = Boolean(bytes[1] & 128),
    length = bytes[1] & 127;
  assert(length < 126);
  const begin = masked ? 6 : 2,
    value = Buffer.from(bytes.subarray(begin, begin + length));
  if (masked)
    value.forEach((_, i) => {
      value[i] ^= bytes[2 + (i % 4)];
    });
  return value.toString();
}
async function websocket(port, authorized) {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  const key = crypto.randomBytes(16).toString("base64");
  socket.write(
    `GET /management-ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n${authorized ? "Authorization: Bearer manager-fixture\r\n" : ""}\r\n`
  );
  const response = (await once(socket, "data"))[0].toString();
  if (!authorized) {
    assert.match(response, /401/);
    socket.destroy();
    return null;
  }
  assert.match(response, /101 Switching/);
  return socket;
}
function h2Request(session, route) {
  const stream = session.request({ ":path": route });
  let body = "",
    headers;
  const done = new Promise((resolve, reject) => {
    stream.on("response", (value) => {
      headers = value;
    });
    stream.on("data", (chunk) => {
      body += chunk;
    });
    stream.on("end", () => resolve({ body, headers }));
    stream.on("error", reject);
  });
  stream.end();
  return { stream, done };
}

test(
  "real NGINX reload preserves 100 SSEs, management WS and upload without POST replay",
  { skip: !binary, timeout: 30000 },
  async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omni-nginx-acceptance-"));
    await fs.chmod(directory, 0o700);
    const servers = [],
      sockets = new Set(),
      releases = [],
      seen = [];
    const calls = { old: 0, candidate: 0 },
      status = { old: false, candidate: false };
    let master, ws, h2;
    const keepalive = new http.Agent({ keepAlive: true, maxSockets: 1 });
    t.after(() => keepalive.destroy());
    t.after(async () => {
      ws?.destroy();
      h2?.destroy();
      for (const socket of sockets) socket.destroy();
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
      if (master && master.exitCode === null) {
        master.kill("SIGTERM");
        await Promise.race([once(master, "exit"), wait(1500)]);
      }
      await fs.rm(directory, { recursive: true, force: true });
    });
    for (const [name, host] of [
      ["old", "127.0.0.2"],
      ["candidate", "127.0.0.3"],
    ]) {
      for (const port of [20128, 20129]) {
        const server = http.createServer((req, res) => {
          calls[name]++;
          seen.push({ name, method: req.method, path: req.url, auth: req.headers.authorization });
          if (
            ["/fence", "/unfence", "/unfence-fail"].includes(req.url) &&
            req.headers.authorization !== "Bearer manager-fixture"
          ) {
            res.writeHead(401);
            res.end("auth required");
            return;
          }
          if (req.url === "/unfence-fail") {
            res.writeHead(500);
            res.end("failed-unfence");
            return;
          }
          if (req.url === "/stream") {
            res.writeHead(200, { "Content-Type": "text/event-stream" });
            res.write(`data: ${name}:first\n\n`);
            releases.push(() => res.end(`data: ${name}:last\n\n`));
          } else if (req.url === "/fence") {
            status[name] = true;
            res.end("fenced");
          } else if (req.url === "/unfence") {
            status[name] = false;
            res.end("ready");
          } else if (status[name]) {
            res.writeHead(503);
            res.end("fenced");
          } else if (req.url === "/broken-post") {
            req.resume();
            req.on("end", () => req.socket.destroy());
          } else {
            let body = "";
            req.on("data", (chunk) => {
              body += chunk;
            });
            req.on("end", () => res.end(name + body));
          }
        });
        server.on("connection", (socket) => {
          sockets.add(socket);
          socket.on("close", () => sockets.delete(socket));
        });
        server.on("upgrade", (req, socket, head) => {
          if (req.headers.authorization !== "Bearer manager-fixture") {
            socket.end(
              "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
            );
            return;
          }
          const accept = crypto
            .createHash("sha1")
            .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            .digest("base64");
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
          );
          const echo = (bytes) => socket.write(frame(name + ":" + decodeFrame(bytes), false));
          if (head.length) echo(head);
          socket.on("data", echo);
          socket.on("end", () => socket.destroy());
        });
        server.listen(port, host);
        await once(server, "listening");
        servers.push(server);
      }
    }
    const api = await freePort(),
      dashboard = await freePort(),
      tlsPort = await freePort();
    const python = `import json,sys;from scripts.deploy.canary.proxy import nginx_config;g=json.loads(sys.argv[1]);print(nginx_config(g,{"api":${api},"dashboard":${dashboard}}))`;
    function config(name, tls = false) {
      const char = name === "old" ? "a" : "b";
      const generation = {
        generation: char.repeat(32),
        slot: name === "old" ? "blue" : "green",
        image: "sha256:" + char.repeat(64),
        revision: char.repeat(40),
        address: name === "old" ? "10.203.250.2" : "10.203.251.2",
        namespace: "omni-app-" + char.repeat(32),
        stateOwner: "coordinated-live-v1",
        helperSet: "d".repeat(64),
      };
      const result = spawnSync("python3", ["-c", python, JSON.stringify(generation)], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      let rendered = result.stdout
        .replaceAll(generation.address, name === "old" ? "127.0.0.2" : "127.0.0.3")
        .replaceAll("/run/omni-local-next/canary", directory)
        .replaceAll(`listen ${api};`, `listen 127.0.0.1:${api};`)
        .replaceAll(`listen ${dashboard};`, `listen 127.0.0.1:${dashboard};`)
        .replace("worker_processes auto;", "worker_processes 2;");

      if (tls) {
        const begin = rendered.indexOf("  server {");
        const end = rendered.lastIndexOf("}\n");
        const stanza = rendered
          .slice(begin, rendered.indexOf("  server {", begin + 1))
          .replace(
            `listen 127.0.0.1:${dashboard};`,
            `listen 127.0.0.1:${tlsPort} ssl http2;\n ssl_certificate ${directory}/cert.pem;\n ssl_certificate_key ${directory}/key.pem;`
          );
        rendered = rendered.slice(0, end) + stanza + rendered.slice(end);
      }
      return rendered;
    }
    const openssl = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        directory + "/key.pem",
        "-out",
        directory + "/cert.pem",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" }
    );
    assert.equal(openssl.status, 0);
    const file = path.join(directory, "nginx.conf");
    async function install(name) {
      await fs.writeFile(file, config(name, true), { mode: 0o600 });
      const check = spawnSync(binary, ["-t", "-p", directory + "/", "-c", file], {
        encoding: "utf8",
      });
      assert.equal(check.status, 0, check.stderr);
    }
    await install("old");
    master = spawn(binary, ["-p", directory + "/", "-c", file, "-g", "daemon off;"], {
      stdio: "ignore",
    });
    await until(async () => {
      try {
        return (await request(api)).body === "old";
      } catch {
        return false;
      }
    });
    assert.equal((await request(api, "/", { agent: keepalive })).body, "old");
    const streams = Array.from({ length: 100 }, () => request(api, "/stream"));
    await until(() => releases.length === 100);
    ws = await websocket(api, true);
    await websocket(api, false);
    let upload;
    const uploadResult = new Promise((resolve, reject) => {
      upload = http.request(
        { hostname: "127.0.0.1", port: api, path: "/upload", method: "POST" },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () => resolve(body));
        }
      );
      upload.on("error", reject);
      upload.write("first-");
    });
    await until(() => seen.some((entry) => entry.path === "/upload"));
    h2 = http2.connect(`https://127.0.0.1:${tlsPort}`, {
      ca: await fs.readFile(directory + "/cert.pem"),
    });
    await once(h2, "connect");
    const oldH2 = h2Request(h2, "/stream");
    await until(() => releases.length === 101);
    const goawayEvents = [];
    h2.on("goaway", (code, lastStreamID) => {
      goawayEvents.push({ code, lastStreamID });
    });
    // Failed prevalidation cannot change the active master/config admission.
    const bad = path.join(directory, "invalid.conf");
    await fs.writeFile(
      bad,
      config("candidate", true) +
        `
invalid_directive;
`
    );
    const refused = spawnSync(binary, ["-t", "-p", directory + "/", "-c", bad], {
      encoding: "utf8",
    });
    assert.notEqual(refused.status, 0);
    assert.equal((await request(api)).body, "old");
    const masterPid = master.pid;
    await install("candidate");
    master.kill("SIGHUP");
    await until(async () => (await request(api)).body === "candidate");
    assert.equal((await request(dashboard)).body, "candidate");
    assert.equal(master.pid, masterPid);
    assert.equal((await request(api, "/", { agent: keepalive })).body, "candidate");
    ws.write(frame("still-alive"));
    assert.equal(decodeFrame((await once(ws, "data"))[0]), "old:still-alive");
    upload.end("last");
    assert.equal(await uploadResult, "oldfirst-last");
    const fail = await request(api, "/broken-post", { method: "POST", body: "do-not-replay" });
    assert.equal(fail.status, 502);
    assert.equal(seen.filter((entry) => entry.path === "/broken-post").length, 1);
    releases.forEach((release) => release());
    assert(
      (await Promise.all(streams)).every(
        (reply) => reply.body === "data: old:first\n\ndata: old:last\n\n"
      )
    );
    assert.equal((await oldH2.done).body, "data: old:first\n\ndata: old:last\n\n");
    await until(() => goawayEvents.length > 0);
    // HTTP/2 connections cannot be moved to another generation. Once GOAWAY is
    // observed, client opens a fresh connection rather than replaying a sent POST.
    const afterGoaway = await new Promise((resolve) => {
      try {
        const unprocessed = h2.request({ ":path": "/never-replay", ":method": "POST" });
        unprocessed.on("error", (error) => resolve(error.code));
        unprocessed.on("response", () => {
          unprocessed.resume();
          resolve("response");
        });
        unprocessed.end("never-replayed");
      } catch (error) {
        resolve(error.code);
      }
    });
    assert.notEqual(afterGoaway, "response");
    const freshH2 = http2.connect(`https://127.0.0.1:${tlsPort}`, {
      ca: await fs.readFile(directory + "/cert.pem"),
    });
    await once(freshH2, "connect");
    assert.equal((await h2Request(freshH2, "/").done).body, "candidate");
    freshH2.close();
    // Application reversible fence is cleared before selecting retained old again.
    status.old = true;
    // A failed un-fence leaves candidate selected; no switch until readiness ACK.
    assert.equal(status.old, true);
    const failedUnfence = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.2",
          port: 20129,
          path: "/unfence-fail",
          method: "POST",
          headers: { Authorization: "Bearer manager-fixture" },
        },
        (res) => {
          res.resume();
          res.once("end", () => resolve(res.statusCode));
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(failedUnfence, 500);
    assert.equal(status.old, true);
    assert.equal((await request(api)).body, "candidate");
    await new Promise((resolve, reject) => {
      http
        .get(
          {
            hostname: "127.0.0.2",
            port: 20129,
            path: "/unfence",
            headers: { Authorization: "Bearer manager-fixture" },
          },
          (res) => {
            res.resume();
            res.once("end", resolve);
          }
        )
        .on("error", reject);
    });
    assert.equal(status.old, false);
    await install("old");
    master.kill("SIGHUP");
    await until(async () => (await request(api)).body === "old");
    assert.equal(seen.filter((entry) => entry.path === "/upload").length, 1);
    assert.equal(seen.filter((entry) => entry.path === "/never-replay").length, 0);
    t.diagnostic(
      JSON.stringify({
        nginx: "1.24.0",
        ssePreserved: 100,
        managementWsPreserved: true,
        uploadDispatchedOnce: true,
        failedPostDispatchedOnce: true,
        goawayEvents,
        postGoawayOutcome: afterGoaway,
        masterPidStable: master.pid === masterPid,
      })
    );
    ws.destroy();
    h2.destroy();
  }
);
