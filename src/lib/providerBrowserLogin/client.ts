import http from "node:http";
export const BROWSER_LOGIN_SOCKET = "/run/omniroute-browser-login/control.sock";
export function helperRequest(path: string, body?: object): Promise<Buffer> {
  if (process.env.OMNIROUTE_BROWSER_LOGIN_SOCKET !== BROWSER_LOGIN_SOCKET)
    throw new Error("Disabled");
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: BROWSER_LOGIN_SOCKET,
        path,
        method: body ? "POST" : "GET",
        headers: body ? { "content-type": "application/json" } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) res.destroy(new Error("Size"));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error("Unavailable"))
        );
      }
    );
    req.setTimeout(65000, () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
