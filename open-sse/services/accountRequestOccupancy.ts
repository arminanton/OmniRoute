/**
 * Process-local view of requests currently assigned to provider accounts.
 *
 * This is a routing hint, not admission control: accountSemaphore remains the
 * hard concurrency gate. The lease is acquired synchronously before credential
 * hydration yields, so concurrent selections in this worker see each other's
 * reservations. It is released by the request handler when the response ends,
 * is cancelled, or the attempt is abandoned.
 */
type CapacityCandidate = {
  id: string;
  priority?: number | null;
  maxConcurrent?: number | null;
};

const activeRequests = new Map<string, number>();
const lastSelectedByProvider = new Map<string, string>();
const MAX_PROVIDER_CURSORS = 512;

export function getAccountRequestInFlightCount(connectionId: string | null | undefined): number {
  return connectionId ? (activeRequests.get(connectionId) ?? 0) : 0;
}

export function reserveAccountRequest(connectionId: string | null | undefined): () => void {
  if (!connectionId) return () => {};
  activeRequests.set(connectionId, getAccountRequestInFlightCount(connectionId) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = getAccountRequestInFlightCount(connectionId) - 1;
    if (remaining <= 0) activeRequests.delete(connectionId);
    else activeRequests.set(connectionId, remaining);
  };
}

function effectiveCapacity(candidate: CapacityCandidate): number {
  const configured = candidate.maxConcurrent;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.max(1, Math.trunc(configured))
    : 1;
}

/**
 * Pick the account with the lowest estimated occupied-capacity ratio. A
 * configured maxConcurrent is its capacity; an unset cap gets one estimated
 * slot so traffic spreads instead of treating an unknown account as infinite.
 * Existing priority order wins true ties, and an in-memory cursor rotates
 * equally eligible peers without a SQLite last-used write on every request.
 */
export function selectAvailableCapacityConnection<T extends CapacityCandidate>(
  provider: string,
  candidates: readonly T[]
): T | undefined {
  if (candidates.length === 0) return undefined;
  let lowestLoad = Number.POSITIVE_INFINITY;
  let eligible: T[] = [];

  for (const candidate of candidates) {
    const load = getAccountRequestInFlightCount(candidate.id) / effectiveCapacity(candidate);
    if (load < lowestLoad - 1e-9) {
      lowestLoad = load;
      eligible = [candidate];
    } else if (Math.abs(load - lowestLoad) <= 1e-9) {
      eligible.push(candidate);
    }
  }

  const preferredPriority = Math.min(
    ...eligible.map((candidate) => candidate.priority ?? Number.MAX_SAFE_INTEGER)
  );
  eligible = eligible.filter(
    (candidate) => (candidate.priority ?? Number.MAX_SAFE_INTEGER) === preferredPriority
  );

  const lastSelected = lastSelectedByProvider.get(provider);
  const previousIndex = eligible.findIndex((candidate) => candidate.id === lastSelected);
  const selected = eligible[(previousIndex + 1) % eligible.length];
  lastSelectedByProvider.delete(provider);
  lastSelectedByProvider.set(provider, selected.id);
  while (lastSelectedByProvider.size > MAX_PROVIDER_CURSORS) {
    const oldest = lastSelectedByProvider.keys().next().value;
    if (oldest === undefined) break;
    lastSelectedByProvider.delete(oldest);
  }
  return selected;
}

export function _clearAccountRequestOccupancyForTest(): void {
  activeRequests.clear();
  lastSelectedByProvider.clear();
}
