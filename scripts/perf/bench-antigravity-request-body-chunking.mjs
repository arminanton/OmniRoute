#!/usr/bin/env node
/**
 * Compare the legacy eager Antigravity request-body encoder with the current
 * pull-driven encoder. Each mode runs in a fresh Node process so V8/ArrayBuffer
 * reclamation from one measurement cannot contaminate the other. DATA_DIR is
 * isolated because importing the executor initializes its runtime modules.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SESSIONS = Number(process.env.OMNI_AG_BODY_BENCH_SESSIONS) || 64;
const BODY_BYTES = Number(process.env.OMNI_AG_BODY_BENCH_BYTES) || 3_500_000;
const MAX_CHUNK_BYTES = 64 * 1024;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function memory() {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
}

async function settle() {
  await new Promise(setImmediate);
  global.gc();
  await new Promise(setImmediate);
  global.gc();
}

async function measureMode(mode) {
  if (typeof global.gc !== "function") throw new Error("Run with --expose-gc");

  const { createAntigravityRequestBody } =
    await import("../../open-sse/executors/antigravity/executeAttempt.ts");
  // Three-byte BMP characters exercise the maximum UTF-8 chunk size rather
  // than making the lazy path look artificially small with one-byte ASCII.
  const body = "€".repeat(Math.floor(BODY_BYTES / Buffer.byteLength("€")));
  const bodyBytes = Buffer.byteLength(body);
  await settle();
  const baseline = memory();

  let streams;
  let readers = [];
  let firstChunks = [];
  if (mode === "legacy-eager") {
    streams = Array.from(
      { length: SESSIONS },
      () =>
        new ReadableStream(
          {
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              controller.close();
            },
          },
          { highWaterMark: 16 * 1024 }
        )
    );
  } else if (mode === "pull-driven") {
    streams = Array.from({ length: SESSIONS }, () => createAntigravityRequestBody(body, true));
  } else {
    throw new Error(`Unknown benchmark mode: ${mode}`);
  }

  await settle();
  const afterCreate = memory();
  let afterFirstPull = null;
  if (mode === "pull-driven") {
    readers = streams.map((stream) => stream.getReader());
    firstChunks = await Promise.all(readers.map((reader) => reader.read()));
    for (const chunk of firstChunks) {
      assert.equal(chunk.done, false);
      assert.ok(chunk.value.byteLength <= MAX_CHUNK_BYTES);
    }
    await settle();
    afterFirstPull = memory();
  }

  const result = {
    mode,
    sessions: SESSIONS,
    bodyBytes,
    baseline,
    afterCreate,
    afterFirstPull,
  };
  for (const reader of readers) await reader.cancel("benchmark complete");
  firstChunks = [];
  readers = [];
  streams = [];
  await settle();
  return result;
}

function runChild(mode) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), `omni-ag-body-${mode}-`));
  try {
    const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx/esm", SCRIPT_PATH], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        OMNI_AG_BODY_BENCH_MODE: mode,
      },
    });
    if (child.error) throw child.error;
    if (child.status !== 0) {
      throw new Error(
        `${mode} child failed with status ${child.status}:\n${child.stderr?.slice(-4_000)}`
      );
    }
    const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith("BENCH_RESULT "));
    if (!line) throw new Error(`${mode} child did not emit a result`);
    return JSON.parse(line.slice("BENCH_RESULT ".length));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const mode = process.env.OMNI_AG_BODY_BENCH_MODE;
  if (mode) {
    const result = await measureMode(mode);
    console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
    return;
  }

  const legacy = runChild("legacy-eager");
  const pullDriven = runChild("pull-driven");
  const eagerBytes = legacy.afterCreate.arrayBuffers - legacy.baseline.arrayBuffers;
  const lazyCreateBytes = pullDriven.afterCreate.arrayBuffers - pullDriven.baseline.arrayBuffers;
  const lazyPulledBytes = pullDriven.afterFirstPull.arrayBuffers - pullDriven.baseline.arrayBuffers;
  const measuredBodyBytes = Buffer.byteLength("€".repeat(Math.floor(BODY_BYTES / 3)));
  const expectedEagerBytes = SESSIONS * measuredBodyBytes;

  assert.ok(
    eagerBytes >= expectedEagerBytes * 0.95,
    "legacy baseline should retain full encodings"
  );
  assert.ok(lazyCreateBytes < 1_048_576, "pull-driven streams must not pre-encode request bodies");
  assert.ok(
    lazyPulledBytes <= SESSIONS * MAX_CHUNK_BYTES + 1_048_576,
    "one pull per stream should retain only one bounded chunk per active request"
  );

  console.log(
    JSON.stringify(
      {
        sessions: SESSIONS,
        requestBodyBytes: measuredBodyBytes,
        expectedLegacyEncodedBytes: expectedEagerBytes,
        legacyArrayBuffersAfterCreate: eagerBytes,
        pullDrivenArrayBuffersAfterCreate: lazyCreateBytes,
        pullDrivenArrayBuffersAfterOnePullPerStream: lazyPulledBytes,
        estimatedRetainedArrayBufferReductionBytes: eagerBytes - lazyPulledBytes,
        estimatedRetainedArrayBufferReductionPercent: Number(
          (((eagerBytes - lazyPulledBytes) / eagerBytes) * 100).toFixed(2)
        ),
        eagerToPullDrivenRetentionRatio: Number((eagerBytes / lazyPulledBytes).toFixed(1)),
        legacy,
        pullDriven,
        caveat:
          "Synthetic isolated encoding comparison with one shared source string; it excludes Next routing, provider I/O, tracing, and per-request serialized-string allocation.",
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
