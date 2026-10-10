#!/usr/bin/env node
/**
 * Single-fixture comparison for timestamp-aware stream-frame interning.
 *
 * The current artifact stores complete timestamp-prefixed SSE frame strings in each track. The
 * benchmark-only candidate stores each distinct frame once and keeps each track's timestamp and
 * dictionary index. It does not change production capture, serialization, or the reader format.
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
process.env.DATA_DIR = dataDir;
process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = "512";
process.env.CHAT_DEBUG_FILE = "false";

const tracks = ["provider", "openai", "client"];
const framePayload = `data: ${JSON.stringify({
  type: "response.output_text.delta",
  delta: "x".repeat(32 * 1024),
})}\n\n`;
const timestamps = {
  provider: "12:00:00.001",
  openai: "12:00:00.007",
  client: "12:00:00.013",
};
const originalChunks = Object.fromEntries(
  tracks.map((track) => [track, [`[${timestamps[track]}] ${framePayload}`]])
);

function encodeCandidate(chunks) {
  const dictionary = [];
  const indexes = new Map();
  const encoded = {
    encoding: "benchmark-stream-frame-table/v1",
    dictionary,
  };
  for (const track of tracks) {
    encoded[track] = chunks[track].map((chunk) => {
      const match = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] ([\s\S]*)$/.exec(chunk);
      assert.ok(match, `${track} chunk should retain the requestLogger timestamp prefix`);
      const [, timestamp, text] = match;
      let index = indexes.get(text);
      if (index === undefined) {
        index = dictionary.length;
        indexes.set(text, index);
        dictionary.push(text);
      }
      return [timestamp, index];
    });
  }
  return encoded;
}

function decodeCandidate(encoded) {
  assert.equal(encoded.encoding, "benchmark-stream-frame-table/v1");
  const decoded = {};
  for (const track of tracks) {
    decoded[track] = encoded[track].map(([timestamp, index]) => {
      assert.ok(Number.isInteger(index) && index >= 0 && index < encoded.dictionary.length);
      return `[${timestamp}] ${encoded.dictionary[index]}`;
    });
  }
  return decoded;
}

function makeArtifact(id, streamChunks) {
  return {
    schemaVersion: 9,
    summary: {
      id,
      timestamp: "2026-10-10T12:00:00.000Z",
      method: "POST",
      path: "/v1/chat/completions",
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

function writeOne(writer, artifact, callLogsDir, pathName) {
  const started = process.hrtime.bigint();
  const result = writer(artifact, pathName);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(result, `${pathName} should be written`);
  const filePath = path.join(callLogsDir, result.relPath);
  const json = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return { result, elapsedMs, json };
}

try {
  const { CALL_LOGS_DIR, readCallArtifact, writeCallArtifact } = await import(
    pathToFileURL(path.resolve("src/lib/usage/callLogArtifacts.ts")).href
  );
  const current = writeOne(
    writeCallArtifact,
    makeArtifact("stream-frame-probe", originalChunks),
    CALL_LOGS_DIR,
    "stream-frame-table/current.json"
  );
  const currentRead = readCallArtifact("stream-frame-table/current.json");
  assert.equal(currentRead.state, "ready");
  assert.deepEqual(currentRead.artifact?.pipeline?.streamChunks, originalChunks);

  const candidateChunks = encodeCandidate(originalChunks);
  assert.deepEqual(decodeCandidate(candidateChunks), originalChunks);
  const candidate = writeOne(
    writeCallArtifact,
    makeArtifact("stream-frame-probe", candidateChunks),
    CALL_LOGS_DIR,
    "stream-frame-table/candidate.json"
  );
  const storedCandidateChunks = candidate.json.pipeline.streamChunks;
  assert.deepEqual(decodeCandidate(storedCandidateChunks), originalChunks);

  const bytesSaved = current.result.sizeBytes - candidate.result.sizeBytes;
  process.stdout.write(
    `${JSON.stringify(
      {
        benchmark: "call-log-timestamped-stream-frame-table/v1",
        fixture: {
          trackCount: tracks.length,
          chunksPerTrack: 1,
          distinctTimestamps: tracks.length,
          distinctFramePayloads: 1,
          framePayloadUtf8Bytes: Buffer.byteLength(framePayload),
          maxPipelineArtifactBytes: 512 * 1024,
        },
        currentWriter: {
          storedBytes: current.result.sizeBytes,
          writeMs: Number(current.elapsedMs.toFixed(3)),
        },
        benchmarkOnlyCandidate: {
          storedBytes: candidate.result.sizeBytes,
          writeMs: Number(candidate.elapsedMs.toFixed(3)),
          encoding: candidateChunks.encoding,
          dictionaryEntries: candidateChunks.dictionary.length,
          exactPerTrackRoundTrip: true,
        },
        savedBytes: bytesSaved,
        savedPercent: Number(((bytesSaved / current.result.sizeBytes) * 100).toFixed(2)),
        caveat:
          "Modeled storage/serialization savings only. The candidate encoding is benchmark-only; production capture, queue memory, SSE behavior, and conversation reconstruction are unchanged.",
      },
      null,
      2
    )}\n`
  );
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalPipelineCap === undefined) delete process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB;
  else process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB = originalPipelineCap;
  if (originalDebug === undefined) delete process.env.CHAT_DEBUG_FILE;
  else process.env.CHAT_DEBUG_FILE = originalDebug;
}
