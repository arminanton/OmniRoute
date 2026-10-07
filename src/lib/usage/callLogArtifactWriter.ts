import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import type { CallLogArtifact, CallLogArtifactWriteResult } from "./callLogArtifacts.ts";

const MAX_QUEUED_JOBS = 128;
// The estimate reserves for the retained source value, its worker clone, and
// worst-case JSON escaping while the active artifact is serialized. It is a
// peak-footprint budget for the active write plus all waiting writes.
const MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES = 128 * 1024 * 1024;
const MAX_ESTIMATED_VALUES = 100_000;
const MAX_ESTIMATED_OBJECTS = 50_000;
const MAX_ESTIMATOR_DEPTH = 64;
const IDLE_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 2_000;
const WARNING_INTERVAL_MS = 30_000;

type WorkerReply = {
  id: number;
  result: CallLogArtifactWriteResult | null;
};

type QueueItem = {
  id: number;
  artifact: CallLogArtifact;
  estimatedFootprintBytes: number;
  reservationReleased: boolean;
  environment: {
    pipelineMaxSizeKb?: string;
    chatDebugFile?: string;
    appLogLevel?: string;
  };
  resolve: (result: CallLogArtifactWriteResult | null) => void;
};

let worker: Worker | null = null;
let active: QueueItem | null = null;
const queue: QueueItem[] = [];
let nextId = 1;
let idleTimer: NodeJS.Timeout | null = null;
let closing = false;
let closeWaiters: Array<() => void> = [];
const lastWarningAt = new Map<string, number>();
let reservedArtifactFootprintBytes = 0;

export type CallLogArtifactFootprintEstimate = {
  estimatedBytes: number;
  reason?:
    "budget_exceeded" | "value_limit" | "object_limit" | "depth_limit" | "cycle" | "unsupported";
};

function hasDynamicToJSON(value: object, prototype: object | null): boolean {
  const descriptors = [
    Object.getOwnPropertyDescriptor(value, "toJSON"),
    prototype ? Object.getOwnPropertyDescriptor(prototype, "toJSON") : undefined,
  ];
  return descriptors.some(
    (descriptor) =>
      descriptor !== undefined &&
      (!Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        typeof descriptor.value === "function")
  );
}

/**
 * Estimate the temporary footprint of an artifact without serializing it.
 * String accounting allows ten bytes per UTF-16 code unit: source storage,
 * structured-clone storage, and up to six JSON bytes for escaped output.
 * Object/array overhead is deliberately rounded up. Cycles, accessors, and
 * unsupported values fail closed for detail capture; inference stays fail-open.
 */
