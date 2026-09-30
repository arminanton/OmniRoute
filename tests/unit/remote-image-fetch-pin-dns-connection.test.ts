/**
 * Exercise the real Undici fetch, connector, HTTP parser, and response streams.
 * Only net.connect/tls.connect are replaced. No DNS or network sockets are used.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns";
import { Request as UndiciRequest } from "undici";

import {
  installPinnedTransport,
  type FakePinnedTransportOptions,
} from "../helpers/pinnedTransport";

import {
  createPinnedFetch,
  defaultDnsLookup,
  resolveHostnameAddresses,
} from "@/shared/network/dnsPinnedFetch";

const openResponse = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nopen\r\n";

function fakeTransport(t: TestContext, options: FakePinnedTransportOptions = {}) {
  const transport = installPinnedTransport(t.mock, options);
  t.after(transport.restore);
  return transport;
}

const bounded = () => ({ signal: AbortSignal.timeout(1500) });

for (const all of [false, true]) {
  for (const [address, family] of [
    ["93.184.216.34", 4],
    ["2606:4700:4700::1111", 6],
  ] as const) {
    test(`pinned lookup supports all:${all}, IPv${family}, and preserves HTTP Host`, async (t) => {
      const transport = fakeTransport(t, { all });
      const response = await createPinnedFetch(address, family)(
        "http://images.example:8080/probe?q=1",
        bounded()
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "pinned");
      assert.deepEqual(transport.lookups, [{ hostname: "images.example", all, address, family }]);
      assert.equal(transport.dials[0].options.host, "images.example");
      assert.match(transport.sockets[0].request, /^GET \/probe\?q=1 HTTP\/1\.1\r\n/);
      assert.match(transport.sockets[0].request, /\r\nhost: images\.example:8080\r\n/i);
      await transport.sockets[0].closedPromise;
    });
  }
}

test("HTTPS keeps the original servername and Host while dialing the approved address", async (t) => {
  const transport = fakeTransport(t);
  const response = await createPinnedFetch("2606:4700:4700::1111", 6)(
    "https://images.example:8443/probe",
    bounded()
  );
  assert.equal(await response.text(), "pinned");
  assert.equal(transport.dials[0].protocol, "https:");
  assert.equal(transport.dials[0].options.host, "images.example");
  assert.equal(transport.dials[0].options.servername, "images.example");
  assert.equal(transport.sockets[0].remoteAddress, "2606:4700:4700::1111");
  assert.match(transport.sockets[0].request, /\r\nhost: images\.example:8443\r\n/i);
  await transport.sockets[0].closedPromise;
});

test("a DNS rebind cannot cause a second resolver call at connection time", async (t) => {
  const transport = fakeTransport(t);
  let calls = 0;
  t.mock.method(dns.promises, "lookup", async (hostname: string, options: dns.LookupOptions) => {
    assert.equal(hostname, "rebind.example");
    assert.deepEqual(options, { all: true });
    calls++;
    return [{ address: calls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
  });
  const [approved] = await resolveHostnameAddresses("rebind.example", defaultDnsLookup);
  const response = await createPinnedFetch(approved.address, approved.family)(
    "http://rebind.example/probe",
    bounded()
  );
  assert.equal(await response.text(), "pinned");
  assert.equal(calls, 1);
  assert.equal(transport.sockets[0].remoteAddress, approved.address);
  await transport.sockets[0].closedPromise;
});

for (const [address, family, url] of [
  ["93.184.216.34", 4, "http://93.184.216.34/probe"],
  ["2606:4700:4700:0:0:0:0:1111", 6, "http://[2606:4700:4700::1111]/probe"],
  ["2606:4700:4700::1111", 6, "https://[2606:4700:4700::1111]/probe"],
] as const) {
  test(`matching literal stays pinned: ${url}`, async (t) => {
    const transport = fakeTransport(t);
    const response = await createPinnedFetch(address, family)(url, bounded());
    assert.equal(await response.text(), "pinned");
    assert.equal(transport.lookups.length, 0, "Node does not resolve literal addresses");
    assert.equal(transport.sockets[0].remoteAddress, new URL(url).hostname.replace(/^\[|\]$/g, ""));
    if (url.startsWith("https:")) assert.equal(transport.dials[0].options.servername, null);
    await transport.sockets[0].closedPromise;
  });
}

for (const url of [
  "http://127.0.0.1/probe",
  "https://127.0.0.1/probe",
  "http://2130706433/probe",
  "http://[::1]/probe",
  "https://[::ffff:127.0.0.1]/probe",
]) {
  test(`a mismatched literal cannot bypass the lookup pin: ${url}`, async (t) => {
    const transport = fakeTransport(t);
    await assert.rejects(createPinnedFetch("93.184.216.34", 4)(url, bounded()));
    assert.equal(transport.dials.length, 0);
  });
}

test("invalid pins fail before opening a socket", (t) => {
  const transport = fakeTransport(t);
  for (const [address, family] of [
    ["", 4],
    ["example.com", 4],
    ["127.1", 4],
    ["93.184.216.34", 6],
    ["::1", 4],
    ["93.184.216.34", 0],
    ["93.184.216.34", NaN],
    ["fe80::1%eth0", 6],
  ] as const) {
    assert.throws(() => createPinnedFetch(address, family), /address|family/i);
  }
  assert.equal(transport.dials.length, 0);
});

for (const redirect of [undefined, "follow", "manual"] as const) {
  test(`redirect mode ${redirect ?? "default"} cannot auto-follow any destination`, async (t) => {
    const transport = fakeTransport(t, {
      reply: (socket) =>
        socket.push(
          "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/internal\r\nContent-Length: 0\r\n\r\n"
        ),
    });
    const response = await createPinnedFetch("93.184.216.34", 4)("http://images.example/probe", {
      ...bounded(),
      redirect,
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "http://127.0.0.1/internal");
    assert.equal(transport.dials.length, 1);
    await response.body?.cancel();
    await transport.sockets[0].closedPromise;
  });
}

test("redirect:error still rejects and cleans up the socket", async (t) => {
  const transport = fakeTransport(t, {
    reply: (socket) =>
      socket.push(
        "HTTP/1.1 302 Found\r\nLocation: http://other.example/probe\r\nContent-Length: 0\r\n\r\n"
      ),
  });
  await assert.rejects(
    createPinnedFetch("93.184.216.34", 4)("http://images.example/probe", {
      ...bounded(),
      redirect: "error",
    })
  );
  assert.equal(transport.dials.length, 1);
  await transport.sockets[0].closedPromise;
});

test("a returned fetch can be reused and gives each call its own bounded dispatcher", async (t) => {
  const transport = fakeTransport(t);
  const fetch = createPinnedFetch("93.184.216.34", 4);
  for (let i = 0; i < 2; i++) {
    const response = await fetch("http://images.example/probe", bounded());
    assert.equal(await response.text(), "pinned");
    await transport.sockets[i].closedPromise;
  }
  assert.equal(transport.dials.length, 2);
});

test("response headers return before an unfinished body; cancelling closes the socket", async (t) => {
  const transport = fakeTransport(t, { reply: (socket) => socket.push(openResponse) });
  const response = await createPinnedFetch("93.184.216.34", 4)(
    "http://images.example/probe",
    bounded()
  );
  assert.equal(response.status, 200);
  assert.equal(transport.sockets[0].destroyed, false);
  await response.body!.cancel();
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[0].destroyed, true);
});

test("abort after headers closes an unfinished response socket", async (t) => {
  const transport = fakeTransport(t, { reply: (socket) => socket.push(openResponse) });
  const controller = new AbortController();
  const response = await createPinnedFetch("93.184.216.34", 4)("http://images.example/probe", {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(response.text(), { name: "AbortError" });
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[0].destroyed, true);
});

test(
  "abort during connection closes the pending socket without a DNS retry",
  { timeout: 1000 },
  async (t) => {
    const transport = fakeTransport(t, { connectImmediately: false });
    const controller = new AbortController();
    const request = createPinnedFetch("93.184.216.34", 4)("http://images.example/probe", {
      signal: controller.signal,
    });
    await transport.dialed;
    controller.abort();
    await assert.rejects(request, { name: "AbortError" });
    await transport.sockets[0].closedPromise;
    assert.equal(transport.dials.length, 1);
  }
);

test("connection failure closes the socket and never retries via DNS", async (t) => {
  const transport = fakeTransport(t, { connectError: new Error("synthetic connect failure") });
  await assert.rejects(
    createPinnedFetch("93.184.216.34", 4)("http://images.example/probe", bounded())
  );
  await transport.sockets[0].closedPromise;
  assert.equal(transport.dials.length, 1);
});

test("EOF-delimited response completes and closes its socket", async (t) => {
  const transport = fakeTransport(t, {
    reply: (socket) => {
      socket.push("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\npinned");
      socket.push(null);
    },
  });
  const response = await createPinnedFetch("93.184.216.34", 4)(
    "http://images.example/probe",
    bounded()
  );
  assert.equal(await response.text(), "pinned");
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[0].destroyed, true);
});

test("a caller-supplied dispatcher cannot replace the pinned dispatcher", async (t) => {
  const transport = fakeTransport(t);
  const options = {
    ...bounded(),
    dispatcher: { dispatch: () => assert.fail("unapproved dispatcher used") },
  };
  const response = await createPinnedFetch("93.184.216.34", 4)(
    new URL("http://images.example/probe"),
    options
  );
  assert.equal(await response.text(), "pinned");
  assert.equal(transport.sockets[0].remoteAddress, "93.184.216.34");
  await transport.sockets[0].closedPromise;
});

test("a pre-aborted request does not open a socket", async (t) => {
  const transport = fakeTransport(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createPinnedFetch("93.184.216.34", 4)("http://images.example/probe", {
      signal: controller.signal,
    }),
    { name: "AbortError" }
  );
  assert.equal(transport.dials.length, 0);
});

test("a Request cannot opt back into automatic redirects", async (t) => {
  const transport = fakeTransport(t, {
    reply: (socket) =>
      socket.push(
        "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/internal\r\nContent-Length: 0\r\n\r\n"
      ),
  });
  const request = new UndiciRequest("http://images.example/probe", {
    ...bounded(),
    redirect: "follow",
  });
  const response = await createPinnedFetch("93.184.216.34", 4)(request as unknown as Request);
  assert.equal(response.status, 302);
  assert.equal(transport.dials.length, 1);
  await response.body?.cancel();
  await transport.sockets[0].closedPromise;
});

test("a Request signal aborts a pending TLS connection promptly", { timeout: 1000 }, async (t) => {
  const transport = fakeTransport(t, { connectImmediately: false });
  const controller = new AbortController();
  const input = new UndiciRequest("https://images.example/probe", { signal: controller.signal });
  const request = createPinnedFetch("93.184.216.34", 4)(input as unknown as Request);
  await transport.dialed;
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  await transport.sockets[0].closedPromise;
  assert.equal(transport.dials.length, 1);
});

test("cancelling one call does not destroy another call made with the same pinned fetch", async (t) => {
  const transport = fakeTransport(t, { reply: (socket) => socket.push(openResponse) });
  const fetch = createPinnedFetch("93.184.216.34", 4);
  const [first, second] = await Promise.all([
    fetch("http://images.example/first", bounded()),
    fetch("http://images.example/second", bounded()),
  ]);
  await first.body!.cancel();
  await transport.sockets[0].closedPromise;
  assert.equal(transport.sockets[1].destroyed, false);
  transport.sockets[1].push("0\r\n\r\n");
  assert.equal(await second.text(), "open");
  await transport.sockets[1].closedPromise;
  assert.equal(transport.dials.length, 2);
});

test("a truncated response rejects and releases its socket", async (t) => {
  const transport = fakeTransport(t, { reply: (socket) => socket.push(openResponse) });
  const response = await createPinnedFetch("93.184.216.34", 4)(
    "http://images.example/probe",
    bounded()
  );
  const body = response.text();
  transport.sockets[0].push(null);
  await assert.rejects(body);
  await transport.sockets[0].closedPromise;
});
