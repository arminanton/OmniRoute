import fs from "node:fs";
import path from "node:path";
import v8 from "node:v8";

const CGROUP_ROOT = "/sys/fs/cgroup";
const SMAPS_FIELDS = new Set([
  "Rss",
  "Pss",
  "Pss_Anon",
  "Pss_File",
  "Pss_Shmem",
  "Private_Clean",
  "Private_Dirty",
  "Shared_Clean",
  "Shared_Dirty",
  "Swap",
]);

function readProcKilobyteFields(pid, filename, allowedFields) {
  try {
    const values = {};
    for (const line of fs.readFileSync(`/proc/${pid}/${filename}`, "utf8").split("\n")) {
      const match = /^([^:]+):\s+(\d+)\s+kB$/.exec(line);
      if (match && allowedFields.has(match[1])) values[match[1]] = Number(match[2]) * 1024;
    }
    return values;
  } catch {
    return null;
  }
}

function readCgroupKeyValues(directory, filename) {
  try {
    const values = {};
    for (const line of fs.readFileSync(path.join(directory, filename), "utf8").split("\n")) {
      const [key, raw] = line.trim().split(/\s+/, 2);
      if (key && raw !== undefined && Number.isFinite(Number(raw))) values[key] = Number(raw);
    }
    return values;
  } catch {
    return null;
  }
}

function readPressure(directory) {
  try {
    const result = {};
    for (const line of fs
      .readFileSync(path.join(directory, "memory.pressure"), "utf8")
      .split("\n")) {
      const [kind, ...parts] = line.trim().split(/\s+/);
      if (!kind) continue;
      const values = {};
      for (const part of parts) {
        const [key, raw] = part.split("=", 2);
        const value = Number(raw);
        if (key && Number.isFinite(value)) values[key] = value;
      }
      result[kind] = values;
    }
    return result;
  } catch {
    return null;
  }
}

/** Small, payload-free snapshot for isolated multi-process memory benchmarks. */
export function snapshotProcessMemory(pid = process.pid) {
  const isCurrentProcess = pid === process.pid;
  const usage = isCurrentProcess ? process.memoryUsage() : null;
  const stats = isCurrentProcess ? v8.getHeapStatistics() : null;
  const resourceUsage = isCurrentProcess ? process.resourceUsage() : null;
  return {
    pid,
    memory: usage
      ? {
          rssBytes: usage.rss,
          heapUsedBytes: usage.heapUsed,
          heapTotalBytes: usage.heapTotal,
          externalBytes: usage.external,
          arrayBuffersBytes: usage.arrayBuffers,
        }
      : null,
    v8Heap: stats
      ? {
          usedBytes: stats.used_heap_size,
          totalBytes: stats.total_heap_size,
          limitBytes: stats.heap_size_limit,
          availableBytes: stats.total_available_size,
          externalBytes: stats.external_memory,
        }
      : null,
    maxRssBytes:
      resourceUsage && Number.isFinite(resourceUsage.maxRSS) ? resourceUsage.maxRSS * 1024 : null,
    userCpuMicros: resourceUsage?.userCPUTime ?? null,
    systemCpuMicros: resourceUsage?.systemCPUTime ?? null,
    procStatusBytes: readProcKilobyteFields(
      pid,
      "status",
      new Set(["VmRSS", "VmHWM", "VmData", "VmSwap"])
    ),
    smapsRollupBytes: readProcKilobyteFields(pid, "smaps_rollup", SMAPS_FIELDS),
  };
}

/** Snapshot the cgroup-v2 scope containing the supplied process, when readable. */
export function snapshotCgroupMemory(pid = process.pid) {
  try {
    const membership = fs
      .readFileSync(`/proc/${pid}/cgroup`, "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"));
    if (!membership) return null;
    const relative = membership.slice(3).replace(/^\/+/, "");
    const directory = path.join(CGROUP_ROOT, relative);
    if (!directory.startsWith(`${CGROUP_ROOT}${path.sep}`)) return null;
    const readLimit = (name) => {
      const raw = fs.readFileSync(path.join(directory, name), "utf8").trim();
      return raw === "max" ? raw : Number(raw);
    };
    return {
      currentBytes: readLimit("memory.current"),
      peakBytes: readLimit("memory.peak"),
      maxBytes: readLimit("memory.max"),
      highBytes: readLimit("memory.high"),
      events: readCgroupKeyValues(directory, "memory.events"),
      statBytes: readCgroupKeyValues(directory, "memory.stat"),
      pressure: readPressure(directory),
    };
  } catch {
    return null;
  }
}

/** Sample current-process heap/RSS over a bounded benchmark interval. */
export function createProcessMemorySampler(intervalMs = 1_000, maxSamples = 600) {
  const startedAtMs = Date.now();
  const samples = [];
  const peaks = {};
  let stopped = false;

  const sample = () => {
    const memory = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const values = {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      v8HeapLimitBytes: heap.heap_size_limit,
    };
    for (const [key, value] of Object.entries(values)) {
      peaks[key] = Math.max(peaks[key] ?? 0, value);
    }
    if (samples.length < maxSamples) {
      samples.push({ elapsedMs: Date.now() - startedAtMs, ...values });
    }
  };

  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();

  return {
    finish() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        sample();
      }
      const maxRssKiB = process.resourceUsage().maxRSS;
      return {
        sampleIntervalMs: intervalMs,
        samples,
        peaks,
        processMaxRssBytes: Number.isFinite(maxRssKiB) ? maxRssKiB * 1024 : null,
      };
    },
  };
}
