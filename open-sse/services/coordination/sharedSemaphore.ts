import { randomUUID } from "node:crypto";
import { SqliteCoordinator } from "./sqliteCoordinator.ts";
import type { AcquireManyOptions, SemaphoreRequirement } from "../accountSemaphore.ts";

declare global {
  var __omniSharedCoordinator: SqliteCoordinator | null | undefined;
}
const runtime = globalThis;

/** Opt-in and fail-closed: caller must be able to terminate upstream work on lease loss. */
export async function acquireSharedSemaphore(
  requirements: SemaphoreRequirement[],
  options: AcquireManyOptions
): Promise<() => void> {
  if (process.env.OMNI_COORDINATION_UNHEALTHY === "true")
    throw new Error("Shared coordination is unhealthy");
  const filename = process.env.OMNI_COORDINATION_DB;
  if (!filename || !options.onLeaseLost)
    throw new Error("Shared admission requires coordination DB and lease-loss fence");
  runtime.__omniSharedCoordinator ??= new SqliteCoordinator(
    filename,
    `${process.pid}:${randomUUID()}`
  );
  const backend = runtime.__omniSharedCoordinator;
  const enabled = requirements
    .filter((r) => Number.isFinite(r.maxConcurrency) && Number(r.maxConcurrency) >= 1)
    .map((r) => ({
      key: r.key,
      limit: Math.trunc(Number(r.maxConcurrency)),
      adaptive: r.adaptive,
    }));
  if (!enabled.length) return () => {};
  const deadline = Date.now() + (options.timeoutMs ?? 30000);
  const id = backend.enqueue(enabled, deadline, options.maxQueueSize);
  const ttlMs = 30000;
  try {
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Admission aborted");
      if (Date.now() >= deadline)
        throw Object.assign(new Error("Shared admission deadline exceeded"), {
          code: "SEMAPHORE_TIMEOUT",
        });
      const lease = backend.tryAcquire(id, ttlMs);
      if (lease) {
        let released = false;
        const heartbeat = setInterval(() => {
          if (released) return;
          try {
            if (backend.renew(lease, ttlMs)) return;
          } catch {
            /* Coordination failure must fence dispatch, not fail open. */
          }
          released = true;
          clearInterval(heartbeat);
          options.onLeaseLost!(new Error("Shared admission lease lost"));
          // Do not release capacity immediately: upstream cancellation may still be settling.
          // The durable TTL bounds recovery, and the stream abort fence stops new work.
        }, 10000);
        heartbeat.unref?.();
        return () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          backend.release(lease);
        };
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(options.signal?.reason ?? new Error("Admission aborted"));
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener("abort", abort);
          resolve();
        }, 50);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
      });
    }
  } finally {
    backend.cancel(id);
  }
}

export function markSharedBlocked(key: string, untilMs: number): void {
  if (!runtime.__omniSharedCoordinator) throw new Error("Shared coordination is not initialized");
  runtime.__omniSharedCoordinator!.block(key, untilMs);
}
export function unblockShared(key: string): void {
  if (!runtime.__omniSharedCoordinator) throw new Error("Shared coordination is not initialized");
  runtime.__omniSharedCoordinator!.unblock(key);
}
export function getSharedCoordinationReadiness() {
  return runtime.__omniSharedCoordinator?.readiness() ?? null;
}

/** Active durable admission probe; unsupported ownership surfaces remain false. */
export async function getRuntimeCoordinationCapabilities() {
  const disabled = {
    protocol: "omni-coordination/v1",
    accountAdmission: false,
    refreshOwnership: false,
    backgroundOwnership: false,
    conversationState: false,
  };
  if (process.env.OMNI_SHARED_ADMISSION !== "true") return disabled;
  try {
    const release = await acquireSharedSemaphore(
      [{ key: `readiness:${randomUUID()}`, maxConcurrency: 1 }],
      {
        timeoutMs: 1000,
        onLeaseLost: () => {},
      }
    );
    release();
    const { getPeriodicBarrierEvidence, periodicServicesAllowed } =
      await import("@/lib/periodicServices");
    const barrier = getPeriodicBarrierEvidence();
    const maintenanceHealthy =
      runtime.__omniSharedCoordinator?.hasLiveResource("task:maintenance") === true;
    const backgroundOwnership =
      maintenanceHealthy &&
      ((barrier.confirmed && barrier.role === "generation") ||
        (barrier.role === "maintenance" && periodicServicesAllowed("maintenance-readiness")));
    const { isCoordinatedRotationStoreReady } = await import("./grantRefresh.ts");
    const { getProviderConnections } = await import("@/lib/db/providers");
    const connections = await getProviderConnections();
    const guarded = new Set([
      "codex",
      "antigravity",
      "agy",
      "gemini",
      "github",
      "claude",
      "nous-oauth",
    ]);
    const refreshOwnership =
      (await isCoordinatedRotationStoreReady()) &&
      connections
        .filter((c) => c.isActive !== false && c.authType === "oauth" && !!c.refreshToken)
        .every((c) => guarded.has(c.provider));
    return {
      ...disabled,
      accountAdmission: !!getSharedCoordinationReadiness(),
      backgroundOwnership,
      refreshOwnership,
    };
  } catch {
    return disabled;
  }
}

/** Caller supplies verified concurrency classification; generic quota/auth failures are ignored. */
export function observeSharedAdmissionOutcome(
  key: string,
  outcome: "success" | "concurrency_overload" | "ignored",
  latencyMs: number
): void {
  runtime.__omniSharedCoordinator?.observe(key, outcome, latencyMs);
}

/** Readonly actual owned reservations; null means shared admission is not initialized. */
export function getRuntimeCoordinationCounts() {
  return runtime.__omniSharedCoordinator?.runtimeCounts() ?? null;
}
