import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import {
  DiagnosticOverflowStore,
  createDiagnosticOverflowTrace,
  getDiagnosticOverflowActiveWork,
  initializeDiagnosticOverflowStore,
  projectDiagnosticOverflowReference,
} from "../../src/lib/usage/diagnosticOverflow.ts";
const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "omni-overflow-proof-"));
async function bytes(
  store: DiagnosticOverflowStore,
  trace: string,
  attempt: string,
  kind: "request" | "response" | "client-request"
): Promise<Buffer> {
  const file = store.open(trace, attempt, kind);
  assert.equal(file.state, "ready");
  if (file.state !== "ready") throw new Error(file.state);
  const chunks: Buffer[] = [];
  for await (const chunk of file.stream) chunks.push(Buffer.from(chunk));
  return gunzipSync(Buffer.concat(chunks));
}

test("defaultoff and noLog eligibility do not create private payload files; cold enabled ownership is unknown", async () => {
  const directory = root();
  process.env.DATA_DIR = directory;
  const previous = process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
  delete process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
  assert.equal(
    await createDiagnosticOverflowTrace({ eligible: true, provider: "antigravity" }),
    null
  );
  assert.equal(getDiagnosticOverflowActiveWork(), 0);
  process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "true";
  assert.equal(
    await createDiagnosticOverflowTrace({ eligible: false, provider: "antigravity" }),
    null
  );
  assert.equal(fs.existsSync(path.join(directory, "diagnostic_overflow")), false);
  assert.equal(getDiagnosticOverflowActiveWork(), null);
  assert.equal(await initializeDiagnosticOverflowStore(), true);
  assert.equal(getDiagnosticOverflowActiveWork(), 0);
  if (previous === undefined) delete process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
  else process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = previous;
});

