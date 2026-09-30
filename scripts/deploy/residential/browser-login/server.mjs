import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdir, chmod, unlink, readFile, access } from "node:fs/promises";
import { SOCKET, STATE, LOGINS, assetPath, owns, reserveLogin, createSchemas } from "./policy.mjs";
import { filterStorageState } from "./protocol.mjs";
const require = createRequire("/app/server.js");
const { chromium } = require("playwright-core");
const { WebSocketServer } = require("ws");
const { z } = require("zod");
const { identity, start: startSchema } = createSchemas(z);
const sessions = new Map();
const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
process.umask(0o077);
// Do not pass deployment credentials to the browser or GUI processes.
function guiEnv(display) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: STATE,
    TMPDIR: "/tmp",
    LANG: "C.UTF-8",
    DISPLAY: display,
  };
}
async function close(s) {
  if (!s) return;
  if (s.closing) return s.cleanup;
  s.closing = true;
  clearTimeout(s.timer);
  for (const ws of s.viewers) ws.terminate();
  s.cleanup = (async () => {
    await s.context?.close().catch(() => {});
    await Promise.all(
      s.children.map(
        (p) =>
          new Promise((resolve) => {
            if (!p.pid || p.exitCode !== null || p.signalCode !== null) {
              resolve();
              return;
            }
            const timer = setTimeout(() => p.kill("SIGKILL"), 2000);
            p.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
            p.once("error", () => {
              clearTimeout(timer);
              resolve();
            });
            p.kill("SIGTERM");
          })
      )
    );
    await unlink(s.rfbSocket).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    // Do not recycle a display/profile while Chromium is still launching.
    if (!s.initializing) sessions.delete(s.id);
  })();
  return s.cleanup;
}
function child(s, command, args) {
  const p = spawn(command, args, { stdio: "ignore", env: guiEnv(s.display) });
  s.children.push(p);
  p.on("error", () => {
    void close(s);
  });
  p.on("exit", () => {
    if (!s.closing) void close(s);
  });
  return p;
}
async function ready(socketPath) {
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    if (
      await new Promise((resolve) => {
        const s = net.connect(socketPath);
        s.once("connect", () => {
          s.destroy();
          resolve(true);
        });
        s.once("error", () => resolve(false));
      })
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Unavailable");
}
async function start(input) {
  const s = reserveLogin(sessions, input);
  const slot = s.slot;
  s.timer = setTimeout(
    () => {
      void close(s);
    },
    10 * 60 * 1000
  );
  try {
    const profile = `${STATE}/${createHash("sha256")
      .update(input.provider + "\0" + input.connection)
      .digest("hex")}`;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await chmod(profile, 0o700);
    child(s, "/usr/bin/Xvfb", [
      s.display,
      "-screen",
      "0",
      "1280x800x24",
      "-nolisten",
      "tcp",
      "-ac",
    ]);
    const xDeadline = Date.now() + 10000;
    while (true) {
      if (s.closing || Date.now() > xDeadline) throw new Error("X unavailable");
      try {
        await access(`/tmp/.X11-unix/X${90 + slot}`);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    await unlink(s.rfbSocket).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    child(s, "/usr/bin/x11vnc", [
      "-display",
      s.display,
      "-unixsock",
      s.rfbSocket,
      "-rfbport",
      "0",
      "-forever",
      "-shared",
      "-nopw",
      "-quiet",
    ]);
    await ready(s.rfbSocket);
    if (s.closing) throw new Error("Closed");
    s.context = await chromium.launchPersistentContext(profile, {
      headless: false,
      chromiumSandbox: false,
      viewport: { width: 1280, height: 800 },
      env: guiEnv(s.display),
      args: ["--disable-dev-shm-usage", "--disable-extensions"],
      acceptDownloads: false,
    });
    if (s.closing) {
      await s.context.close();
      throw new Error("Closed");
    }
    s.context.on("close", () => {
      void close(s);
    });
    await s.context
      .pages()[0]
      .goto(LOGINS[input.provider], { waitUntil: "domcontentloaded", timeout: 45000 });
    if (s.closing) throw new Error("Closed");
    return { id: s.id, expires: s.expires };
  } catch {
    await close(s);
    throw new Error("Unavailable");
  } finally {
    s.initializing = false;
    if (s.closing) {
      await s.cleanup;
      sessions.delete(s.id);
    }
  }
}
async function body(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 4096) throw new Error("Size");
  }
  return JSON.parse(data);
}
const server = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET" && req.url.startsWith("/assets/")) {
      const path = assetPath(req.url.slice(8));
      if (!path) throw new Error("Path");
      res.setHeader("Content-Type", "text/javascript");
      res.end(await readFile(`/usr/share/novnc/${path}`));
      return;
    }
    if (req.method !== "POST") throw new Error("Method");
    if (req.url === "/start") {
      res.end(JSON.stringify(await start(startSchema.parse(await body(req)))));
      return;
    }
    const match = /^\/(status|capture|cancel)\/([a-f0-9]{64})$/.exec(req.url);
    if (!match) throw new Error("Path");
    const input = identity.strict().parse(await body(req));
    const s = sessions.get(match[2]);
    if (!owns(s, input.owner, input.connection)) throw new Error("Owner");
    if (match[1] === "capture") {
      if (!s.context || s.closing) throw new Error("Not ready");
      const state = filterStorageState(s.provider, await s.context.storageState());
      res.end(JSON.stringify(state));
      return;
    }
    if (match[1] === "cancel") await close(s);
    res.end(JSON.stringify({ id: s.id, expires: s.expires }));
  } catch {
    res.statusCode = 409;
    res.end('{"error":"Browser login unavailable"}');
  }
});
server.on("upgrade", (req, socket, head) => {
  const match = /^\/view\/([a-f0-9]{64})$/.exec(req.url || "");
  const s = match && sessions.get(match[1]);
  if (
    !owns(s, req.headers["x-login-owner"], req.headers["x-login-connection"]) ||
    s.closing ||
    !s.context
  ) {
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    s.viewers.add(ws);
    const tcp = net.connect(s.rfbSocket);
    tcp.on("data", (data) => {
      if (ws.readyState === 1) ws.send(data);
    });
    ws.on("message", (data) => {
      if (!tcp.destroyed) tcp.write(data);
    });
    tcp.on("error", () => ws.terminate());
    tcp.on("close", () => ws.close());
    ws.on("error", () => tcp.destroy());
    ws.on("close", () => {
      tcp.destroy();
      s.viewers.delete(ws);
    });
  });
});
await mkdir(STATE, { recursive: true, mode: 0o700 });
await chmod(STATE, 0o700);
await mkdir("/run/omniroute-browser-login", { recursive: true, mode: 0o700 });
await chmod("/run/omniroute-browser-login", 0o700);
await unlink(SOCKET).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
server.listen(SOCKET, () => {
  void chmod(SOCKET, 0o600);
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, async () => {
    await Promise.all([...sessions.values()].map(close));
    server.close();
  });
