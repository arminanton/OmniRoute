/**
 * Request-body heap amplification benchmark (#7847).
 *
 * #7847 reports a 3.05 MiB request with 729 messages and 86 tools reaching ~12,282 MiB of V8
 * heap. The wire size does not explain the peak: the same logical body is retained several times
 * over (entry-point log clone, per-combo-target clone, token-estimation string, pending-request
 * state). This benchmark attributes retained heap to each of those mechanisms individually, so a
 * fix can be justified by numbers instead of intuition — and so a regression can be caught later.
 *
 * It measures the real production helpers (no reimplementation): `buildClientRawRequest` uses
 * `cloneBoundedForLog` for its pending-request snapshot, and
 * `cloneClientRawRequestPayloadForLog` builds the detailed call-log payload. An earlier version
 * measured `cloneLogPayload` here even though the chat route had switched to bounded snapshots;
 * that overstated the retained copies on the actual request path.
 *
 * Deterministic and API-free (no network, no upstream credentials). The DATA_DIR is redirected to
 * a temp dir before importing, because the request-logger module opens the SQLite database on
 * import — the benchmark must never touch the operator's real ~/.omniroute store.
 *
 * Node only — NOT bun. We need `--expose-gc` and V8 heap accounting; measuring "V8 heap" under a
 * different engine would report a number that has nothing to do with the production runtime.
 *
 * Usage:
 *   npm run bench:heap-body                          # the #7847 incident shape
 *   npm run bench:heap-body -- --messages 800 --tools 120
 *   npm run bench:heap-body -- --concurrency 16      # simulate overlapping requests
 *   npm run bench:heap-body -- --json                # machine-readable
 *   npm run bench:heap-body -- --max-retained-mib 64 # non-zero exit if exceeded (regression gate)
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Must happen BEFORE the dynamic imports below: open-sse/utils/requestLogger.ts transitively
// opens the SQLite store at import time, and the benchmark must stay hermetic.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-heapbench-"));
process.env.DATA_DIR = TMP_DATA_DIR;

// open-sse/utils/requestLogger.ts imports @/lib/usage/usageHistory, so merely importing the
// (pure) log-shaping helper boots SQLite and runs every migration against the temp DATA_DIR.
// That noise would bury the report, so console output is parked for the duration of the import.
// The measurements are unaffected: every baseline is taken after imports have settled.
const { buildAgentPayload, INCIDENT_SHAPE } = await import("./agentPayloadCorpus.ts");

const realLog = console.log;
console.log = () => {};
const { cloneBoundedForLog, cloneClientRawRequestPayloadForLog } = await import(
  "../../open-sse/utils/requestLogger.ts"
);
const { getChatLogClientTextLimit } = await import("../../src/lib/logEnv.ts");
console.log = realLog;

// ── CLI ──────────────────────────────────────────────────────────────────────
function numArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}
const HAS = (flag: string) => process.argv.includes(flag);

// Defaults mirror the #7847 production incident.
const MESSAGES = numArg("--messages", INCIDENT_SHAPE.messages);
const TOOLS = numArg("--tools", INCIDENT_SHAPE.tools);
// Calibrated so the defaults land on the incident's 3.05 MiB wire size.
const CONTENT_WORDS = numArg("--content-words", INCIDENT_SHAPE.contentWords);
const TARGETS = numArg("--targets", 3); // combo targets -> shallow attemptBody copies
const CONCURRENCY = numArg("--concurrency", 8);
const MAX_RETAINED = numArg("--max-retained-mib", 0); // 0 = report only
const AS_JSON = HAS("--json");

const MIB = 1024 * 1024;
const fmt = (bytes: number) => (bytes / MIB).toFixed(2);

// ── Measurement ──────────────────────────────────────────────────────────────
const gc = globalThis.gc as undefined | (() => void);

function settle(): void {
  // Several passes: one gc() does not reliably collect everything in a young generation.
  for (let i = 0; i < 4; i++) gc?.();
}

/**
 * Retained heap of whatever `produce` returns, while it stays reachable.
 * This is the number that maps to the incident: many concurrent requests each holding copies.
 */
function measureRetained<T>(produce: () => T): { bytes: number; value: T } {
  settle();
  const before = process.memoryUsage().heapUsed;
  const value = produce();
  settle();
  const after = process.memoryUsage().heapUsed;
  return { bytes: Math.max(0, after - before), value };
}

type Row = { mechanism: string; site: string; bytes: number };