test("actual files retain exact >10MiB client/request/decodedresponse bytes, UTF8 boundaries, hashes and private modes", async () => {
  const directory = root(),
    store = new DiagnosticOverflowStore({ root: directory });
  const body = "x".repeat(16383) + "😀" + "x".repeat(11 * 1024 * 1024);
  const trace = store.createTrace({ provider: "antigravity", requestId: "private@email.example" });
  try {
    await trace.writeClientRequest(body);
    const attempt = await trace.beginAttempt({
      requestBody: body,
      headers: {
        authorization: "Bearer synthetic-secret",
        "x-request-id": "Bearer synthetic-secret",
      },
      url: "https://user:pass@example.invalid/model?key=secret",
    });
    assert.equal(getDiagnosticOverflowActiveWork(), 1);
    assert.equal(store.open(trace.traceId, attempt.id, "response").state, "capturing");
    const responseHash = createHash("sha256");
    for (let i = 0; i < 176; i++) {
      const chunk = Buffer.alloc(65536, i % 128);
      responseHash.update(chunk);
      await attempt.writeResponse(chunk);
    }
    await attempt.finish({
      status: 429,
      headers: { "retry-after": "30", "x-goog-request-id": "fixture-id", "set-cookie": "secret" },
    });
    await Promise.all([trace.finish(), trace.finish()]);
    assert.equal(getDiagnosticOverflowActiveWork(), 0);
    const manifest = store.read(trace.traceId)!;
    assert.equal(manifest.state, "complete");
    assert.equal(manifest.attempts[0].status, 429);
    assert.equal(manifest.attempts[0].response.rawBytes, 176 * 65536);
    assert.equal(manifest.attempts[0].response.sha256, responseHash.digest("hex"));
    assert.equal(manifest.clientRequest?.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(
      (await bytes(store, trace.traceId, trace.traceId, "client-request")).toString(),
      body
    );
    assert.equal((await bytes(store, trace.traceId, attempt.id, "request")).toString(), body);
    const response = await bytes(store, trace.traceId, attempt.id, "response");
    assert.equal(response.byteLength, 176 * 65536);
    assert.equal(
      createHash("sha256").update(response).digest("hex"),
      manifest.attempts[0].response.sha256
    );
    assert.ok(!JSON.stringify(manifest).includes("synthetic-secret"));
    assert.ok(!JSON.stringify(manifest).includes("private@email"));
    assert.ok(!JSON.stringify(manifest).includes("key=secret"));
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    for (const file of fs.readdirSync(path.join(directory, trace.traceId)))
      assert.equal(fs.statSync(path.join(directory, trace.traceId, file)).mode & 0o777, 0o600);
  } finally {
    await trace.abort();
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("file limit and abort seal exact available prefixes as incomplete without throwing into generation", async () => {
  const directory = root(),
    store = new DiagnosticOverflowStore({ root: directory, maxFileBytes: 1024 });
  const trace = store.createTrace({ provider: "antigravity" });
  try {
    const attempt = await trace.beginAttempt({ requestBody: "a".repeat(2000) });
    await attempt.writeResponse(Buffer.from("partial"));
    await attempt.fail("abort");
    await trace.finish();
    const manifest = store.read(trace.traceId)!;
    assert.equal(manifest.state, "incomplete");
    assert.equal(manifest.attempts[0].request.reason, "size_limit");
    assert.equal(manifest.attempts[0].response.reason, "abort");
    assert.equal((await bytes(store, trace.traceId, attempt.id, "request")).byteLength, 1024);
    assert.equal((await bytes(store, trace.traceId, attempt.id, "response")).toString(), "partial");
    assert.equal(attempt.acceptingResponse(), false);
  } finally {
    await trace.abort();
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("readers reject same-size corruption, symlinks, unsafe file permissions and arbitrary references", async () => {
  const directory = root(),
    store = new DiagnosticOverflowStore({ root: directory });
  const trace = store.createTrace({ provider: "antigravity" });
  try {
    const attempt = await trace.beginAttempt({ requestBody: "request" });
    await attempt.finish();
    await trace.finish();
    const filename = path.join(directory, trace.traceId, `${attempt.id}.provider_request.gz`);
    const original = fs.readFileSync(filename);
    const changed = Buffer.from(original);
    changed[changed.length - 1] ^= 1;
    fs.writeFileSync(filename, changed);
    assert.equal(store.open(trace.traceId, attempt.id, "request").state, "corrupt");
    fs.writeFileSync(filename, original);
    fs.chmodSync(filename, 0o644);
    assert.equal(store.open(trace.traceId, attempt.id, "request").state, "corrupt");
    fs.chmodSync(filename, 0o600);
    fs.unlinkSync(filename);
    fs.symlinkSync(path.join(directory, "coordination.sqlite"), filename);
    assert.equal(store.open(trace.traceId, attempt.id, "request").state, "corrupt");
    assert.equal(store.open("../private", attempt.id, "request").state, "missing");
    assert.equal(
      projectDiagnosticOverflowReference({
        schema: "omni-diagnostic-overflow/v1",
        traceId: "../../secret",
        state: "complete",
      }),
      undefined
    );
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

async function child(
  directory: string,
  budget: number,
  lease = 60000,
  hold = false
): Promise<{
  process: ChildProcessWithoutNullStreams;
  ready: { traceId: string; attemptId: string };
  lines: string[];
}> {
  const process = spawn(
    globalThis.process.execPath,
    [
      "--import",
      "tsx/esm",
      "tests/unit/fixtures/diagnostic-overflow-worker.ts",
      directory,
      String(budget),
      String(lease),
      hold ? "hold" : "write",
    ],
    { cwd: globalThis.process.cwd(), stdio: "pipe" }
  );
  const lines: string[] = [];
  let pending = "";
  const ready = await new Promise<{ traceId: string; attemptId: string }>((resolve, reject) => {
    process.stdout.on("data", (chunk) => {
      pending += chunk.toString();
      for (let index; (index = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, index);
        pending = pending.slice(index + 1);
        lines.push(line);
        const value = JSON.parse(line);
        if (value.ready) resolve(value);
      }
    });
    process.once("error", reject);
    process.once("exit", (code) => {
      if (!lines.length) reject(new Error(`worker exit ${code}`));
    });
  });
  return { process, ready, lines };
}
test(
  "independent processes atomically share aggregate disk budget and never silently claim full",
  { timeout: 15000 },
  async () => {
    const directory = root(),
      budget = 1536 * 1024,
      store = new DiagnosticOverflowStore({ root: directory, maxTotalBytes: budget });
    const children = await Promise.all([child(directory, budget), child(directory, budget)]);
    try {
      const exits = children.map((worker) => once(worker.process, "exit"));
      children.forEach((worker) => worker.process.stdin.write("go"));
      for (const exit of exits) assert.equal((await exit)[0], 0);
      assert.ok(store.coordinator.used() <= budget);
      const manifests = children.map((worker) => store.read(worker.ready.traceId)!);
      assert.ok(manifests.every(Boolean));
      assert.ok(manifests.some((manifest) => manifest.state === "incomplete"));
      assert.ok(manifests.some((manifest) => manifest.reasons.includes("aggregate_budget")));
      const actual = manifests.reduce(
        (sum, manifest) =>
          sum +
          manifest.attempts.reduce(
            (bytes, attempt) => bytes + attempt.request.rawBytes + attempt.response.rawBytes,
            0
          ),
        0
      );
      assert.ok(actual < 1400000);
    } finally {
      children.forEach((worker) => worker.process.kill());
      store.close();
      fs.rmSync(directory, { recursive: true });
    }
  }
);

test(
  "random lease ownership survives live crossprocess cleanup; crash fences incomplete record, retention only removes sealed owned files",
  { timeout: 15000 },
  async () => {
    const directory = root(),
      budget = 4 * 1024 * 1024,
      store = new DiagnosticOverflowStore({
        root: directory,
        maxTotalBytes: budget,
        leaseMs: 400,
        retentionMs: 1000,
      });
    const worker = await child(directory, budget, 400, true);
    try {
      worker.process.stdin.write("go");
      await new Promise((resolve) => setTimeout(resolve, 900));
      store.cleanup();
      assert.equal(store.read(worker.ready.traceId)?.state, "capturing");
      assert.ok(fs.existsSync(path.join(directory, worker.ready.traceId)));
      const exited = once(worker.process, "exit");
      worker.process.kill("SIGKILL");
      await exited;
      await new Promise((resolve) => setTimeout(resolve, 500));
      store.cleanup();
      const manifest = store.read(worker.ready.traceId)!;
      assert.equal(manifest.state, "incomplete");
      assert.ok(manifest.reasons.includes("writer_lease_expired"));
      assert.equal(
        store.open(worker.ready.traceId, worker.ready.attemptId, "response").state,
        "corrupt"
      );
      store.cleanup(Date.now() + 2000);
      assert.equal(store.read(worker.ready.traceId), null);
      assert.equal(fs.existsSync(path.join(directory, worker.ready.traceId)), false);
    } finally {
      worker.process.kill();
      store.close();
      fs.rmSync(directory, { recursive: true });
    }
  }
);

test("quota rejection and unsafe filesystem failure expose incomplete references without zero-byte budget growth", async () => {
  const directory = root(),
    store = new DiagnosticOverflowStore({ root: directory, maxTotalBytes: 320 * 1024 });
  try {
    const trace = store.createTrace({ provider: "antigravity" });
    const attempt = await trace.beginAttempt({ requestBody: "request" });
    await attempt.writeResponse(Buffer.from("response"));
    await attempt.finish();
    await trace.finish();
    assert.equal(store.read(trace.traceId)?.state, "incomplete");
    assert.ok(store.coordinator.used() <= 320 * 1024);
    const rejected = store.createTrace({ provider: "antigravity" });
    assert.deepEqual(projectDiagnosticOverflowReference(rejected.snapshot()), rejected.snapshot());
    assert.equal(rejected.snapshot().state, "incomplete");
    assert.equal(rejected.snapshot().reason, "aggregate_budget");
    assert.equal(rejected.snapshot().persisted, false);
    await rejected.finish();
    fs.chmodSync(directory, 0o755);
    const unsafe = store.createTrace({ provider: "antigravity" });
    assert.equal(unsafe.snapshot().state, "incomplete");
    assert.equal(unsafe.snapshot().reason, "capture_error");
    await unsafe.abort();
    fs.chmodSync(directory, 0o700);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("retention does not erase unknown files or foreign symlink targets", async () => {
  const directory = root(),
    store = new DiagnosticOverflowStore({ root: directory, retentionMs: 1 });
  const trace = store.createTrace({ provider: "antigravity" });
  try {
    await trace.writeClientRequest("fixture");
    await trace.finish();
    const foreign = path.join(directory, trace.traceId, "not-owned.secret");
    fs.writeFileSync(foreign, "foreign", { mode: 0o600 });
    assert.throws(() => store.cleanup(Date.now() + 10));
    assert.equal(fs.readFileSync(foreign, "utf8"), "foreign");
    assert.equal(
      store.open(trace.traceId, trace.traceId, "client-request").state,
      "ready",
      "failed retention preflight must leave owned payload intact"
    );
    assert.ok(store.read(trace.traceId));
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});

test("parent write/symlink provenance cannot redirect a private store", () => {
  const directory = root();
  try {
    const unsafe = path.join(directory, "unsafe");
    fs.mkdirSync(unsafe, { mode: 0o777 });
    fs.chmodSync(unsafe, 0o777);
    assert.throws(
      () => new DiagnosticOverflowStore({ root: path.join(unsafe, "payloads") }),
      /unsafe_diagnostic_parent_permissions/
    );
    const link = path.join(directory, "link");
    fs.symlinkSync(unsafe, link);
    assert.throws(
      () => new DiagnosticOverflowStore({ root: path.join(link, "payloads") }),
      /unsafe_diagnostic_directory/
    );
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});

test("independent module copies share initialized state and active gzip/fsync ownership", async () => {
  const directory = root(),
    copyRoot = root();
  fs.writeFileSync(path.join(copyRoot, "package.json"), JSON.stringify({ type: "module" }));
  const usage = path.join(copyRoot, "lib", "usage");
  fs.mkdirSync(usage, { recursive: true, mode: 0o700 });
  for (const name of fs
    .readdirSync(path.join(process.cwd(), "src/lib/usage"))
    .filter((name) => /^diagnosticOverflow.*\.ts$/.test(name)))
    fs.copyFileSync(path.join(process.cwd(), "src/lib/usage", name), path.join(usage, name));
  fs.writeFileSync(
    path.join(copyRoot, "lib/dataPaths.ts"),
    `export { resolveDataDir } from ${JSON.stringify(path.join(process.cwd(), "src/lib/dataPaths.ts"))};`
  );
  fs.symlinkSync(path.join(process.cwd(), "node_modules"), path.join(copyRoot, "node_modules"));
  const duplicate = await import(path.join(usage, "diagnosticOverflow.ts"));
  const previousEnabled = process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
  process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = "true";
  assert.equal(
    duplicate.getDiagnosticOverflowActiveWork(),
    0,
    "duplicate loader sees the already initialized store"
  );
  const store = new DiagnosticOverflowStore({ root: directory });
  const trace = store.createTrace({ provider: "antigravity" });
  const originalSync = fs.fsync;
  let release: (() => void) | undefined;
  let observed: () => void = () => {};
  const pendingSync = new Promise<void>((resolve) => {
    observed = resolve;
  });
  try {
    const attempt = await trace.beginAttempt({ requestBody: "fixture" });
    await attempt.writeResponse(Buffer.from("body"));
    fs.fsync = ((fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      release = () => originalSync(fd, callback);
      observed();
    }) as typeof fs.fsync;
    const finishFile = attempt.finish();
    await pendingSync;
    const finishTrace = trace.finish();
    assert.equal(duplicate.getDiagnosticOverflowActiveWork(), 1);
    assert.equal(getDiagnosticOverflowActiveWork(), 1);
    const allow = release!;
    release = undefined;
    allow();
    await finishFile;
    await finishTrace;
    assert.equal(duplicate.getDiagnosticOverflowActiveWork(), getDiagnosticOverflowActiveWork());
    assert.equal(duplicate.getDiagnosticOverflowActiveWork(), 0);
  } finally {
    if (previousEnabled === undefined) delete process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED;
    else process.env.OMNI_DIAGNOSTIC_OVERFLOW_ENABLED = previousEnabled;
    fs.fsync = originalSync;
    release?.();
    await trace.abort();
    store.close();
    fs.rmSync(directory, { recursive: true });
    fs.rmSync(copyRoot, { recursive: true });
  }
});

test("real descriptor write failure is incomplete and cannot reject inference or claim a full response", async () => {
  const directory = root(),
    store = new DiagnosticOverflowStore({ root: directory });
  const trace = store.createTrace({ provider: "antigravity" });
  try {
    const attempt = await trace.beginAttempt({ requestBody: "fixture" });
    const target = path.join(directory, trace.traceId, `${attempt.id}.provider_response.gz`);
    const descriptor = fs.readdirSync("/proc/self/fd").find((entry) => {
      try {
        return fs.readlinkSync(`/proc/self/fd/${entry}`) === target;
      } catch {
        return false;
      }
    });
    assert.ok(descriptor, "only the exact task-owned response descriptor may be closed");
    fs.closeSync(Number(descriptor));
    await attempt.writeResponse(Buffer.from("synthetic response after storage failure"));
    await attempt.finish();
    await trace.finish();
    const manifest = store.read(trace.traceId)!;
    assert.equal(manifest.state, "incomplete");
    assert.equal(manifest.attempts[0].response.complete, false);
    assert.equal(manifest.attempts[0].response.reason, "write_error");
    assert.equal(store.open(trace.traceId, attempt.id, "response").state, "corrupt");
    assert.equal(getDiagnosticOverflowActiveWork(), 0);
  } finally {
    await trace.abort();
    store.close();
    fs.rmSync(directory, { recursive: true });
  }
});
