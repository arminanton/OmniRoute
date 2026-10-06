import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { createHash } from "node:crypto";
import * as zlib from "node:zlib";
import {
  prepareZstdUpload,
  fetchWithVerifiedZstd,
} from "../../open-sse/utils/transport/zstdUpload.ts";
import { BoundedAdmission } from "../../open-sse/utils/transport/boundedAdmission.ts";
const decode = (zlib as unknown as { zstdDecompressSync(data: Buffer): Buffer }).zstdDecompressSync;
const body = JSON.stringify({
  input: [
    {
      role: "user",
      content: Array.from(
        { length: 2000 },
        (_, index) =>
          "工具结果：héllo 🌍 ".repeat(20) +
          createHash("sha256").update(String(index)).digest("hex")
      ).join("\n"),
    },
  ],
  tools: [{ name: "read_file" }],
});

async function serverFixture(
  t: test.TestContext,
  handle: (req: http.IncomingMessage, res: http.ServerResponse, data: Buffer) => void
) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${address.port}/responses`;
}

test("verified Zstd uploads preserve large Unicode/tool JSON bytes over a real HTTP socket", async (t) => {
  let calls = 0;
  const url = await serverFixture(t, (req, res, data) => {
    calls++;
    assert.equal(req.headers["content-encoding"], "zstd");
    assert.equal(Number(req.headers["content-length"]), data.length);
    assert.equal(decode(data).toString("utf8"), body);
    assert.ok(data.length < Buffer.byteLength(body) / 10);
    res.end("lossless");
  });
  const response = await fetchWithVerifiedZstd(
    url,
    { method: "POST", body, headers: { "Content-Type": "application/json" } },
    { verifiedEndpoints: [url] },
    fetch
  );
  assert.equal(await response.text(), "lossless");
  assert.equal(calls, 1);
});

test("unverified endpoints and existing content encoding are never silently changed", async () => {
  const init = { method: "POST", body, headers: { "content-encoding": "identity" } };
  const absent = await prepareZstdUpload("https://unverified/responses", init, {
    verifiedEndpoints: [],
  });
  assert.equal(absent.init, init);
  assert.equal(absent.compressed, false);
  const already = await prepareZstdUpload("https://verified/responses", init, {
    verifiedEndpoints: ["https://verified/responses"],
  });
  assert.equal(already.init, init);
  assert.equal(already.compressed, false);
});

test("explicit415 encoding rejection may spend exactly one approved shared retry", async (t) => {
  let calls = 0,
    approvals = 0;
  const url = await serverFixture(t, (req, res, data) => {
    calls++;
    if (calls === 1) {
      assert.equal(req.headers["content-encoding"], "zstd");
      res.writeHead(415, { "Accept-Encoding": "identity" });
      res.end("unsupported encoding");
    } else {
      assert.equal(req.headers["content-encoding"], undefined);
      assert.equal(data.toString("utf8"), body);
      res.end("raw accepted");
    }
  });
  const response = await fetchWithVerifiedZstd(
    url,
    { method: "POST", body },
    { verifiedEndpoints: [url] },
    fetch,
    () => {
      approvals++;
      return true;
    }
  );
  assert.equal(await response.text(), "raw accepted");
  assert.equal(calls, 2);
  assert.equal(approvals, 1);
});

test("ordinary415, budget exhaustion and output-bearing responses never authorize encoding replay", async (t) => {
  let calls = 0,
    approvals = 0;
  const url = await serverFixture(t, (_req, res) => {
    calls++;
    res.writeHead(415);
    res.end("unsupported media type");
  });
  const response = await fetchWithVerifiedZstd(
    url,
    { method: "POST", body },
    { verifiedEndpoints: [url] },
    fetch,
    () => {
      approvals++;
      return true;
    }
  );
  assert.equal(response.status, 415);
  await response.text();
  assert.equal(calls, 1);
  assert.equal(approvals, 0);
  const exhausted = await fetchWithVerifiedZstd(
    url,
    { method: "POST", body },
    { verifiedEndpoints: [url] },
    async () =>
      new Response("no encoding", { status: 415, headers: { "Accept-Encoding": "identity" } }),
    () => false
  );
  assert.equal(exhausted.status, 415);
  const output = await fetchWithVerifiedZstd(
    url,
    { method: "POST", body },
    { verifiedEndpoints: [url] },
    async () =>
      new Response("data: response.created\n\n", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    () => {
      throw new Error("must not approve after output");
    }
  );
  assert.match(await output.text(), /response.created/);
});

test("bounded admission rejects overflow, cancels queued work and frees a single lease only once", async () => {
  const gate = new BoundedAdmission(1, 1, 1000);
  const release = await gate.acquire();
  const controller = new AbortController();
  const pending = gate.acquire(controller.signal);
  const rejected = assert.rejects(pending, /cancel/);
  await assert.rejects(gate.acquire(), /queue full/);
  controller.abort();
  await rejected;
  release();
  release();
  assert.deepEqual(gate.stats(), { active: 0, queued: 0 });
  gate.close();
  await assert.rejects(gate.acquire(), /closed/);
});

test("compression never violates the documented100x decompression ratio", async () => {
  const url = "https://verified/responses";
  const init = { method: "POST", body: "a".repeat(100000) };
  const upload = await prepareZstdUpload(url, init, { verifiedEndpoints: [url] });
  assert.equal(upload.compressed, false);
  assert.equal(upload.init, init);
});
