import "../../open-sse/utils/proxyFetch.ts";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { installPinnedTransport } from "./pinnedTransport.ts";

/** Existing provider fixtures still supply response bytes; media reaches them ONLY
 * after real Undici has dialed our fake socket using the production DNS pin. */
export function installMockedPinnedMedia(t: TestContext) {
  const originalFetch = globalThis.fetch;
  let fixtureFetch: typeof fetch | undefined;
  const transport = installPinnedTransport(t.mock, {
    dnsLookup: async () => {
      // Capture the explicit fixture BEFORE a lazy policy import can initialize
      // ProxyFetch. Never call the patched/global runtime from a fake socket.
      fixtureFetch ??= globalThis.fetch;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    reply(socket, dial) {
      void (async () => {
        assert.ok(fixtureFetch, "fixture resolver must run before the pinned dial");
        assert.notEqual(fixtureFetch, originalFetch, "fixture must never call a real fetch");
        const [requestLine, ...lines] = socket.request.split("\r\n");
        const headers = new Headers();
        for (const line of lines) {
          const colon = line.indexOf(":");
          if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
        }
        for (const name of ["authorization", "cookie", "proxy-authorization", "x-api-key"]) {
          assert.equal(headers.has(name), false, `media URL must not receive ${name}`);
        }
        const [method, path] = requestLine.split(" ");
        const url = new URL(path, `${dial.protocol}//${headers.get("host")}`);
        const response = await fixtureFetch(url, { method, headers, redirect: "manual" });
        socket.respond({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: new Uint8Array(await response.arrayBuffer()),
        });
      })().catch((error: Error) => socket.destroy(error));
    },
  });
  t.after(transport.restore);
  return transport;
}
