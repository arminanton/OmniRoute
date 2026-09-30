// GHSA-474q-g63r-w4rr: Obsidian bases are operator-controlled. Local/LAN/Tailscale
// vaults remain supported, but metadata/link-local targets and redirects never are.
// Exercise the real Undici pinned connector through fake net/tls sockets, not fetch.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { makeManagementSessionRequest } from "../helpers/managementSession.ts";
import {
  installPinnedTransport,
  type FakePinnedTransportOptions,
} from "../helpers/pinnedTransport.ts";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];
const ENV_KEYS = [
  ...PROXY_ENV_KEYS,
  "DATA_DIR",
  "JWT_SECRET",
  "API_KEY_SECRET",
  "APP_LOG_TO_FILE",
  "DISABLE_SQLITE_AUTO_BACKUP",
  "OMNIROUTE_HIDE_HEALTHCHECK_LOGS",
];
const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-obsidian-ssrf-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "obsidian-ssrf-fixture-jwt-secret";
process.env.API_KEY_SECRET = "obsidian-ssrf-fixture-api-secret";
process.env.APP_LOG_TO_FILE = "false";
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_HIDE_HEALTHCHECK_LOGS = "true";
for (const key of PROXY_ENV_KEYS) delete process.env[key];

const core = await import("../../src/lib/db/core.ts");
const { createObsidianClient } = await import("../../src/lib/obsidian/api.ts");
const { safeOutboundFetch, SafeOutboundFetchError } =
  await import("../../src/shared/network/safeOutboundFetch.ts");
const { runWithProxyContext } = await import("../../open-sse/utils/proxyFetch.ts");
const TOKEN = "obsidian-fixture-token";
const STATUS_JSON = JSON.stringify({ authenticated: true });

