import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAndValidatePublicUrl,
  parseAndValidateNonMetadataUrl,
} from "../../src/shared/network/outboundUrlGuard.ts";
import { fetchRemoteImage } from "../../src/shared/network/remoteImageFetch.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("public-only rejects special-use IPv4, IPv6, mapped and noncanonical literals", () => {
  for (const host of [
    "127.1",
    "2130706433",
    "0x7f000001",
    "localhost.",
    "192.0.2.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.1.2.3",
    "[0:0:0:0:0:0:0:1]",
    "[::ffff:127.0.0.1]",
    "[fe90::1]",
    "[febf::1]",
    "[ff02::1]",
    "[64:ff9b::a9fe:a9fe]",
    "[2002:7f00:1::]",
    "[2001:db8::1]",
  ]) {
    assert.throws(() => parseAndValidatePublicUrl(`http://${host}/image`), /blocked/i, host);
  }
  for (const host of ["8.8.8.8", "[2606:4700::1111]", "images.example"]) {
    assert.doesNotThrow(() => parseAndValidatePublicUrl(`https://${host}/image`));
  }
});

test("admin private policy always denies metadata, link-local, mapped and expanded spellings", () => {
  for (const host of [
    "metadata.google.internal.",
    "metadata.goog.",
    "169.254.1.2",
    "[fe80::1]",
    "[febf::1]",
    "[0:0:0:0:0:ffff:a9fe:a9fe]",
    "[fd00:0ec2:0:0:0:0:0:0254]",
    "[64:ff9b::a9fe:a9fe]",
  ]) {
    assert.throws(() => parseAndValidateNonMetadataUrl(`http://${host}/`), /blocked/i, host);
  }
  for (const host of [
    "127.0.0.1",
    "10.1.2.3",
    "100.101.102.103",
    "[fd7a:115c:a1e0::1]",
    "vault.tailnet.ts.net",
  ]) {
    assert.doesNotThrow(() => parseAndValidateNonMetadataUrl(`http://${host}/`));
  }
});

test("remote image defaults to public-only regardless of provider local policy", async () => {
  let sends = 0;
  await assert.rejects(
    fetchRemoteImage("http://10.1.2.3/image", {
      fetchImpl: async () => {
        sends++;
        return new Response("bad");
      },
    }),
    /blocked/i
  );
  assert.equal(sends, 0);
});

test("remote image rejects malformed DNS family and every nonpublic answer", async () => {
  let sends = 0;
  for (const bad of [
    { address: "10.0.0.1", family: 4 },
    { address: "0:0:0:0:0:ffff:7f00:1", family: 6 },
    { address: "fe90::1", family: 6 },
    { address: "93.184.216.34", family: 6 },
    { address: "not-an-ip", family: 0 },
  ]) {
    await assert.rejects(
      fetchRemoteImage("https://images.example/test", {
        lookup: async () => [...(await publicLookup()), bad],
        fetchImpl: async () => {
          sends++;
          return new Response("bad");
        },
      }),
      /blocked/i
    );
  }
  assert.equal(sends, 0);
});

test("blocked redirect and byte limit cancel bodies", async () => {
  for (const headers of [{ location: "http://[fe90::1]/image" }, { "content-length": "100" }]) {
    let canceled = 0;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
      {
        status: "location" in headers ? 302 : 200,
        headers,
      }
    );
    await assert.rejects(
      fetchRemoteImage("https://images.example/test", {
        lookup: publicLookup,
        fetchImpl: async () => response,
        maxBytes: 2,
      }),
      /blocked|limit/i
    );
    assert.equal(canceled, 1);
  }
});

test("deadline covers a hung DNS resolver and body reader", async () => {
  for (const lookup of [publicLookup, async () => new Promise<never>(() => {})]) {
    let canceled = 0;
    await assert.rejects(
      fetchRemoteImage("https://images.example/test", {
        lookup,
        fetchImpl: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                canceled++;
              },
            })
          ),
        timeoutMs: 10,
      }),
      /timeout|timed out|abort/i
    );
    if (lookup === publicLookup) assert.equal(canceled, 1);
  }
});