async function main(): Promise<void> {
  if (typeof gc !== "function") {
    console.error(
      "[heap-bench] refusing to run without --expose-gc: retained-heap numbers would be\n" +
        "            dominated by uncollected garbage and are not comparable across runs.\n" +
        "            Use `npm run bench:heap-body`, which passes it."
    );
    process.exitCode = 2;
    return;
  }

  const chatBody = buildAgentPayload(MESSAGES, TOOLS, CONTENT_WORDS);
  // The input corpus models the same serialized context under the Responses
  // API shape because only Responses requests carry the duplicated
  // `body.input`/`effectiveInput` logger fields measured by this benchmark.
  const body = {
    model: chatBody.model,
    input: chatBody.messages,
    tools: chatBody.tools,
    stream: true,
  };
  const serializationStarted = performance.now();
  const wireJson = JSON.stringify(body);
  const jsonSerializationMs = performance.now() - serializationStarted;
  const wireBytes = Buffer.byteLength(wireJson, "utf8");

  const rows: Row[] = [];
  const hold: unknown[] = []; // keep measured values reachable until output is complete

  const clientTextLimit = getChatLogClientTextLimit();
  const clientSnapshot = measureRetained(() =>
    cloneBoundedForLog(body, 0, null, clientTextLimit)
  );
  hold.push(clientSnapshot.value);
  rows.push({
    mechanism: "bounded client snapshot",
    site: "buildClientRawRequest → pending-call details",
    bytes: clientSnapshot.bytes,
  });

  const legacyPipeline = measureRetained(() => ({
    body: cloneBoundedForLog(clientSnapshot.value, 0, null, clientTextLimit),
    effectiveInput: cloneBoundedForLog(body.input),
  }));
  hold.push(legacyPipeline.value);
  rows.push({
    mechanism: "legacy call-log snapshot (two input trees)",
    site: "requestLogger.logClientRawRequest before dedup",
    bytes: legacyPipeline.bytes,
  });

  const deduplicatedPipeline = measureRetained(() =>
    cloneClientRawRequestPayloadForLog(clientSnapshot.value, body.input)
  );
  hold.push(deduplicatedPipeline.value);
  rows.push({
    mechanism: "deduplicated call-log snapshot",
    site: "requestLogger.logClientRawRequest with input reference",
    bytes: deduplicatedPipeline.bytes,
  });

  // The combo executor shallow-copies the top-level body per target. Nested
  // messages/input/tool arrays remain shared unless a transform replaces them.
  const comboBodies = measureRetained(() =>
    Array.from({ length: TARGETS }, () => ({ ...body }))
  );
  hold.push(comboBodies.value);
  rows.push({
    mechanism: `shallow attempt body x${TARGETS}`,
    site: "combo executeTargetAttempt",
    bytes: comboBodies.bytes,
  });

  const legacyPipelineBytes = Buffer.byteLength(JSON.stringify(legacyPipeline.value), "utf8");
  const deduplicatedPipelineBytes = Buffer.byteLength(JSON.stringify(deduplicatedPipeline.value), "utf8");

  // Model independent in-flight clients: each has a separately parsed body,
  // a bounded pending snapshot, and a detailed-log payload. The synthetic
  // corpus is incident-derived; this is retained heap, not provider capacity.
  const concurrent = measureRetained(() =>
    Array.from({ length: CONCURRENCY }, () => {
      const parsedBody = structuredClone(body);
      const pendingSnapshot = cloneBoundedForLog(parsedBody, 0, null, clientTextLimit);
      const pipeline = cloneClientRawRequestPayloadForLog(pendingSnapshot, parsedBody.input);
      return { parsedBody, pendingSnapshot, pipeline };
    })
  );
  hold.push(concurrent.value);

  const requestSnapshotBytes = clientSnapshot.bytes + deduplicatedPipeline.bytes;

  if (AS_JSON) {
    console.log(
      JSON.stringify(
        {
          runtime: process.version,
          shape: {
            endpoint: "/v1/responses (synthetic, incident-derived payload)",
            messages: MESSAGES,
            tools: TOOLS,
            targets: TARGETS,
            concurrency: CONCURRENCY,
          },
          wireBytes,
          jsonSerializationMs,
          mechanisms: rows,
          legacyPipelineBytes,
          deduplicatedPipelineBytes,
          serializedPipelineBytesSaved: Math.max(0, legacyPipelineBytes - deduplicatedPipelineBytes),
          effectiveInputUsesReference:
            (deduplicatedPipeline.value as Record<string, unknown>).effectiveInputRef === "body.input",
          oneRequestSnapshotBytes: requestSnapshotBytes,
          concurrentRequestSnapshotBytes: concurrent.bytes,
        },
        null,
        2
      )
    );
  } else {
    console.log(`# Request-body retained-state benchmark (#7847)\n`);
    console.log(
      `Runtime: **${process.version}** · synthetic Responses payload: ${MESSAGES} messages · ${TOOLS} tools · wire size **${fmt(wireBytes)} MiB**` +
        ` · ${TARGETS} combo targets · JSON stringify ${jsonSerializationMs.toFixed(1)} ms\n`
    );
    console.log("| mechanism | call site | retained | x wire |");
    console.log("| --- | --- | ---: | ---: |");
    for (const r of rows) {
      console.log(
        `| ${r.mechanism} | \`${r.site}\` | ${fmt(r.bytes)} MiB | ${(r.bytes / wireBytes).toFixed(2)}x |`
      );
    }
    console.log("");
    console.log(
      `Pipeline JSON: ${fmt(legacyPipelineBytes)} MiB before dedup → ${fmt(deduplicatedPipelineBytes)} MiB after dedup ` +
        `(**${fmt(legacyPipelineBytes - deduplicatedPipelineBytes)} MiB saved**).`
    );
    console.log("");
    console.log(
      `One modeled request retains **${fmt(requestSnapshotBytes)} MiB** in the two measured snapshots; ` +
        `${CONCURRENCY} independent concurrent requests retain **${fmt(concurrent.bytes)} MiB** ` +
        `including parsed bodies, pending snapshots, and deduplicated pipeline payloads.`
    );
    console.log("");
  }

  if (MAX_RETAINED > 0 && concurrent.bytes / MIB > MAX_RETAINED) {
    console.error(
      `[heap-bench] FAIL — ${CONCURRENCY}-request retained ${fmt(concurrent.bytes)} MiB exceeds --max-retained-mib ${MAX_RETAINED}`
    );
    process.exitCode = 1;
  }

  // Referenced after all measurements so V8 cannot collect the holds early and flatter the numbers.
  if (hold.length === 0) console.log("unreachable");
}

try {
  await main();
} finally {
  fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true });
}
