import http from "node:http";
const SOCKET = "/run/omniroute-browser-login/control.sock";
export function browserLoginWsPath(path) {
  return /^\/api\/providers\/([A-Za-z0-9_-]{1,128})\/browser-login\/([a-f0-9]{64})\/ws$/.exec(path);
}
export async function handleBrowserLoginUpgrade(
  req,
  socket,
  head,
  { port, secret, scheme = "http", fetchImpl = fetch, requestImpl = http.request }
) {
  // Never fall through on malformed browser-login paths.
  if (!(req.url || "").includes("/browser-login/")) return false;
  const match = browserLoginWsPath(req.url || "");
  const origin = process.env.OMNIROUTE_BROWSER_LOGIN_ORIGIN;
  if (
    !match ||
    !secret ||
    !origin ||
    req.headers.origin !== origin ||
    (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") ||
    process.env.OMNIROUTE_BROWSER_LOGIN_SOCKET !== SOCKET
  ) {
    socket.destroy();
    return true;
  }
  try {
    const authorization = await fetchImpl(
      `${scheme}://127.0.0.1:${port}/api/providers/${match[1]}/browser-login/${match[2]}/authorize`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: req.headers.cookie || "",
          origin,
          "sec-fetch-site": "same-origin",
          "x-browser-login-bridge": secret,
        },
        body: "{}",
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      }
    );
    if (!authorization.ok) throw new Error("Denied");
    const { owner } = await authorization.json();
    if (!/^[a-f0-9]{64}$/.test(owner)) throw new Error("Denied");
    // Rebuild the handshake. Never forward cookies or caller-controlled helper headers.
    const upgrade = requestImpl({
      socketPath: SOCKET,
      path: `/view/${match[2]}`,
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": req.headers["sec-websocket-key"],
        "x-login-owner": owner,
        "x-login-connection": match[1],
        ...(req.headers["sec-websocket-protocol"] === "binary"
          ? { "sec-websocket-protocol": "binary" }
          : {}),
      },
    });
    upgrade.setTimeout(5000, () => upgrade.destroy());
    upgrade.on("upgrade", (res, upstream, upstreamHead) => {
      upstream.setTimeout(0);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${res.headers["sec-websocket-accept"]}\r\n${res.headers["sec-websocket-protocol"] === "binary" ? "Sec-WebSocket-Protocol: binary\r\n" : ""}\r\n`
      );
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
      upstream.on("error", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      socket.on("close", () => upstream.destroy());
      upstream.on("close", () => socket.destroy());
    });
    upgrade.on("response", () => socket.destroy());
    upgrade.on("error", () => socket.destroy());
    upgrade.end();
  } catch {
    socket.destroy();
  }
  return true;
}