export function estimateCallLogArtifactFootprint(value: unknown): CallLogArtifactFootprintEstimate {
  let estimatedBytes = 0;
  let valuesVisited = 0;
  let objectsVisited = 0;
  const ancestors = new WeakSet<object>();

  const add = (bytes: number): boolean => {
    if (!Number.isFinite(bytes) || bytes < 0) return false;
    estimatedBytes += bytes;
    return estimatedBytes <= MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES;
  };

  const visit = (current: unknown, depth: number): CallLogArtifactFootprintEstimate | null => {
    valuesVisited++;
    if (valuesVisited > MAX_ESTIMATED_VALUES) return { estimatedBytes, reason: "value_limit" };
    if (depth > MAX_ESTIMATOR_DEPTH) return { estimatedBytes, reason: "depth_limit" };

    if (current === null) return add(32) ? null : { estimatedBytes, reason: "budget_exceeded" };
    switch (typeof current) {
      case "string":
        return add(64 + current.length * 10) ? null : { estimatedBytes, reason: "budget_exceeded" };
      case "number":
      case "boolean":
        return add(64) ? null : { estimatedBytes, reason: "budget_exceeded" };
      case "undefined":
        return add(32) ? null : { estimatedBytes, reason: "budget_exceeded" };
      case "bigint":
      case "function":
      case "symbol":
        return { estimatedBytes, reason: "unsupported" };
      case "object":
        break;
      default:
        return { estimatedBytes, reason: "unsupported" };
    }

    const objectValue = current as object;
    objectsVisited++;
    if (objectsVisited > MAX_ESTIMATED_OBJECTS) return { estimatedBytes, reason: "object_limit" };
    if (ancestors.has(objectValue)) return { estimatedBytes, reason: "cycle" };

    try {
      if (Array.isArray(objectValue)) {
        const array = objectValue as unknown[];
        if (hasDynamicToJSON(objectValue, Array.prototype))
          return { estimatedBytes, reason: "unsupported" };
        if (!add(128 + array.length * 32)) return { estimatedBytes, reason: "budget_exceeded" };
        if (array.length > MAX_ESTIMATED_VALUES - valuesVisited)
          return { estimatedBytes, reason: "value_limit" };

        ancestors.add(objectValue);
        for (let index = 0; index < array.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
          if (!descriptor) continue; // Sparse slots are covered by the array base estimate.
          if (!("value" in descriptor)) return { estimatedBytes, reason: "unsupported" };
          const nested = visit(descriptor.value, depth + 1);
          if (nested) return nested;
        }
        ancestors.delete(objectValue);
        return null;
      }

      const prototype = Object.getPrototypeOf(objectValue);
      if (prototype !== Object.prototype && prototype !== null)
        return { estimatedBytes, reason: "unsupported" };
      if (hasDynamicToJSON(objectValue, prototype))
        return { estimatedBytes, reason: "unsupported" };
      if (!add(128)) return { estimatedBytes, reason: "budget_exceeded" };

      ancestors.add(objectValue);
      for (const key in objectValue as Record<string, unknown>) {
        if (!Object.prototype.hasOwnProperty.call(objectValue, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
        if (!descriptor?.enumerable) continue;
        if (!("value" in descriptor)) return { estimatedBytes, reason: "unsupported" };
        if (!add(64 + key.length * 10)) return { estimatedBytes, reason: "budget_exceeded" };
        const nested = visit(descriptor.value, depth + 1);
        if (nested) return nested;
      }
      ancestors.delete(objectValue);
      return null;
    } catch {
      return { estimatedBytes, reason: "unsupported" };
    }
  };

  const failure = visit(value, 0);
  if (failure) {
    return {
      estimatedBytes: Math.min(
        MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES + 1,
        Math.max(0, failure.estimatedBytes)
      ),
      reason: failure.reason,
    };
  }
  return { estimatedBytes };
}

function releaseReservation(item: QueueItem): void {
  if (item.reservationReleased) return;
  item.reservationReleased = true;
  reservedArtifactFootprintBytes = Math.max(
    0,
    reservedArtifactFootprintBytes - item.estimatedFootprintBytes
  );
}

function fileExistsAtRuntime(candidate: string): boolean {
  // The worker is copied explicitly by the standalone/npm packaging policies.
  // Keep this runtime probe opaque to Next's build tracer so it does not expand
  // a variable filesystem expression into a repository-wide glob.
  return Reflect.apply(fs.existsSync, fs, [candidate]) as boolean;
}

type WorkerResolutionContext = {
  moduleDir?: string;
  cwd?: string;
  entryFile?: string | null;
  fileExists?: (candidate: string) => boolean;
};

export function resolveCallLogArtifactWorker(context: WorkerResolutionContext = {}): {
  workerFile: string;
  execArgv: string[];
} {
  const moduleDir = context.moduleDir ?? path.dirname(fileURLToPath(import.meta.url));
  const cwd = context.cwd ?? process.cwd();
  const entryFile = context.entryFile === undefined ? process.argv[1] : context.entryFile;
  const exists = context.fileExists ?? fileExistsAtRuntime;

  const moduleJs = path.join(moduleDir, "callLogArtifactWorker.js");
  if (exists(moduleJs)) return { workerFile: moduleJs, execArgv: [] };

  const entryJs = entryFile
    ? path.join(path.dirname(path.resolve(entryFile)), "src/lib/usage/callLogArtifactWorker.js")
    : null;
  if (entryJs && exists(entryJs)) return { workerFile: entryJs, execArgv: [] };

  const cwdJs = path.resolve(cwd, "src/lib/usage/callLogArtifactWorker.js");
  if (exists(cwdJs)) return { workerFile: cwdJs, execArgv: [] };

  const moduleTs = path.join(moduleDir, "callLogArtifactWorker.ts");
  if (exists(moduleTs)) {
    return { workerFile: moduleTs, execArgv: ["--import", "tsx/esm"] };
  }

  const cwdTs = path.resolve(cwd, "src/lib/usage/callLogArtifactWorker.ts");
  if (exists(cwdTs)) {
    return { workerFile: cwdTs, execArgv: ["--import", "tsx/esm"] };
  }

  return { workerFile: entryJs ?? cwdJs, execArgv: [] };
}

function clearIdleTimer(): void {
  if (!idleTimer) return;
  clearTimeout(idleTimer);
  idleTimer = null;
}

function terminateWorker(): void {
  const current = worker;
  worker = null;
  clearIdleTimer();
  if (current) void current.terminate().catch(() => {});
}

function notifyCloseWaiters(): void {
  if (active || queue.length > 0) return;
  const waiters = closeWaiters;
  closeWaiters = [];
  for (const resolve of waiters) resolve();
}

function scheduleIdleTermination(): void {
  clearIdleTimer();
  if (!worker || active || queue.length > 0) return;
  idleTimer = setTimeout(terminateWorker, IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function warnRateLimited(message: string): void {
  const now = Date.now();
  if (now - (lastWarningAt.get(message) ?? 0) < WARNING_INTERVAL_MS) return;
  lastWarningAt.set(message, now);
  console.warn(message);
}

function failOpen(warn = false): void {
  if (warn) warnRateLimited("[callLogs] Call-log artifact worker failed; detail omitted.");
  const failed = active ? [active, ...queue] : [...queue];
  active = null;
  queue.length = 0;
  for (const item of failed) releaseReservation(item);
  terminateWorker();
  for (const item of failed) item.resolve(null);
  notifyCloseWaiters();
}

function ensureWorker(): Worker {
  if (worker) return worker;

  const { workerFile, execArgv } = resolveCallLogArtifactWorker();
  // Reflect.construct keeps Next/Turbopack from interpreting the runtime-selected
  // worker path as a build-time glob and tracing tens of thousands of unrelated files.
  const created = Reflect.construct(Worker, [pathToFileURL(workerFile), { execArgv }]) as Worker;
  worker = created;
  created.on("message", (reply: WorkerReply) => {
    if (!active || reply.id !== active.id) return;
    const completed = active;
    active = null;
    releaseReservation(completed);
    completed.resolve(reply.result);
    pump();
  });
  created.on("error", () => failOpen(true));
  created.on("messageerror", () => failOpen(true));
  created.on("exit", (code) => {
    if (worker !== created) return;
    worker = null;
    if (code !== 0 || active) failOpen(true);
  });
  return created;
}

function pump(): void {
  if (active) return;
  const next = queue.shift();
  if (!next) {
    notifyCloseWaiters();
    scheduleIdleTermination();
    return;
  }

  active = next;
  clearIdleTimer();
  try {
    ensureWorker().postMessage({
      id: next.id,
      artifact: next.artifact,
      environment: next.environment,
    });
  } catch {
    failOpen(true);
  }
}

export function writeCallArtifactAsync(
  artifact: CallLogArtifact
): Promise<CallLogArtifactWriteResult | null> {
  if (closing || queue.length >= MAX_QUEUED_JOBS) {
    warnRateLimited("[callLogs] Call-log artifact queue unavailable; detail omitted.");
    return Promise.resolve(null);
  }

  const estimate = estimateCallLogArtifactFootprint(artifact);
  if (
    estimate.reason ||
    estimate.estimatedBytes > MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES ||
    reservedArtifactFootprintBytes + estimate.estimatedBytes > MAX_QUEUED_ARTIFACT_FOOTPRINT_BYTES
  ) {
    warnRateLimited("[callLogs] Call-log artifact memory budget exceeded; detail omitted.");
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const item = {
      id: nextId++,
      artifact,
      estimatedFootprintBytes: estimate.estimatedBytes,
      reservationReleased: false,
      environment: {
        pipelineMaxSizeKb: process.env.CALL_LOG_PIPELINE_MAX_SIZE_KB,
        chatDebugFile: process.env.CHAT_DEBUG_FILE,
        appLogLevel: process.env.APP_LOG_LEVEL,
      },
      resolve,
    };
    reservedArtifactFootprintBytes += estimate.estimatedBytes;
    queue.push(item);
    pump();
  });
}

export async function closeCallLogArtifactWriter(timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  closing = true;
  if (!active && queue.length === 0) {
    terminateWorker();
    return;
  }

  if (timeoutMs <= 0) {
    failOpen();
    terminateWorker();
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    new Promise<void>((resolve) => closeWaiters.push(resolve)),
    new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, timeoutMs);
      timeout.unref?.();
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (active || queue.length > 0) failOpen();
  terminateWorker();
}
