/**
 * Real Undici fetch/connector tests without any real DNS or network sockets.
 * Install with a node:test MockTracker; restore only this fixture's patches.
 */
import assert from "node:assert/strict";
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import { STATUS_CODES } from "node:http";
import { Duplex, addAbortSignal } from "node:stream";
import type { TestContext } from "node:test";

export interface FakeAddress {
  address: string;
  family: number;
}

export interface FakeDialOptions {
  host: string;
  port: string | number;
  servername?: string | null;
  signal?: AbortSignal;
  lookup?: (
    hostname: string,
    options: { all: boolean },
    callback: (error: Error | null, address: unknown, family?: number) => void
  ) => void;
}

export interface FakeDial {
  protocol: "http:" | "https:";
  options: FakeDialOptions;
}

export class FakePinnedSocket extends Duplex {
  request = "";
  remoteAddress = "";
  remoteFamily = "";
  remotePort = 0;
  alpnProtocol = "http/1.1";
  private replied = false;
  readonly closedPromise: Promise<void>;

  constructor(private readonly reply: (socket: FakePinnedSocket) => unknown) {
    super();
    this.closedPromise = new Promise((resolve) => this.once("close", resolve));
  }

  _read() {}

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.request += chunk.toString();
    callback();
    if (!this.replied && this.request.includes("\r\n\r\n")) {
      this.replied = true;
      queueMicrotask(() => {
        if (this.destroyed) return;
        try {
          void Promise.resolve(this.reply(this)).catch((error: Error) => this.destroy(error));
        } catch (error) {
          this.destroy(error as Error);
        }
      });
    }
  }

  /** Send a complete, content-length-framed response, including binary bodies. */
  respond({
    status = 200,
    headers = {},
    body = "",
  }: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  } = {}) {
    const bytes = Buffer.from(body);
    const responseHeaders = new Headers(headers);
    responseHeaders.set("content-length", String(bytes.length));
    const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Response"}`];
    for (const [key, value] of responseHeaders) lines.push(`${key}: ${value}`);
    this.push(Buffer.concat([Buffer.from(`${lines.join("\r\n")}\r\n\r\n`), bytes]));
  }

  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

export interface FakePinnedTransportOptions {
  /** Simulate Node's all-address vs single-address lookup callback contract. */
  all?: boolean;
  reply?: (socket: FakePinnedSocket, dial: FakeDial) => unknown;
  /** Only explicit test data can stand in for pre-connect DNS validation. */
  dnsLookup?: (hostname: string) => FakeAddress[] | Promise<FakeAddress[]>;
  connectError?: Error;
  connectImmediately?: boolean;
}

export function installPinnedTransport(
  mock: TestContext["mock"],
  {
    all = true,
    reply = (socket) => socket.respond({ body: "pinned" }),
    dnsLookup,
    connectError,
    connectImmediately = true,
  }: FakePinnedTransportOptions = {}
) {
  const sockets: FakePinnedSocket[] = [];
  const dials: FakeDial[] = [];
  const lookups: { hostname: string; all: boolean; address: string; family: number }[] = [];
  const resolutions: { hostname: string; options: dns.LookupOptions }[] = [];
  let notifyDial: () => void;
  const dialed = new Promise<void>((resolve) => {
    notifyDial = resolve;
  });
  const patches: { mock: { restore: () => void } }[] = [];
  let restored = false;

  // Never let an accidental fallback access the real resolver or socket API.
  // This also catches a previously captured net.connect/createConnection import.
  patches.push(
    mock.method(net.Socket.prototype, "connect", () => {
      throw new Error("Unexpected real socket connection");
    })
  );
  patches.push(
    mock.method(dns, "lookup", () => {
      throw new Error("Unexpected OS DNS lookup");
    })
  );
  patches.push(
    mock.method(dns.promises, "lookup", async (hostname: string, options: dns.LookupOptions) => {
      resolutions.push({ hostname, options });
      if (!dnsLookup) throw new Error("Unexpected DNS promise lookup");
      assert.equal(options?.all, true, "prevalidation must inspect every DNS answer");
      return dnsLookup(hostname);
    })
  );
  patches.push(
    mock.method(net, "createConnection", () => {
      throw new Error("Unexpected socket API");
    })
  );

  function dial(protocol: FakeDial["protocol"], options: FakeDialOptions) {
    assert.equal(restored, false, "connection after fixture cleanup");
    const recorded = { protocol, options };
    dials.push(recorded);
    const socket = new FakePinnedSocket((socket) => reply(socket, recorded));
    if (options.signal) addAbortSignal(options.signal, socket);
    sockets.push(socket);
    notifyDial();
    queueMicrotask(() => {
      if (socket.destroyed) return;
      if (connectError) {
        socket.destroy(connectError);
        return;
      }
      // Model Node's literal fast path. It bypasses a custom lookup entirely.
      let family = net.isIP(options.host);
      let address = options.host;
      if (!family) {
        assert.equal(typeof options.lookup, "function", "a DNS pin is required");
        let called = false;
        options.lookup!(options.host, { all }, (error, result, resolvedFamily) => {
          assert.equal(error, null);
          called = true;
          if (all) {
            assert.ok(Array.isArray(result), "all:true requires an address array");
            assert.equal(result.length, 1);
            address = result[0].address;
            family = result[0].family;
          } else {
            assert.equal(typeof result, "string", "single lookup requires an address string");
            address = result as string;
            family = resolvedFamily!;
          }
        });
        assert.equal(called, true);
        lookups.push({ hostname: options.host, all, address, family });
      }
      socket.remoteAddress = address;
      socket.remoteFamily = `IPv${family}`;
      socket.remotePort = Number(options.port);
      if (connectImmediately) socket.emit(protocol === "https:" ? "secureConnect" : "connect");
    });
    return socket;
  }

  patches.push(mock.method(net, "connect", (options: FakeDialOptions) => dial("http:", options)));
  patches.push(mock.method(tls, "connect", (options: FakeDialOptions) => dial("https:", options)));
  function restore() {
    if (restored) return;
    restored = true;
    for (const socket of sockets) socket.destroy();
    for (const patch of patches.reverse()) patch.mock.restore();
  }
  return { sockets, dials, lookups, resolutions, dialed, restore };
}
