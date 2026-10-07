import { getDbInstance } from "../db/core";
import { protectPayloadForLog } from "@/lib/logPayloads";
import type { PendingRequestDetail } from "./usageHistory";
import { truncatePendingPreview } from "./usageHistory/helpers";

const COMPLETED_DETAIL_TTL_MS = 120_000;
const MAX_COMPLETED_DETAILS = 256;
// A 512 KiB per-request stream excerpt can otherwise occupy 128 MiB across the
// 256-entry/120-second completed cache. Keep the 100-session default profile
// (about 50 MiB) intact while bounding heavier custom profiles and bursts.
const MAX_COMPLETED_STREAM_CHUNK_BYTES = 64 * 1024 * 1024;

const completedDetails = new Map<string, PendingRequestDetail>();
const completedDetailTimers = new Map<string, ReturnType<typeof setTimeout>>();
const completedDetailStreamBytes = new Map<string, number>();
let totalCompletedDetailStreamBytes = 0;

export function projectCompletedArtifactPreview(value: unknown): unknown {
  // Completed detail is an in-memory dashboard cache. Persisted artifacts keep
  // the full protected payload; this cache must retain only a bounded preview.
  return protectPayloadForLog(truncatePendingPreview(value));
}

function estimateStreamChunkMemory(detail: PendingRequestDetail): number {
  const tracks = detail.streamChunks;
  if (!tracks) return 0;
  let bytes = 0;
  for (const chunks of [tracks.provider, tracks.openai, tracks.client]) {
    if (!Array.isArray(chunks)) continue;
    for (const chunk of chunks) {
      if (typeof chunk !== "string") continue;
      bytes += Math.max(chunk.length * 2, Buffer.byteLength(chunk, "utf8")) + 64;
    }
  }
  return bytes;
}

function deleteCompletedDetail(id: string) {
  completedDetails.delete(id);
  const streamBytes = completedDetailStreamBytes.get(id) ?? 0;
  totalCompletedDetailStreamBytes = Math.max(0, totalCompletedDetailStreamBytes - streamBytes);
  completedDetailStreamBytes.delete(id);
  const existingTimer = completedDetailTimers.get(id);
  if (existingTimer) {
    clearTimeout(existingTimer);
    completedDetailTimers.delete(id);
  }
}

function trimCompletedDetails() {
  while (completedDetails.size > MAX_COMPLETED_DETAILS) {
    const oldestId = completedDetails.keys().next().value;
    if (!oldestId) break;
    deleteCompletedDetail(oldestId);
  }
}

function trimCompletedStreamChunkMemory() {
  while (totalCompletedDetailStreamBytes > MAX_COMPLETED_STREAM_CHUNK_BYTES) {
    let oldestStreamDetail: string | undefined;
    for (const [id, bytes] of completedDetailStreamBytes) {
      if (bytes > 0) {
        oldestStreamDetail = id;
        break;
      }
    }
    if (!oldestStreamDetail) break;
    deleteCompletedDetail(oldestStreamDetail);
  }
}

export function getCompletedDetails(): Map<string, PendingRequestDetail> {
  return completedDetails;
}

export function storeCompletedDetail(detail: PendingRequestDetail) {
  const previousBytes = completedDetailStreamBytes.get(detail.id) ?? 0;
  totalCompletedDetailStreamBytes = Math.max(0, totalCompletedDetailStreamBytes - previousBytes);
  completedDetails.set(detail.id, detail);
  const streamBytes = estimateStreamChunkMemory(detail);
  if (streamBytes > 0) completedDetailStreamBytes.set(detail.id, streamBytes);
  else completedDetailStreamBytes.delete(detail.id);
  totalCompletedDetailStreamBytes += streamBytes;
  trimCompletedDetails();
  trimCompletedStreamChunkMemory();
}

export function scheduleCompletedDetailCleanup(id: string) {
  const existingTimer = completedDetailTimers.get(id);
  if (existingTimer) clearTimeout(existingTimer);
  const timer = setTimeout(() => {
    deleteCompletedDetail(id);
  }, COMPLETED_DETAIL_TTL_MS);
  timer.unref?.();
  completedDetailTimers.set(id, timer);
}

export function clearCompletedDetails() {
  for (const timer of completedDetailTimers.values()) clearTimeout(timer);
  completedDetailTimers.clear();
  completedDetails.clear();
  completedDetailStreamBytes.clear();
  totalCompletedDetailStreamBytes = 0;
}

export function maybeEnrichCompletedDetail(updated: PendingRequestDetail, connectionId: string) {
  void (async () => {
    try {
      const missingProvider =
        updated.providerResponse === undefined || updated.providerResponse === null;
      const missingClient = updated.clientResponse === undefined || updated.clientResponse === null;
      if (!missingProvider && !missingClient) return;

      const db = getDbInstance();
      const sinceIso = new Date(Date.now() - 30_000).toISOString();
      const rows = db
        .prepare(
          `SELECT artifact_relpath FROM call_logs WHERE connection_id = ? AND model = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 5`
        )
        .all(connectionId, updated.model, sinceIso) as Array<{ artifact_relpath: string | null }>;
      for (const row of rows) {
        if (!row.artifact_relpath) continue;
        const { readCallArtifact } = await import("./callLogArtifacts");
        const art = readCallArtifact(row.artifact_relpath);
        if (art.state !== "ready" || !art.artifact) continue;
        const pipeline = art.artifact.pipeline as
          { providerResponse?: unknown; clientResponse?: unknown } | undefined;
        if (missingProvider && pipeline?.providerResponse) {
          updated.providerResponse = projectCompletedArtifactPreview(pipeline.providerResponse);
        }
        if (missingClient && pipeline?.clientResponse) {
          updated.clientResponse = projectCompletedArtifactPreview(pipeline.clientResponse);
        }
        if (
          (missingProvider && art.artifact.responseBody) ||
          (missingClient && art.artifact.responseBody)
        ) {
          if (missingProvider)
            updated.providerResponse = projectCompletedArtifactPreview(art.artifact.responseBody);
          if (missingClient)
            updated.clientResponse = projectCompletedArtifactPreview(art.artifact.responseBody);
        }
        if (updated.providerResponse || updated.clientResponse) {
          if (completedDetails.has(updated.id)) storeCompletedDetail(updated);
          break;
        }
      }
    } catch (e) {
      try {
        console.warn(
          "[usageHistory] failed to enrich completed detail from artifacts:",
          e && (e.message || e)
        );
      } catch {}
    }
  })();
}
