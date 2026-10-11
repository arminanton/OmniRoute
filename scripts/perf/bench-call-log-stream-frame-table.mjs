#!/usr/bin/env node
/**
 * Exercise production exact and timestamp-aware stream-chunk interning.
 *
 * A small independent encoder acts as an oracle for the production timestamp-aware table. The
 * cases cover identical frame payloads across all three tracks, a two-track match, and fully
 * distinct tracks so the benchmark also proves the size gate refuses an unhelpful table.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omni-stream-frame-table-"));
const originalDataDir = process.env.DATA_DIR;
const originalPipelineCap = process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
const originalDebug = process.env.CHAT_DEBUG_FILE;
const TRACKS = ["provider", "openai", "client"];
const FRAME_TABLE_ENCODING = "omni-stream-timestamped-frame-table/v1";
const TIMESTAMP_PREFIX = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] ([\s\S]*)$/;
const RUNS = 20;
const FRAME_COUNT = 100;
const TEXT_BYTES = 512;

process.env.DATA_DIR = dataDir;
process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "512";
process.env.CHAT_DEBUG_FILE = "false";

function makeFrameText(index, track, mode) {
  const distinctTrack = mode === "unique" || (mode === "two-track" && track === "client");
  const delta = `${distinctTrack ? `${track}-` : ""}frame-${String(index).padStart(3, "0")}:${"x".repeat(TEXT_BYTES)}`;
  return `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`;
}

function makeStreamChunks(mode) {
  return Object.fromEntries(
    TRACKS.map((track, trackIndex) => [
      track,
      Array.from({ length: FRAME_COUNT }, (_unused, index) => {
        const milliseconds = String(index * TRACKS.length + trackIndex).padStart(3, "0");
        const timestamp = `12:00:00.${milliseconds}`;
        return `[${timestamp}] ${makeFrameText(index, track, mode)}`;
      }),
    ])
  );
}

function encodeCandidate(streamChunks) {
  const dictionary = [];
  const indexes = new Map();
  const channels = {};
  for (const track of TRACKS) {
    const chunks = streamChunks[track];
    if (!Array.isArray(chunks)) return null;
    channels[track] = [];
    for (const chunk of chunks) {
      const match = TIMESTAMP_PREFIX.exec(chunk);
      if (!match) return null;
      const [, timestamp, payload] = match;
      let index = indexes.get(payload);
      if (index === undefined) {
        index = dictionary.length;
        indexes.set(payload, index);
        dictionary.push(payload);
      }
      channels[track].push([timestamp, index]);
    }
  }

  const encoded = { encoding: FRAME_TABLE_ENCODING, dictionary, ...channels };
  const sourceBytes = Buffer.byteLength(JSON.stringify(streamChunks));
  const candidateBytes = Buffer.byteLength(JSON.stringify(encoded));
  return candidateBytes < sourceBytes ? { encoded, sourceBytes, candidateBytes } : null;
}

function decodeCandidate(encoded) {
  assert.equal(encoded.encoding, FRAME_TABLE_ENCODING);
  assert.ok(Array.isArray(encoded.dictionary));
  const dictionary = encoded.dictionary;
  return Object.fromEntries(
    TRACKS.map((track) => {
      const rows = encoded[track];
      assert.ok(Array.isArray(rows));
      const chunks = rows.map((row) => {
        assert.ok(Array.isArray(row) && row.length === 2);
        const [timestamp, index] = row;
        assert.equal(typeof timestamp, "string");
        assert.ok(
          Number.isSafeInteger(index) && Number(index) >= 0 && Number(index) < dictionary.length
        );
        return `[${timestamp}] ${dictionary[Number(index)]}`;
      });
      return [track, chunks];
    })
  );
}

function makeArtifact(id, streamChunks) {
  return {
    schemaVersion: 11,
    summary: {
      id,
      timestamp: "2026-10-11T12:00:00.000Z",
      method: "POST",
      path: "/v1/responses",
      status: 200,
      model: "synthetic-stream-frame-table",
      requestedModel: null,
      provider: "synthetic",
      account: "benchmark-only",
      connectionId: null,
      duration: 100,
      tokens: { in: 1, out: 1 },
    },
    requestBody: null,
    responseBody: null,
    error: null,
    pipeline: { streamChunks },
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function writeOne(writer, artifact, pathName) {
  const started = process.hrtime.bigint();
  const result = writer(artifact, pathName);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(result, `${pathName} should be written`);
  const filePath = path.join(CALL_LOGS_DIR, result.relPath);
  return { result, elapsedMs, json: JSON.parse(fs.readFileSync(filePath, "utf8")) };
}

let CALL_LOGS_DIR;
let closeArtifactWriter = async () => {};

try {
  const {
    CALL_LOGS_DIR: callLogsDir,
    readCallArtifact,
    writeCallArtifact,
  } = await import(pathToFileURL(path.resolve("src/lib/usage/callLogArtifacts.ts")).href);
  const {
    closeCallLogArtifactWriter,
    estimateCallLogArtifactFootprint,
    getCallLogArtifactWriterSnapshot,
    projectCallLogArtifactForQueue,
    writeCallArtifactAsync,
  } = await import(pathToFileURL(path.resolve("src/lib/usage/callLogArtifactWriter.ts")).href);
  closeArtifactWriter = closeCallLogArtifactWriter;
  assert.ok(callLogsDir);
  CALL_LOGS_DIR = callLogsDir;

  const output = [];
  for (const mode of ["shared", "two-track", "unique"]) {
    const productionWriteMs = [];
    const queueProjectionAndEstimateMs = [];
    let productionStoredBytes = 0;
    let productionStreamBytes = 0;
    let expectedCandidateBytes = 0;
    let tableUsedRuns = 0;
    const originalChunks = makeStreamChunks(mode);

    for (let iteration = 0; iteration < RUNS; iteration++) {
      const sourceArtifact = makeArtifact(`${mode}-projection-${iteration}`, originalChunks);
      const projectionStarted = process.hrtime.bigint();
      const projection = projectCallLogArtifactForQueue(sourceArtifact);
      const estimate = estimateCallLogArtifactFootprint(projection);
      queueProjectionAndEstimateMs.push(Number(process.hrtime.bigint() - projectionStarted) / 1e6);
      assert.equal(estimate.reason, undefined);

      const projectedStreamChunks = projection.pipeline.streamChunks;
      const expected = encodeCandidate(originalChunks);
      if (expected) assert.deepEqual(projectedStreamChunks, expected.encoded);
      else assert.deepEqual(projectedStreamChunks, originalChunks);

      const written = writeOne(
        writeCallArtifact,
        makeArtifact(`${mode}-production-${iteration}`, originalChunks),
        `stream-frame-table/${mode}/production-${iteration}.json`
      );
      productionWriteMs.push(written.elapsedMs);
      productionStoredBytes += written.result.sizeBytes;
      const readBack = readCallArtifact(`stream-frame-table/${mode}/production-${iteration}.json`);
      assert.equal(readBack.state, "ready");
      assert.deepEqual(readBack.artifact?.pipeline?.streamChunks, originalChunks);

      const candidate = encodeCandidate(originalChunks);
      const storedStreamChunks = written.json.pipeline.streamChunks;
      if (candidate) {
        tableUsedRuns++;
        expectedCandidateBytes = candidate.candidateBytes;
        assert.deepEqual(storedStreamChunks, candidate.encoded);
        assert.deepEqual(decodeCandidate(storedStreamChunks), originalChunks);
      } else {
        assert.deepEqual(storedStreamChunks, originalChunks);
      }
      productionStreamBytes += Buffer.byteLength(JSON.stringify(storedStreamChunks));
    }

    output.push({
      mode,
      fixture: {
        tracks: TRACKS.length,
        framesPerTrack: FRAME_COUNT,
        textBytesPerDelta: TEXT_BYTES,
        runs: RUNS,
      },
      productionWriter: {
        storedBytesMedian: Math.round(productionStoredBytes / RUNS),
        streamBytesMedian: Math.round(productionStreamBytes / RUNS),
        writeMsMedian: Number(median(productionWriteMs).toFixed(3)),
        queueProjectionAndEstimateMsMedian: Number(median(queueProjectionAndEstimateMs).toFixed(3)),
      },
      timestampAwareTable: {
        appliedRuns: tableUsedRuns,
        expectedCandidateStreamBytes: expectedCandidateBytes || null,
        savedPercent: tableUsedRuns
          ? Number(
              (
                (1 - expectedCandidateBytes / Buffer.byteLength(JSON.stringify(originalChunks))) *
                100
              ).toFixed(2)
            )
          : 0,
        exactRoundTrip: true,
      },
    });
  }

  const parallelArtifactCount = 70;
  const parallelArtifacts = Array.from({ length: parallelArtifactCount }, (_unused, index) =>
    makeArtifact(`parallel-queue-${index}`, makeStreamChunks("shared"))
  );
  let rawQueueFootprintEstimateBytes = 0;
  let projectedQueueFootprintEstimateBytes = 0;
  for (const artifact of parallelArtifacts) {
    const rawEstimate = estimateCallLogArtifactFootprint(artifact);
    const projectedEstimate = estimateCallLogArtifactFootprint(
      projectCallLogArtifactForQueue(artifact)
    );
    assert.equal(rawEstimate.reason, undefined);
    assert.equal(projectedEstimate.reason, undefined);
    rawQueueFootprintEstimateBytes += rawEstimate.estimatedBytes;
    projectedQueueFootprintEstimateBytes += projectedEstimate.estimatedBytes;
  }
  const parallelStarted = process.hrtime.bigint();
  const parallelResults = await Promise.all(
    parallelArtifacts.map((artifact) => writeCallArtifactAsync(artifact))
  );
  const parallelElapsedMs = Number(process.hrtime.bigint() - parallelStarted) / 1e6;
  const writerSnapshot = getCallLogArtifactWriterSnapshot();
  assert.equal(parallelResults.filter(Boolean).length, parallelArtifactCount);
  for (let index = 0; index < parallelArtifactCount; index++) {
    const result = parallelResults[index];
    assert.ok(result);
    const readBack = readCallArtifact(result.relPath);
    assert.equal(readBack.state, "ready");
    assert.deepEqual(
      readBack.artifact?.pipeline?.streamChunks,
      parallelArtifacts[index].pipeline.streamChunks
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "call-log-timestamped-stream-frame-table/v3",
        note: "Synthetic only. Timings include local synchronous production writer calls; exact round-trip is verified through readCallArtifact().",
        cases: output,
        concurrentWriter: {
          artifacts: parallelArtifactCount,
          completed: parallelResults.filter(Boolean).length,
          elapsedMs: Number(parallelElapsedMs.toFixed(3)),
          rawQueueFootprintEstimateBytes,
          projectedQueueFootprintEstimateBytes,
          estimateReductionPercent: Number(
            (
              (1 - projectedQueueFootprintEstimateBytes / rawQueueFootprintEstimateBytes) *
              100
            ).toFixed(2)
          ),
          queuedArtifactsHighWater: writerSnapshot.queuedArtifactsHighWater,
          reservedArtifactBytesHighWater: writerSnapshot.reservedArtifactBytesHighWater,
          reservationLimitBytes: writerSnapshot.artifactFootprintLimitBytes,
          detailOmissionsTotal: writerSnapshot.detailOmissionsTotal,
          workerFailuresTotal: writerSnapshot.workerFailuresTotal,
          allRoundTripsVerified: true,
        },
      },
      null,
      2
    )}\n`
  );
} finally {
  await closeArtifactWriter(5_000);
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalPipelineCap === undefined) delete process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
  else process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = originalPipelineCap;
  if (originalDebug === undefined) delete process.env.CHAT_DEBUG_FILE;
  else process.env.CHAT_DEBUG_FILE = originalDebug;
}