test.beforeEach(() => {
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function transport(t: TestContext, options: FakePinnedTransportOptions = {}) {
  const fixture = installPinnedTransport(t.mock, {
    reply: (socket) =>
      socket.respond({
        headers: { "content-type": "application/json" },
        body: STATUS_JSON,
      }),
    ...options,
  });
  t.after(() => fixture.restore());
  return fixture;
}

async function assertClosed(fixture: ReturnType<typeof installPinnedTransport>) {
  await Promise.all(fixture.sockets.map((socket) => socket.closedPromise));
  assert.ok(fixture.sockets.every((socket) => socket.destroyed));
}

function pinnedOptions() {
  return {
    guard: "block-metadata" as const,
    pinDns: true,
    allowRedirect: false,
    retry: false as const,
    timeoutMs: 1000,
    headers: { Authorization: `Bearer ${TOKEN}` },
  };
}

function isNonRetryable(error: unknown) {
  assert.ok(error instanceof SafeOutboundFetchError);
  assert.equal(error.isRetryable, false);
  return true;
}

test("obsidianFetch never dials the cloud-metadata endpoint", async (t) => {
  const fixture = transport(t);
  const client = createObsidianClient(TOKEN, "http://169.254.169.254");
  await assert.rejects(() => client.checkStatus(), /metadata|blocked/i);
  assert.deepEqual(fixture.dials, []);
  assert.deepEqual(fixture.resolutions, []);
});

test("obsidianFetch blocks metadata names, expanded mapped IPv4, and all link-local forms", async (t) => {
  const fixture = transport(t);
  for (const baseUrl of [
    "http://[::ffff:169.254.169.254]",
    "http://[0:0:0:0:0:ffff:a9fe:a9fe]",
    "http://[::ffff:169.254.10.20]",
    "http://169.254.10.20:27123",
    "http://metadata.google.internal:27123",
    "http://metadata.goog:27123",
    "http://100.100.100.200:27123",
    "http://[fd00:ec2::254]:27123",
    "http://[fe80::1]:27123",
    "http://[fe90::1]:27123",
    "http://[febf::1]:27123",
  ]) {
    await assert.rejects(
      createObsidianClient(TOKEN, baseUrl).checkStatus(),
      /metadata|blocked/i,
      baseUrl
    );
  }
  assert.deepEqual(fixture.dials, [], "no blocked address receives credentials");
  assert.deepEqual(fixture.resolutions, []);
});

test(
  "obsidianFetch still reaches loopback, LAN, Tailscale, and private IPv6 bases",
  { timeout: 10000 },
  async (t) => {
    const fixture = transport(t);
    for (const baseUrl of [
      "http://127.0.0.1:27123",
      "http://10.0.0.42:27123",
      "http://192.168.1.42:27123",
      "http://100.64.0.1:27123",
      "http://[::1]:27123",
      "http://[fd12:3456::1]:27123",
    ]) {
      const before = fixture.dials.length;
      const status = await createObsidianClient(TOKEN, baseUrl).checkStatus();
      assert.deepEqual(status, { authenticated: true }, baseUrl);
      assert.equal(fixture.dials.length, before + 1);
      const socket = fixture.sockets.at(-1)!;
      assert.equal(socket.remoteAddress, new URL(baseUrl).hostname.replace(/^\[|\]$/g, ""));
      assert.match(socket.request, /^GET \/ HTTP\/1\.1/m);
      assert.match(socket.request, /authorization: Bearer obsidian-fixture-token/i);
    }
    assert.deepEqual(fixture.resolutions, [], "literals need no DNS lookup");
    await assertClosed(fixture);
  }
);

test(
  "Obsidian DNS rebinding cannot change the approved credential-bearing dial",
  { timeout: 5000 },
  async (t) => {
    let answers = 0;
    const fixture = transport(t, {
      dnsLookup: () => {
        answers++;
        return [{ address: answers === 1 ? "10.0.0.42" : "169.254.169.254", family: 4 }];
      },
    });
    const client = createObsidianClient(TOKEN, "https://vault.example:27123");
    await client.checkStatus();
    assert.equal(answers, 1, "the connection must not re-resolve the hostname");
    assert.equal(fixture.dials.length, 1);
    assert.equal(fixture.dials[0].options.servername, "vault.example");
    assert.equal(fixture.sockets[0].remoteAddress, "10.0.0.42");
    assert.equal(fixture.lookups[0].address, "10.0.0.42");
    assert.match(fixture.sockets[0].request, /host: vault\.example:27123/i);
    assert.match(fixture.sockets[0].request, /authorization: Bearer obsidian-fixture-token/i);
    await assertClosed(fixture);
  }
);

for (const blocked of [
  { address: "169.254.169.254", family: 4 },
  { address: "169.254.10.20", family: 4 },
  { address: "100.100.100.200", family: 4 },
  { address: "fd00:ec2::254", family: 6 },
  { address: "0:0:0:0:0:ffff:a9fe:a9fe", family: 6 },
  { address: "fe90::1", family: 6 },
]) {
  test(`Obsidian rejects every DNS answer before any credential send: ${blocked.address}`, async (t) => {
    const fixture = transport(t, {
      dnsLookup: () => [{ address: "10.0.0.42", family: 4 }, blocked],
    });
    await assert.rejects(
      createObsidianClient(TOKEN, "http://vault.example:27123").checkStatus(),
      isNonRetryable
    );
    assert.equal(fixture.resolutions.length, 1);
    assert.deepEqual(fixture.dials, []);
  });
}

test("Obsidian DNS errors and empty answers fail closed without a credential send", async (t) => {
  let fail = true;
  const fixture = transport(t, {
    dnsLookup: () => {
      if (fail) throw new Error("fixture DNS failure");
      return [];
    },
  });
  const client = createObsidianClient(TOKEN, "http://vault.example:27123");
  await assert.rejects(client.checkStatus(), isNonRetryable);
  fail = false;
  await assert.rejects(client.checkStatus(), isNonRetryable);
  assert.deepEqual(fixture.dials, []);
});

test(
  "obsidianFetch never follows redirects or retries credential-bearing redirect responses",
  { timeout: 5000 },
  async (t) => {
    let location = "http://169.254.169.254/latest/meta-data/";
    const fixture = transport(t, {
      reply: (socket) => socket.respond({ status: 307, headers: { location } }),
    });
    const client = createObsidianClient(TOKEN, "http://127.0.0.1:27123");
    for (const destination of [location, "https://collector.example/token"]) {
      location = destination;
      const before = fixture.dials.length;
      await assert.rejects(client.checkStatus(), { code: "REDIRECT_BLOCKED", isRetryable: false });
      assert.equal(fixture.dials.length, before + 1, "no retry or redirected request");
    }
    for (const socket of fixture.sockets) {
      assert.equal(socket.remoteAddress, "127.0.0.1");
      assert.match(socket.request, /host: 127\.0\.0\.1:27123/i);
      assert.match(socket.request, /authorization: Bearer obsidian-fixture-token/i);
      assert.doesNotMatch(socket.request, /169\.254|collector\.example/);
    }
    await assertClosed(fixture);
  }
);

test("configured env proxy blocks Obsidian credentials even with local NO_PROXY", async (t) => {
  const fixture = transport(t);
  process.env.HTTPS_PROXY = "http://proxy.example:8080";
  process.env.NO_PROXY = "*";
  await assert.rejects(createObsidianClient(TOKEN).checkStatus(), isNonRetryable);
  assert.deepEqual(fixture.dials, []);
  assert.deepEqual(fixture.resolutions, []);
});

test("inherited required proxy cannot release Obsidian credentials to a local direct socket", async (t) => {
  const fixture = transport(t);
  await assert.rejects(
    runWithProxyContext(
      { type: "http", host: "127.0.0.2", port: 18888 },
      () => createObsidianClient(TOKEN).checkStatus(),
      { requireProxy: true, skipUnreachableProbe: true }
    ),
    (error) => {
      assert.ok(error instanceof SafeOutboundFetchError);
      assert.equal(error.isRetryable, false);
      assert.equal((error.cause as { code?: string })?.code, "PROXY_REQUIRED_EGRESS");
      return true;
    }
  );
  assert.deepEqual(fixture.dials, []);
});

test("stored global proxy blocks Obsidian credentials before any socket", async (t) => {
  const fixture = transport(t);
  const { setProxyForLevel } = await import("../../src/lib/db/settings.ts");
  await setProxyForLevel("global", null, { type: "http", host: "proxy.example", port: 8080 });
  try {
    process.env.NO_PROXY = "*";
    await assert.rejects(createObsidianClient(TOKEN).checkStatus(), isNonRetryable);
    assert.deepEqual(fixture.dials, []);
    assert.deepEqual(fixture.resolutions, []);
  } finally {
    await setProxyForLevel("global", null, null);
  }
});

test(
  "Obsidian enforces its 20 MiB limit from headers and closes without a retry",
  { timeout: 5000 },
  async (t) => {
    const fixture = transport(t, {
      reply: (socket) => socket.push("HTTP/1.1 200 OK\r\nContent-Length: 20971521\r\n\r\n"),
    });
    await assert.rejects(createObsidianClient(TOKEN).checkStatus(), /exceeds 20971520 byte limit/);
    assert.equal(fixture.dials.length, 1);
    await assertClosed(fixture);
  }
);

test(
  "pinned outbound enforces actual streamed bytes without Content-Length",
  { timeout: 5000 },
  async (t) => {
    const fixture = transport(t, {
      reply: (socket) =>
        socket.push("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n12345\r\n"),
    });
    await assert.rejects(
      safeOutboundFetch("http://127.0.0.1:27123", {
        ...pinnedOptions(),
        maxBytes: 4,
        retry: { attempts: 3 },
      }),
      /exceeds 4 byte limit/
    );
    assert.equal(fixture.dials.length, 1);
    await assertClosed(fixture);
  }
);

test(
  "pinned outbound measures decompressed bytes, not only the advertised compressed length",
  { timeout: 5000 },
  async (t) => {
    const compressed = gzipSync(Buffer.alloc(128, "a"));
    assert.ok(compressed.byteLength < 64);
    const fixture = transport(t, {
      reply: (socket) =>
        socket.respond({ headers: { "content-encoding": "gzip" }, body: compressed }),
    });
    await assert.rejects(
      safeOutboundFetch("http://127.0.0.1:27123", { ...pinnedOptions(), maxBytes: 64 }),
      /exceeds 64 byte limit/
    );
    await assertClosed(fixture);
  }
);

test(
  "pinned outbound accepts exactly maxBytes and returns a detached body",
  { timeout: 5000 },
  async (t) => {
    const fixture = transport(t, { reply: (socket) => socket.respond({ body: "1234" }) });
    const response = await safeOutboundFetch("http://127.0.0.1:27123", {
      ...pinnedOptions(),
      maxBytes: 4,
    });
    await assertClosed(fixture);
    assert.equal(await response.text(), "1234");
    assert.equal(response.headers.has("content-length"), false);
  }
);

test("pinned outbound deadline includes a stalled DNS validation", { timeout: 5000 }, async (t) => {
  const fixture = transport(t);
  let lookups = 0;
  await assert.rejects(
    safeOutboundFetch("http://vault.example:27123", {
      ...pinnedOptions(),
      timeoutMs: 50,
      lookup: () => {
        lookups++;
        return new Promise(() => {});
      },
    }),
    { code: "TIMEOUT", isRetryable: false }
  );
  assert.equal(lookups, 1);
  assert.deepEqual(fixture.dials, []);
});

test(
  "pinned outbound deadline stays active after response headers until body completion",
  { timeout: 5000 },
  async (t) => {
    const fixture = transport(t, {
      reply: (socket) => socket.push("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\na"),
    });
    await assert.rejects(
      safeOutboundFetch("http://127.0.0.1:27123", { ...pinnedOptions(), timeoutMs: 50 }),
      { code: "TIMEOUT", isRetryable: false }
    );
    assert.equal(fixture.dials.length, 1);
    await assertClosed(fixture);
  }
);

test(
  "pinned outbound propagates caller abort during DNS without a credential send",
  { timeout: 5000 },
  async (t) => {
    const fixture = transport(t);
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const pending = safeOutboundFetch("http://vault.example:27123", {
      ...pinnedOptions(),
      signal: controller.signal,
      lookup: () => {
        entered.resolve();
        return new Promise(() => {});
      },
    });
    const rejected = assert.rejects(pending, isNonRetryable);
    await entered.promise;
    controller.abort();
    await rejected;
    assert.deepEqual(fixture.dials, []);
  }
);

test(
  "pinned outbound abort closes an in-flight connect before credentials are written",
  { timeout: 5000 },
  async (t) => {
    const fixture = transport(t, { connectImmediately: false });
    const controller = new AbortController();
    const pending = safeOutboundFetch("http://127.0.0.1:27123", {
      ...pinnedOptions(),
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, isNonRetryable);
    await fixture.dialed;
    controller.abort();
    await rejected;
    assert.equal(fixture.dials.length, 1);
    assert.equal(fixture.sockets[0].request, "");
    await assertClosed(fixture);
  }
);

test(
  "pinned outbound caller abort also closes a body stalled after headers",
  { timeout: 5000 },
  async (t) => {
    const started = Promise.withResolvers<void>();
    const fixture = transport(t, {
      reply: (socket) => {
        socket.push("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\na");
        started.resolve();
      },
    });
    const controller = new AbortController();
    const pending = safeOutboundFetch("http://127.0.0.1:27123", {
      ...pinnedOptions(),
      signal: controller.signal,
    });
    const rejected = assert.rejects(pending, isNonRetryable);
    await started.promise;
    controller.abort();
    await rejected;
    await assertClosed(fixture);
  }
);

test(
  "pinned outbound lookup seam is validated and pins the approved address",
  { timeout: 5000 },
  async (t) => {
    const fixture = transport(t);
    let lookups = 0;
    const response = await safeOutboundFetch("http://vault.example:27123", {
      ...pinnedOptions(),
      lookup: async (hostname) => {
        assert.equal(hostname, "vault.example");
        lookups++;
        return [{ address: "100.64.0.42", family: 4 }];
      },
    });
    assert.deepEqual(await response.json(), { authenticated: true });
    assert.equal(lookups, 1);
    assert.deepEqual(fixture.resolutions, [], "only the provided validation lookup runs");
    assert.equal(fixture.sockets[0].remoteAddress, "100.64.0.42");
    await assertClosed(fixture);
  }
);

test("POST /api/settings/obsidian rejects metadata before any dial or persistence", async (t) => {
  const fixture = transport(t);
  const { POST } = await import("../../src/app/api/settings/obsidian/route.ts");
  const { getObsidianBaseUrl } = await import("../../src/lib/db/obsidian.ts");
  const before = getObsidianBaseUrl();
  const request = await makeManagementSessionRequest("http://localhost/api/settings/obsidian", {
    method: "POST",
    body: { baseUrl: "http://169.254.169.254/latest", token: TOKEN },
  });
  const response = await POST(request as never);
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error?: string };
  assert.match(String(body.error), /metadata|blocked/i);
  assert.ok(!String(body.error).includes("at /"), "no stack trace in the error body");
  assert.deepEqual(fixture.dials, []);
  assert.equal(getObsidianBaseUrl(), before, "a blocked baseUrl must not be persisted");
});
