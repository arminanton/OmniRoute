import {
  RequestTransportTelemetry,
  runWithRequestTransportTelemetry,
} from "../../open-sse/utils/transportTelemetry.ts";
import {
  budgetedGenerationFetch,
  runGenerationDispatch,
} from "../../open-sse/services/logicalRetryBudget.ts";
import assert from "node:assert/strict";
import test from "node:test";
import http2 from "node:http2";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fetch as nativeFetch } from "undici";
import { ProviderHttp2Pool } from "../../open-sse/utils/transport/providerHttp2.ts";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "omni-h2-native-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-sha256",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-keyout",
    path.join(directory, "key.pem"),
    "-out",
    path.join(directory, "cert.pem"),
  ],
  { stdio: "ignore" }
);
const key = fs.readFileSync(path.join(directory, "key.pem"));
const cert = fs.readFileSync(path.join(directory, "cert.pem"));
const context = { provider: "fixture", hasApplicationProxy: false, requiresTlsFingerprint: false };
const fetcher = (url: string, init: RequestInit) =>
  nativeFetch(url, init as Parameters<typeof nativeFetch>[1]) as unknown as Promise<Response>;
test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

async function fixture(
  t: test.TestContext,
  handler: (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void,
  maxConcurrentStreams = 2
) {
  const server = http2.createSecureServer({ key, cert, settings: { maxConcurrentStreams } });
  const sessions = new Set<http2.ServerHttp2Session>();
  let sessionCount = 0;
  server.on("session", (session) => {
    sessionCount++;
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    stream.on("error", () => {});
    handler(stream, headers);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `https://127.0.0.1:${address.port}`;
  const pool = new ProviderHttp2Pool({
    verifiedOrigins: { fixture: [url] },
    ca: cert,
    maxConcurrentRequests: 8,
    terminalEvents: ["[DONE]"],
  });
  t.after(async () => {
    await pool.close(true);
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url, pool, sessions: () => sessionCount };
}

test(
  "100 real TLSH2 POST conversations obey remote SETTINGS on a single multiplexed socket",
  { timeout: 30000 },
  async (t) => {
    let active = 0,
      peak = 0,
      calls = 0;
    const { url, pool, sessions } = await fixture(t, (stream) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      stream.resume();
      setTimeout(() => {
        stream.respond({ ":status": 200, "content-type": "text/event-stream" });
        stream.end("data: [DONE]\n\n");
        active--;
      }, 15);
    });
    const bodies = await Promise.all(
      Array.from({ length: 100 }, () =>
        pool
          .fetch(`${url}/responses`, { method: "POST", body: "fixture" }, context, fetcher)
          .then((r) => r.text())
      )
    );
    assert.equal(calls, 100);
    assert.equal(bodies.length, 100);
    assert.ok(peak > 1, "concurrent streams demonstrate H2 lanes rather than H1 pipelining");
    assert.ok(peak <= 2, `remote SETTINGS limit2 exceeded:${peak}`);
    assert.equal(sessions(), 1);
    assert.deepEqual(
      pool.stats().map((p) => p.active),
      [0]
    );
  }
);

test(
  "GOAWAY retires the session without replaying an already accepted stream",
  { timeout: 15000 },
  async (t) => {
    const requests: string[] = [];
    const { url, pool, sessions } = await fixture(t, (stream, headers) => {
      const route = String(headers[":path"]);
      requests.push(route);
      stream.resume();
      stream.respond({ ":status": 200, "content-length": "9" });
      stream.write("first");
      if (route === "/old") stream.session!.goaway(http2.constants.NGHTTP2_NO_ERROR, stream.id);
      setTimeout(() => stream.end("done"), 30);
    });
    const old = await pool.fetch(`${url}/old`, { method: "POST", body: "old" }, context, fetcher);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await pool.fetch(
      `${url}/next`,
      { method: "POST", body: "next" },
      context,
      fetcher
    );
    assert.equal(await old.text(), "firstdone");
    assert.equal(await next.text(), "firstdone");
    assert.deepEqual(requests, ["/old", "/next"]);
    assert.equal(sessions(), 2);
  }
);

test(
  "RST_STREAM after output is an interrupted response, never an automatic POST replay",
  { timeout: 15000 },
  async (t) => {
    let calls = 0;
    const { url, pool } = await fixture(t, (stream) => {
      calls++;
      stream.resume();
      stream.respond({ ":status": 200, "content-type": "text/event-stream" });
      stream.write("data: started\n\n");
      setTimeout(() => stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR), 20);
    });
    const response = await pool.fetch(
      `${url}/reset`,
      { method: "POST", body: "tool turn" },
      context,
      fetcher
    );
    await assert.rejects(response.text());
    assert.equal(calls, 1);
    assert.deepEqual(
      pool.stats().map((p) => p.active),
      [0]
    );
  }
);

test(
  "cancelled stream releases native lane and admission capacity",
  { timeout: 15000 },
  async (t) => {
    let calls = 0;
    const { url } = await fixture(t, (stream) => {
      calls++;
      stream.resume();
      stream.respond({ ":status": 200, "content-length": calls > 1 ? "15" : "7" });
      stream.write("started");
      if (calls > 1) stream.end("finished");
    });
    const pool = new ProviderHttp2Pool({
      verifiedOrigins: { fixture: [url] },
      ca: cert,
      maxConcurrentRequests: 1,
      maxQueuedRequests: 1,
      terminalEvents: ["[DONE]"],
    });
    t.after(() => pool.close(true));
    const first = await pool.fetch(
      `${url}/first`,
      { method: "POST", body: "first" },
      context,
      fetcher
    );
    const controller = new AbortController();
    const waiting = pool.fetch(
      `${url}/waiting`,
      { method: "POST", body: "next", signal: controller.signal },
      context,
      fetcher
    );
    const rejected = assert.rejects(waiting, /cancel/i);
    controller.abort();
    await rejected;
    await assert.rejects(
      pool.fetch(
        `${url}/full`,
        { method: "POST", body: "next", signal: AbortSignal.abort() },
        context,
        fetcher
      )
    );
    assert.equal(calls, 1);
    await first.body!.cancel();
    const next = await pool.fetch(
      `${url}/next`,
      { method: "POST", body: "next" },
      context,
      fetcher
    );
    assert.equal(await next.text(), "startedfinished");
    assert.equal(calls, 2);
  }
);

test(
  "verified origin with H1-only ALPN retains HTTP/1 compatibility",
  { timeout: 15000 },
  async (t) => {
    const server = https.createServer({ key, cert }, (req, res) => {
      assert.equal(req.httpVersionMajor, 1);
      req.resume();
      res.end("H1 compatible");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `https://127.0.0.1:${address.port}`;
    const pool = new ProviderHttp2Pool({
      verifiedOrigins: { fixture: [url] },
      ca: cert,
      terminalEvents: ["[DONE]"],
    });
    t.after(async () => {
      await pool.close(true);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    assert.equal(
      await (await pool.fetch(url, { method: "POST", body: "fixture" }, context, fetcher)).text(),
      "H1 compatible"
    );
  }
);

test(
  "configured proxy selection and fingerprint requirement retain the existing transport",
  { timeout: 15000 },
  async (t) => {
    let proxyCalls = 0,
      upstreamCalls = 0;
    const proxy = http.createServer((req, res) => {
      proxyCalls++;
      req.resume();
      res.end("proxy path");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    assert.ok(address && typeof address !== "string");
    t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const { url, pool } = await fixture(t, (stream) => {
      upstreamCalls++;
      stream.respond({ ":status": 200 });
      stream.end();
    });
    const fallback = (_url: string, init: RequestInit) =>
      fetcher(`http://127.0.0.1:${address.port}`, init);
    for (const selected of [
      { ...context, hasApplicationProxy: true },
      { ...context, requiresTlsFingerprint: true },
    ]) {
      assert.equal(
        await (
          await pool.fetch(url, { method: "POST", body: "fixture" }, selected, fallback)
        ).text(),
        "proxy path"
      );
    }
    assert.equal(proxyCalls, 2);
    assert.equal(upstreamCalls, 0);
    assert.equal(pool.stats().length, 0);
  }
);

test(
  "ordinary direct dispatcher options negotiate H1 while verified factory negotiates H2",
  { timeout: 15000 },
  async (t) => {
    const { Agent } = await import("undici");
    const { __getDefaultDispatcherOptionsForTest } =
      await import("../../open-sse/utils/proxyDispatcher.ts");
    const protocols: number[] = [];
    const server = http2.createSecureServer({ key, cert, allowHTTP1: true }, (req, res) => {
      protocols.push(req.httpVersionMajor);
      req.resume();
      const text = `protocol:${req.httpVersionMajor}`;
      res.setHeader("Content-Length", Buffer.byteLength(text));
      res.end(text);
    });
    const sessions = new Set<http2.ServerHttp2Session>();
    server.on("session", (session) => {
      sessions.add(session);
      session.on("close", () => sessions.delete(session));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `https://127.0.0.1:${address.port}`;
    const ordinaryOptions = __getDefaultDispatcherOptionsForTest({
      OMNIROUTE_DIRECT_DISPATCHER_CONNECTIONS: "1",
    });
    assert.equal(ordinaryOptions.allowH2, false);
    const ordinary = new Agent({ ...ordinaryOptions, connect: { ca: cert } });
    const verified = new ProviderHttp2Pool({
      verifiedOrigins: { fixture: [url] },
      ca: cert,
      terminalEvents: ["[DONE]"],
    });
    t.after(async () => {
      await ordinary.destroy();
      await verified.close(true);
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    assert.equal(await (await nativeFetch(url, { dispatcher: ordinary })).text(), "protocol:1");
    assert.equal(
      await (
        await verified.fetch(url, { method: "POST", body: "fixture" }, context, fetcher)
      ).text(),
      "protocol:2"
    );
    assert.deepEqual(protocols, [1, 2]);
  }
);

test(
  "response.failed and response.incomplete are terminal events, truncated framing is not",
  { timeout: 15000 },
  async (t) => {
    const { url, pool } = await fixture(t, (stream, headers) => {
      stream.resume();
      stream.respond({ ":status": 200, "content-type": "text/event-stream" });
      const type = String(headers[":path"]).slice(1);
      stream.end(`data: ${JSON.stringify({ type })}\n\n`);
    });
    const terminal = new ProviderHttp2Pool({
      verifiedOrigins: { fixture: [url] },
      ca: cert,
      terminalEvents: ["response.completed", "response.failed", "response.incomplete"],
    });
    t.after(() => terminal.close(true));
    for (const type of ["response.failed", "response.incomplete"]) {
      const response = await terminal.fetch(
        `${url}/${type}`,
        { method: "POST", body: "fixture" },
        context,
        fetcher
      );
      assert.match(await response.text(), new RegExp(type.replace(".", "\\.")));
    }
    const truncated = await pool.fetch(
      `${url}/response.output_text.delta`,
      { method: "POST", body: "fixture" },
      context,
      fetcher
    );
    await assert.rejects(truncated.text(), /terminal SSE completion/);
  }
);

test(
  "REFUSED_STREAM consumes one physical attempt; explicit caller retry owns recovery",
  { timeout: 15000 },
  async (t) => {
    let calls = 0;
    const { url, pool } = await fixture(t, (stream) => {
      calls++;
      stream.resume();
      if (calls === 1) {
        stream.close(http2.constants.NGHTTP2_REFUSED_STREAM);
        return;
      }
      stream.respond({ ":status": 200, "content-type": "text/event-stream" });
      stream.end("data: [DONE]\n\n");
    });
    await assert.rejects(
      pool.fetch(`${url}/refused`, { method: "POST", body: "generation" }, context, fetcher)
    );
    assert.equal(calls, 1, "dependency must not spend a second unobserved physical POST attempt");
    const recovered = await pool.fetch(
      `${url}/refused`,
      { method: "POST", body: "generation" },
      context,
      fetcher
    );
    assert.equal(await recovered.text(), "data: [DONE]\n\n");
    assert.equal(calls, 2);
  }
);

test(
  "real TLS/H2 owned telemetry observes dispatch, headers, bytes and EOF without invented TCP timing",
  { timeout: 15000 },
  async (t) => {
    const { url, pool } = await fixture(t, (stream) => {
      stream.resume();
      setTimeout(() => {
        stream.respond({ ":status": 200, "content-type": "text/event-stream" });
        stream.write(": keepalive\n\nda");
        setTimeout(() => stream.end("ta: [DONE]\n\n"), 10);
      }, 10);
    });
    const telemetry = new RequestTransportTelemetry(undefined, () => {});
    const body = await runWithRequestTransportTelemetry(telemetry, () =>
      runGenerationDispatch(async () => {
        const response = await pool.fetch(
          `${url}/responses`,
          { method: "POST", body: "fixture" },
          context,
          budgetedGenerationFetch(fetcher)
        );
        return response.text();
      })
    );
    assert.equal(body, ": keepalive\n\ndata: [DONE]\n\n");
    const snapshot = telemetry.snapshot();
    const attempt = snapshot.attempts[0];
    assert.equal(snapshot.transportAdmissionCount, 1);
    assert.notEqual(attempt.queuedMs, null);
    assert.notEqual(attempt.dispatchedMs, null);
    assert.notEqual(attempt.headersMs, null);
    assert.notEqual(attempt.firstEventMs, null);
    assert.equal(attempt.bytes, Buffer.byteLength(body));
    assert.equal(attempt.closure, "eof");
    assert.equal(attempt.tcpMs, null);
    assert.equal(attempt.tlsMs, null);
    assert.equal(attempt.uploadMs, null);
  }
);