test("caller abort covers DNS and a streaming body and blocks all later redirects", async () => {
  const controller = new AbortController();
  let sends = 0;
  let canceled = 0;
  const pending = fetchRemoteImage("https://images.example/test", {
    lookup: publicLookup,
    signal: controller.signal,
    fetchImpl: async () => {
      sends++;
      return new Response(
        new ReadableStream({
          cancel() {
            canceled++;
          },
        })
      );
    },
  });
  // Abort after transport has returned headers, without real timers or network.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new DOMException("Caller stopped", "AbortError"));
  await assert.rejects(pending, { name: "RemoteMediaFetchError", status: 499 });
  assert.equal(sends, 1);
  assert.equal(canceled, 1);
});

test("same-origin image redirect DNS is checked again and all response paths cancel", async () => {
  let resolutions = 0;
  let sends = 0;
  let canceled = 0;
  await assert.rejects(
    fetchRemoteImage("https://images.example/test", {
      lookup: async () => [
        {
          address: ++resolutions === 1 ? "93.184.216.34" : "fd00::1",
          family: resolutions === 1 ? 4 : 6,
        },
      ],
      fetchImpl: async () => {
        sends++;
        return new Response(
          new ReadableStream({
            cancel() {
              canceled++;
            },
          }),
          {
            status: 307,
            headers: { location: "/rebound" },
          }
        );
      },
    }),
    /blocked/i
  );
  assert.equal(resolutions, 2);
  assert.equal(sends, 1);
  assert.equal(canceled, 1);
});

test("configured proxy denies real pinned media and webhook before DNS or any socket", async (t) => {
  const { installPinnedTransport } = await import("../helpers/pinnedTransport.ts");
  const { fetchWebhookUrl } = await import("../../src/shared/network/webhookFetch.ts");
  const { deliverWebhook } = await import("../../src/lib/webhookDispatcher.ts");
  const saved = process.env.HTTPS_PROXY;
  const noProxy = process.env.NO_PROXY;
  process.env.HTTPS_PROXY = "http://proxy.invalid:8080";
  process.env.NO_PROXY = "*";
  t.after(() => {
    if (saved === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved;
    if (noProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = noProxy;
  });
  const transport = installPinnedTransport(t.mock);
  t.after(transport.restore);
  await assert.rejects(fetchRemoteImage("https://images.example/test"), /proxy policy/i);
  await assert.rejects(
    fetchWebhookUrl("https://images.example/hook", {
      method: "POST",
      headers: { Authorization: "Bearer private" },
      body: "secret payload",
    }),
    /proxy policy/i
  );
  let timers = 0;
  const originalTimer = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay?: number) => {
    if ([1000, 2000, 4000].includes(delay ?? 0)) timers++;
    return originalTimer(callback, delay);
  });
  const result = await deliverWebhook(
    "https://images.example/hook",
    {
      event: "test.ping",
      timestamp: "2026-09-29",
      data: {},
    },
    "secret",
    3
  );
  assert.equal(result.success, false);
  assert.equal(timers, 0, "proxy policy denial is not retried");
  assert.equal(transport.resolutions.length, 0);
  assert.equal(transport.dials.length, 0);
});

test("mutable URL inputs are snapshotted before asynchronous resolution", async () => {
  const input = new URL("https://images.example/ok");
  const seen: string[] = [];
  const pending = fetchRemoteImage(input, {
    lookup: async () => {
      input.hostname = "127.0.0.1";
      return publicLookup();
    },
    fetchImpl: async (url) => {
      seen.push(String(url));
      return new Response("ok");
    },
  });
  await pending;
  assert.deepEqual(seen, ["https://images.example/ok"]);
});
