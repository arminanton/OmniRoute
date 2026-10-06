import "../_setup/isolateDataDir.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { test, after } from "node:test";
import { createAccessToken } from "../../src/lib/db/accessTokens.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { createDiagnosticOverflowTrace } from "../../src/lib/usage/diagnosticOverflow.ts";
import {
  listPrivateOverflow,
  inspectPrivateOverflow,
  downloadPrivateOverflow,
} from "../../src/lib/usage/diagnosticOverflowManagement.ts";
const previous = process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "true";
after(() => {
  resetDbInstance();
  if (previous === undefined) delete process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
  else process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = previous;
});
const { secret } = createAccessToken({ name: "private-reader", scope: "admin" });
const request = (suffix = "", signal?: AbortSignal) =>
  new Request("http://127.0.0.1:20128/api/usage/diagnostic-overflow" + suffix, {
    headers: { authorization: "Bearer " + secret },
    signal,
  });

test("actual private store captures beyond10MiB and manager downloads exact original/provider bytes", async () => {
  const trace = await createDiagnosticOverflowTrace({ eligible: true, provider: "antigravity" });
  assert.ok(trace);
  const payload = JSON.stringify({ input: "payload".repeat(1_600_000) });
  assert.ok(Buffer.byteLength(payload) > 10 * 1024 * 1024);
  await trace.writeClientRequest(payload);
  const attempt = await trace.beginAttempt({
    requestBody: payload,
    method: "POST",
    url: "https://fixture.invalid/generate?secret=hidden",
    headers: { Authorization: "secret", "x-request-id": "native-trace" },
  });
  const ongoing = await downloadPrivateOverflow(request(), trace.traceId, attempt.id, "response");
  assert.equal(ongoing.status, 409);
  assert.equal((await ongoing.json()).state, "capturing");
  await attempt.writeResponse(new TextEncoder().encode('data: {"nativeError":"quota"}\n\n'));
  await attempt.finish({ status: 429 });
  await trace.finish();
  const inspected = await inspectPrivateOverflow(request(), trace.traceId);
  assert.equal(inspected.status, 200);
  const manifest = await inspected.json();
  assert.equal(manifest.state, "complete");
  assert.equal(manifest.attempts[0].headers.Authorization, undefined);
  assert.ok(!JSON.stringify(manifest).includes("hidden"));
  for (const [id, kind] of [
    [trace.traceId, "client-request"],
    [attempt.id, "request"],
  ]) {
    const response = await downloadPrivateOverflow(request(), trace.traceId, id, kind);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Diagnostic-Capture-Complete"), "true");
    assert.match(response.headers.get("Content-Disposition") ?? "", /^attachment;/);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), payload);
  }
  const list = await listPrivateOverflow(request());
  assert.equal(list.status, 200);
  assert.ok(
    (await list.json()).traces.some((item: { traceId: string }) => item.traceId === trace.traceId)
  );
});

test("sealed incomplete bodies remain honest and reader refuses a symlink replacement", async () => {
  const trace = await createDiagnosticOverflowTrace({ eligible: true, provider: "agy" });
  assert.ok(trace);
  const attempt = await trace.beginAttempt({ requestBody: "{}" });
  await attempt.writeResponse(new TextEncoder().encode("partial native response"));
  await attempt.fail("read_error");
  await trace.finish();
  const response = await downloadPrivateOverflow(request(), trace.traceId, attempt.id, "response");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Diagnostic-Capture-Complete"), "false");
  assert.equal(
    gunzipSync(Buffer.from(await response.arrayBuffer())).toString(),
    "partial native response"
  );
  const root = path.join(process.env.DATA_DIR!, "diagnostic_overflow", trace.traceId);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  const file = path.join(root, attempt.id + ".provider_response.gz");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = file + ".saved";
  fs.renameSync(file, saved);
  fs.symlinkSync(saved, file);
  try {
    const denied = await downloadPrivateOverflow(request(), trace.traceId, attempt.id, "response");
    assert.equal(denied.status, 409);
    assert.equal((await denied.json()).state, "corrupt");
  } finally {
    fs.unlinkSync(file);
    fs.renameSync(saved, file);
  }
});

test("same-size corruption is refused and cancelling an owned largefile reader closes exactlyonce", async () => {
  const trace = await createDiagnosticOverflowTrace({ eligible: true, provider: "agy" });
  assert.ok(trace);
  const attempt = await trace.beginAttempt({ requestBody: "{}" });
  const payload = randomBytes(1024 * 1024);
  for (let offset = 0; offset < payload.length; offset += 65536)
    await attempt.writeResponse(payload.subarray(offset, offset + 65536));
  await attempt.finish();
  await trace.finish();
  const file = path.join(
    process.env.DATA_DIR!,
    "diagnostic_overflow",
    trace.traceId,
    attempt.id + ".provider_response.gz"
  );
  const bytes = fs.readFileSync(file);
  const damaged = Buffer.from(bytes);
  damaged[damaged.length - 1] ^= 1;
  fs.writeFileSync(file, damaged);
  const corrupt = await downloadPrivateOverflow(request(), trace.traceId, attempt.id, "response");
  assert.equal(corrupt.status, 409);
  fs.writeFileSync(file, bytes);
  const original = fs.createReadStream;
  let stream: fs.ReadStream | undefined;
  let closes = 0;
  fs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    const owned = original(...args);
    stream = owned;
    owned.once("close", () => {
      closes++;
    });
    return owned;
  }) as typeof fs.createReadStream;
  try {
    const abort = new AbortController();
    const response = await downloadPrivateOverflow(
      request("", abort.signal),
      trace.traceId,
      attempt.id,
      "response"
    );
    assert.equal(response.status, 200);
    assert.ok(stream);
    assert.equal(stream.closed, false);
    const owned = stream;
    const closed = new Promise<void>((resolve) => owned.once("close", () => resolve()));
    await response.body!.cancel();
    abort.abort();
    await closed;
    assert.equal(closes, 1);
    assert.equal(stream.closed, true);
  } finally {
    fs.createReadStream = original;
  }
});
