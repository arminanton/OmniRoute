import { z } from "zod";
import { browserLoginOwner } from "@/lib/providerBrowserLogin/auth";
import { helperRequest } from "@/lib/providerBrowserLogin/client";
import { getProviderConnectionById } from "@/lib/db/providers";
import { saveBrowserLoginCapture, isBrowserLoginProvider } from "@/lib/vncSession/capture";
import { createErrorResponse } from "@/lib/api/errorResponse";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const sessionSchema = z.string().regex(/^[a-f0-9]{64}$/);
type Context = { params: Promise<{ id: string; action: string[] }> };
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};
async function handle(request: Request, context: Context) {
  const owner = await browserLoginOwner(request);
  if (!owner)
    return createErrorResponse({
      status: 403,
      message: "Dashboard session and same-origin request required",
      type: "invalid_request",
    });
  try {
    const { id, action } = await context.params;
    idSchema.parse(id);
    const connection = await getProviderConnectionById(id);
    if (!connection || !isBrowserLoginProvider(connection.provider)) throw new Error("Connection");
    const identity = { owner, connection: id };
    if (request.method === "POST") {
      if (Number(request.headers.get("content-length") || 0) > 1024) throw new Error("Size");
      const reader = request.body?.getReader();
      let raw = "";
      if (reader) {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            raw += new TextDecoder().decode(value);
            if (raw.length > 1024) {
              await reader.cancel();
              throw new Error("Size");
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      z.object({}).strict().parse(JSON.parse(raw));
      if (action.length === 1 && action[0] === "start") {
        const result = JSON.parse(
          (await helperRequest("/start", { ...identity, provider: connection.provider })).toString()
        );
        return Response.json({ id: result.id, expires: result.expires }, { headers });
      }
      if (action.length !== 2 || !["capture", "cancel", "status", "authorize"].includes(action[1]))
        throw new Error("Action");
      const session = sessionSchema.parse(action[0]);
      const operation = action[1] === "authorize" ? "status" : action[1];
      const result = await helperRequest(`/${operation}/${session}`, identity);
      if (operation === "capture") {
        await saveBrowserLoginCapture(id, connection.provider, JSON.parse(result.toString()));
        await helperRequest(`/cancel/${session}`, identity);
      }
      // Authorize only reveals a one-way ownership digest to the trusted WS bridge.
      if (action[1] === "authorize") {
        if (
          request.headers.get("x-browser-login-bridge") !==
            process.env.OMNIROUTE_WS_BRIDGE_SECRET ||
          !process.env.OMNIROUTE_WS_BRIDGE_SECRET
        )
          throw new Error("Bridge");
        return Response.json({ owner }, { headers });
      }
      return Response.json({ ok: true }, { headers });
    }
    if (action.length >= 3 && action[1] === "assets") {
      sessionSchema.parse(action[0]);
      await helperRequest(`/status/${action[0]}`, identity);
      const path = action.slice(2).join("/");
      if (
        !/^(core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(path) ||
        path.split("/").some((p) => p === ".." || p === ".")
      )
        throw new Error("Asset");
      return new Response(new Uint8Array(await helperRequest(`/assets/${path}`)), {
        headers: { ...headers, "Content-Type": "text/javascript" },
      });
    }
    if (action.length === 2 && action[1] === "view") {
      const session = sessionSchema.parse(action[0]);
      await helperRequest(`/status/${session}`, identity);
      const base = `/api/providers/${id}/browser-login/${session}`;
      const html = `<!doctype html><html><head><meta name="referrer" content="same-origin"><style>html,body,#screen{margin:0;width:100%;height:100%;overflow:hidden;background:#222}</style></head><body><div id="screen"></div><script type="module">import RFB from '${base}/assets/core/rfb.js';const rfb=new RFB(document.getElementById('screen'), 'wss://'+location.host+'${base}/ws');rfb.scaleViewport=true;rfb.resizeSession=false;</script></body></html>`;
      return new Response(html, {
        headers: {
          ...headers,
          "Referrer-Policy": "same-origin",
          "Content-Type": "text/html",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
        },
      });
    }
    throw new Error("Action");
  } catch {
    return createErrorResponse({
      status: 409,
      message: "Browser login unavailable. Retry or cancel the session.",
      type: "invalid_request",
    });
  }
}
export const POST = handle;
export const GET = handle;
