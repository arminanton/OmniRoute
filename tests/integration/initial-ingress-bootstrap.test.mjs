/** Real private NGINX ingress-only bootstrap, NOT a kernel-NAT/production claim. */
import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
const binary = process.env.OMNI_TEST_NGINX_BINARY;
const kernel = process.env.OMNI_TEST_BOOTSTRAP_KERNEL === "1";
const legacyHost = kernel ? "10.203.242.2" : "127.0.0.4";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await wait(10);
  }
  throw new Error("private bootstrap fixture timeout");
}
async function freePort() {
  const s = net.createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function request(host, port, route, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: route, agent: false, ...options }, (res) => {
      let body = "";
      res.on("data", (x) => (body += x));
      res.on("end", () => resolve({ status: res.statusCode, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

test(
  "first ingress proxy preserves100 already-direct legacy streams, upload and upgraded connection; new calls stay legacy",
  { skip: !binary, timeout: 30000 },
  async (t) => {
    if (kernel) {
      assert.equal(process.getuid(), 0);
      assert.equal(
        Number(process.env.OMNI_TEST_NAMESPACE_INODE),
        (await fs.stat("/proc/self/ns/net")).ino
      );
      assert.match(process.env.OMNI_TEST_NAMESPACE_NAME, /^omni-bootstrap-lab-[a-f0-9]{12}$/);
      assert.equal(
        (await fs.stat("/run/netns/" + process.env.OMNI_TEST_NAMESPACE_NAME)).ino,
        (await fs.stat("/proc/self/ns/net")).ino
      );
    }
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bootstrap-nginx-"));
    const sockets = new Set(),
      servers = [],
      streams = [],
      finish = [];
    let master,
      upgrade,
      uploadSeen = false,
      toolCalls = 0,
      brokenCalls = 0,
      unsafeHeaders = 0;
    t.after(async () => {
      upgrade?.destroy();
      for (const socket of sockets) socket.destroy();
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
      if (master?.exitCode === null) {
        master.kill("SIGTERM");
        await Promise.race([once(master, "exit"), wait(1500)]);
      }
      await fs.rm(directory, { recursive: true, force: true });
    });
    if (kernel) await fs.chmod(directory, 0o755);
    const directAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const bridgedAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    t.after(() => {
      directAgent.destroy();
      bridgedAgent.destroy();
    });
    for (const port of [20128, 20129]) {
      const server = http.createServer((req, res) => {
        if (req.headers["x-omniroute-self-hop"] || req.headers["x-omniroute-peer-locality"])
          unsafeHeaders++;
        if (
          req.url === "/manage" &&
          req.headers.authorization !== "Bearer private-manager-fixture"
        ) {
          res.writeHead(401);
          res.end();
          return;
        }
        if (req.url === "/stream") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: legacy:first\n\n");
          finish.push(() => res.end("data: legacy:last\n\n"));
          return;
        }
        if (req.url === "/broken") {
          brokenCalls++;
          req.resume();
          req.on("end", () => req.socket.destroy());
          return;
        }
        if (req.url === "/tool") toolCalls++;
        let body = "";
        req.on("data", (bytes) => {
          body += bytes;
          if (req.url === "/upload") uploadSeen = true;
        });
        req.on("end", () => res.end("legacy:" + body));
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.on("upgrade", (req, socket) => {
        if (req.headers.authorization !== "Bearer private-manager-fixture") {
          socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
          return;
        }
        const accept = crypto
          .createHash("sha1")
          .update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
        );
        socket.on("data", (bytes) => socket.write(bytes));
      });
      server.listen(port, legacyHost);
      await once(server, "listening");
      servers.push(server);
    }
    for (let i = 0; i < 100; i++) streams.push(request(legacyHost, 20129, "/stream"));
    await until(() => finish.length === 100);
    upgrade = net.connect(20129, legacyHost);
    await once(upgrade, "connect");
    upgrade.write(
      "GET /management-ws HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: aG9zdC1maXh0dXJl\r\nAuthorization: Bearer private-manager-fixture\r\n\r\n"
    );
    assert.match((await once(upgrade, "data"))[0].toString(), /101 Switching/);
    let uploadResult;
    const uploaded = new Promise((resolve, reject) => {
      const req = http.request(
        { host: legacyHost, port: 20129, path: "/upload", method: "POST" },
        (res) => {
          let body = "";
          res.on("data", (x) => (body += x));
          res.on("end", () => resolve(body));
        }
      );
      req.on("error", reject);
      uploadResult = req;
      req.write("first-");
    });
    await until(() => uploadSeen);
    assert.equal((await request(legacyHost, 20129, "/", { agent: directAgent })).body, "legacy:");
    const api = kernel ? 21029 : await freePort(),
      dashboard = kernel ? 21028 : await freePort();
    const policy = {
      schema: "omni-initial-bootstrap/v1",
      transaction: "a".repeat(32),
      bootId: "01234567-89ab-cdef-0123-456789abcdef",
      wanNamespaceInode: 123,
      legacy: {
        revision: "b".repeat(40),
        image: "sha256:" + "c".repeat(64),
        cid: "d".repeat(64),
        helperSet: "e".repeat(64),
        stateOwner: "f".repeat(64),
      },
      guard: { generation: "a".repeat(32), policySha256: "b".repeat(64), outputDeniedHandle: 71 },
      proxyBinarySha256: "c".repeat(64),
    };
    const rendered = spawnSync(
      "python3",
      [
        "-c",
        "import json,sys;from scripts.deploy.canary.bootstrap import legacy_nginx;print(legacy_nginx(json.loads(sys.argv[1])))",
        JSON.stringify(policy),
      ],
      { encoding: "utf8" }
    );
    assert.equal(rendered.status, 0);
    const config = rendered.stdout
      .replaceAll("10.203.242.2", legacyHost)
      .replaceAll("/run/omni-local-next/canary", directory)
      .replace("listen 21028;", `listen 127.0.0.1:${dashboard};`)
      .replace("listen 21029;", `listen 127.0.0.1:${api};`);
    const configPath = path.join(directory, "nginx.conf");
    await fs.writeFile(configPath, config);
    assert.equal(
      spawnSync(binary, ["-t", "-p", directory + "/", "-c", configPath], { stdio: "ignore" })
        .status,
      0
    );
    master = spawn(binary, ["-p", directory + "/", "-c", configPath, "-g", "daemon off;"], {
      stdio: "ignore",
    });
    await until(async () => {
      try {
        return (await request("127.0.0.1", api, "/")).body === "legacy:";
      } catch {
        return false;
      }
    });
    if (kernel) {
      const listed = spawnSync(
        "/usr/sbin/nft",
        ["-j", "list", "chain", "inet", "oe_guard", "output"],
        { encoding: "utf8" }
      );
      assert.equal(listed.status, 0);
      policy.guard.outputDeniedHandle = JSON.parse(listed.stdout).nftables.find(
        (x) => x.rule?.comment === "output-denied"
      ).rule.handle;
      const result = spawnSync(
        "python3",
        [
          "-c",
          "import json,sys;from scripts.deploy.canary.bootstrap import bridge_nft;print(bridge_nft(json.loads(sys.argv[1])))",
          JSON.stringify(policy),
        ],
        { encoding: "utf8" }
      );
      assert.equal(result.status, 0);
      const rulefile = path.join(directory, "bridge.nft");
      await fs.writeFile(rulefile, result.stdout);
      const checked = spawnSync("/usr/sbin/nft", ["--check", "-f", rulefile], { encoding: "utf8" });
      assert.equal(checked.status, 0, checked.stderr);
      assert.equal(spawnSync("/usr/sbin/nft", ["-f", rulefile], { stdio: "ignore" }).status, 0);
      t.diagnostic("kernel bridge applied after existing direct flows");
      assert.equal(
        (await request(legacyHost, 20129, "/_omni_bootstrap_identity")).body,
        "legacy-cccccccccccccccc"
      );
      assert.equal(
        (await request(legacyHost, 20129, "/_omni_bootstrap_identity", { agent: directAgent }))
          .body,
        "legacy:"
      );
      assert.equal(
        (await request(legacyHost, 20129, "/_omni_bootstrap_identity", { agent: bridgedAgent }))
          .body,
        "legacy-cccccccccccccccc"
      );
    }
    t.diagnostic("new and retained direct selectors checked");
    assert.equal((await request("127.0.0.1", api, "/manage")).status, 401);
    assert.equal(
      (
        await request("127.0.0.1", api, "/manage", {
          headers: { authorization: "Bearer private-manager-fixture" },
        })
      ).status,
      200
    );
    assert.equal((await request("127.0.0.1", dashboard, "/")).body, "legacy:");
    const reply = await request(kernel ? legacyHost : "127.0.0.1", kernel ? 20129 : api, "/tool", {
      method: "POST",
      body: "caller-owned-result",
      headers: { "x-omniroute-self-hop": "forged", "x-omniroute-peer-locality": "loopback" },
    });
    assert.equal(reply.body, "legacy:caller-owned-result");
    assert.equal(toolCalls, 1);
    assert.equal(unsafeHeaders, 0);
    const broken = await request("127.0.0.1", api, "/broken", {
      method: "POST",
      body: "no-replay",
    });
    assert.equal(broken.status, 504);
    assert.equal(JSON.parse(broken.body).error.code, "upstream_acceptance_uncertain");
    assert.equal(brokenCalls, 1);
    upgrade.write(Buffer.from([0x81, 0x01, 0x78]));
    assert.deepEqual((await once(upgrade, "data"))[0], Buffer.from([0x81, 0x01, 0x78]));
    if (kernel) {
      assert.equal(
        spawnSync("/usr/sbin/nft", ["delete", "table", "ip", "omni_ingress_bootstrap"], {
          stdio: "ignore",
        }).status,
        0
      );
      assert.equal(
        (await request(legacyHost, 20129, "/_omni_bootstrap_identity", { agent: bridgedAgent }))
          .body,
        "legacy-cccccccccccccccc"
      );
      assert.equal((await request(legacyHost, 20129, "/_omni_bootstrap_identity")).body, "legacy:");
    }
    t.diagnostic("NAT removal retained bridged selector; finishing old bodies");
    uploadResult.end("last");
    assert.equal(await uploaded, "legacy:first-last");
    finish.forEach((fn) => fn());
    assert(
      (await Promise.all(streams)).every(
        (x) => x.body === "data: legacy:first\n\ndata: legacy:last\n\n"
      )
    );
    // Existing sockets never traversed the new listener. This fixture deliberately
    // does not pretend to execute or prove Linux conntrack/NAT or Tailscale migration.
  }
);

test(
  "initial bridge marks absent and forged forwarding headers as proxied after the API loopback hop",
  { skip: !binary, timeout: 30000 },
  async (t) => {
    const { tsImport } = await import("tsx/esm/api");
    const { isLoopbackRequest, isPrivateLanRequest, isViaProxyRequest } = await tsImport(
      "../../src/server/authz/peerContext.ts",
      import.meta.url
    );
    const { stampPeerIp } = await import("../../scripts/dev/peer-stamp.mjs");
    const previousStamp = process.env.OMNIROUTE_PEER_STAMP_TOKEN;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omni-bootstrap-peer-"));
    const servers = [];
    let master;
    t.after(async () => {
      if (previousStamp === undefined) delete process.env.OMNIROUTE_PEER_STAMP_TOKEN;
      else process.env.OMNIROUTE_PEER_STAMP_TOKEN = previousStamp;
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
      if (master?.exitCode === null) {
        master.kill("SIGTERM");
        await Promise.race([once(master, "exit"), wait(1500)]);
      }
      await fs.rm(directory, { recursive: true, force: true });
    });
    const backend = http.createServer((req, res) => {
      stampPeerIp(req);
      if (req.headers.authorization !== "Bearer private-manager-fixture") {
        res.writeHead(401);
        res.end();
        return;
      }
      const context = {
        request: {
          method: req.method,
          headers: new Headers(req.headers),
          socket: { remoteAddress: req.socket.remoteAddress },
        },
      };
      res.end(
        JSON.stringify({
          viaProxy: isViaProxyRequest(context),
          trustedLoopback: isLoopbackRequest(context),
          trustedLan: isPrivateLanRequest(context),
          forwardedFor: req.headers["x-forwarded-for"],
          realIp: req.headers["x-real-ip"] ?? null,
          forwardedHost: req.headers["x-forwarded-host"],
          forwardedProto: req.headers["x-forwarded-proto"],
        })
      );
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    servers.push(backend);
    const bridge = http.createServer((req, res) => {
      // Same loopback/header-preserving hop as the existing API bridge; no new management exposure.
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: backend.address().port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${backend.address().port}` },
        },
        (response) => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        }
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    bridge.listen(0, "127.0.0.1");
    await once(bridge, "listening");
    servers.push(bridge);
    const dashboard = await freePort(),
      api = await freePort();
    const policy = {
      schema: "omni-initial-bootstrap/v1",
      transaction: "a".repeat(32),
      bootId: "01234567-89ab-cdef-0123-456789abcdef",
      wanNamespaceInode: 123,
      legacy: {
        revision: "b".repeat(40),
        image: "sha256:" + "c".repeat(64),
        cid: "d".repeat(64),
        helperSet: "e".repeat(64),
        stateOwner: "f".repeat(64),
      },
      guard: { generation: "a".repeat(32), policySha256: "b".repeat(64), outputDeniedHandle: 71 },
      proxyBinarySha256: "c".repeat(64),
    };
    const generated = spawnSync(
      "python3",
      [
        "-c",
        "import json,sys;from scripts.deploy.canary.bootstrap import legacy_nginx;print(legacy_nginx(json.loads(sys.argv[1])))",
        JSON.stringify(policy),
      ],
      { encoding: "utf8" }
    );
    assert.equal(generated.status, 0, generated.stderr);
    const config = generated.stdout
      .replaceAll("/run/omni-local-next/canary", directory)
      .replace("listen 21028;", `listen 127.0.0.1:${dashboard};`)
      .replace("listen 21029;", `listen 127.0.0.1:${api};`)
      .replaceAll("http://10.203.242.2:20128", `http://127.0.0.1:${backend.address().port}`)
      .replaceAll("http://10.203.242.2:20129", `http://127.0.0.1:${bridge.address().port}`);
    const file = path.join(directory, "nginx.conf");
    await fs.writeFile(file, config);
    assert.equal(
      spawnSync(binary, ["-t", "-p", directory + "/", "-c", file], { encoding: "utf8" }).status,
      0
    );
    master = spawn(binary, ["-p", directory + "/", "-c", file, "-g", "daemon off;"], {
      stdio: "ignore",
    });
    await until(async () => {
      try {
        return (await request("127.0.0.1", api, "/v1/models")).status === 401;
      } catch {
        return false;
      }
    });
    const absent = await request("127.0.0.1", api, "/v1/models", {
      headers: { Authorization: "Bearer private-manager-fixture" },
    });
    const clean = JSON.parse(absent.body);
    assert.equal(clean.viaProxy, true);
    assert.equal(clean.trustedLoopback, false);
    assert.equal(clean.trustedLan, false);
    const forged = await request("127.0.0.1", api, "/v1/models", {
      headers: {
        Authorization: "Bearer private-manager-fixture",
        "X-Forwarded-For": "10.9.8.7",
        "X-Real-IP": "127.0.0.1",
        "X-Forwarded-Host": "forged.invalid",
        "X-Forwarded-Proto": "file",
        "X-Omniroute-Via-Proxy": "forged|0",
      },
    });
    const result = JSON.parse(forged.body);
    assert.equal(result.viaProxy, true);
    assert.equal(result.trustedLoopback, false);
    assert.equal(result.trustedLan, false);
    assert.equal(result.forwardedFor, "127.0.0.1");
    assert.equal(result.realIp, null);
    assert.equal(result.forwardedHost, `127.0.0.1:${api}`);
    assert.equal(result.forwardedProto, "https");
    assert.equal(
      (
        await request("127.0.0.1", api, "/v1/models", {
          headers: { Authorization: "Bearer wrong-fixture-key" },
        })
      ).status,
      401
    );
    const direct = await request("127.0.0.1", backend.address().port, "/v1/models", {
      headers: { Authorization: "Bearer private-manager-fixture" },
    });
    assert.equal(JSON.parse(direct.body).trustedLoopback, true);
  }
);
