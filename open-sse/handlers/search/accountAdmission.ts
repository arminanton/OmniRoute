import { acquireConfiguredSharedAccountAdmission } from "../../services/accountRequestAdmission.ts";
import { reserveAccountRequest } from "../../services/accountRequestOccupancy.ts";
import { resolveProviderId } from "@/shared/constants/providers";

export type SearchAdmissionCredentials = {
  id?: string | null;
  connectionId?: string | null;
  provider?: string | null;
  maxConcurrent?: number | null;
  providerSpecificData?: Record<string, unknown> | null;
  releaseAccountRequest?: (() => void) | null;
};

export type SearchAdmissionOutcome<T> =
  { admitted: true; value: T } | { admitted: false; error: string };

interface SearchSelectionEntry<T> {
  promise: Promise<T>;
  waiters: number;
  settled: boolean;
  hasValue: boolean;
  value?: T;
  dispose?: (value: T) => void;
  disposed: boolean;
}

const searchSelections = new Map<string, SearchSelectionEntry<unknown>>();
const producerOwnedReservations = new WeakSet<() => void>();

/**
 * Share credential selection for identical in-flight searches. This keeps a
 * duplicate request on the same selected account long enough to join the
 * connection-scoped result coalescer, while distinct queries select
 * independently and observe each other's account reservations.
 */
export async function acquireSearchCredentialSelection<T>(
  key: string,
  select: () => Promise<T>,
  dispose?: (value: T) => void
): Promise<{ value: T; release: () => void }> {
  let entry = searchSelections.get(key) as SearchSelectionEntry<T> | undefined;
  if (!entry) {
    entry = {
      promise: Promise.resolve().then(select),
      waiters: 0,
      settled: false,
      hasValue: false,
      dispose,
      disposed: false,
    };
    searchSelections.set(key, entry as SearchSelectionEntry<unknown>);
    const ownedEntry = entry;
    void ownedEntry.promise.then(
      (value) => {
        ownedEntry.settled = true;
        ownedEntry.value = value;
        ownedEntry.hasValue = true;
        disposeSelectionIfUnused(key, ownedEntry);
      },
      () => {
        ownedEntry.settled = true;
        disposeSelectionIfUnused(key, ownedEntry);
      }
    );
  }

  entry.waiters++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry!.waiters = Math.max(0, entry!.waiters - 1);
    disposeSelectionIfUnused(key, entry!);
  };

  try {
    return { value: await entry.promise, release };
  } catch (error) {
    release();
    throw error;
  }
}

function disposeSelectionIfUnused<T>(key: string, entry: SearchSelectionEntry<T>): void {
  if (!entry.settled || entry.waiters !== 0) return;
  if (entry.hasValue && !entry.disposed) {
    entry.disposed = true;
    try {
      entry.dispose?.(entry.value as T);
    } catch {
      // Cleanup must not replace the route's success or original error.
    }
  }
  if (searchSelections.get(key) === entry) searchSelections.delete(key);
}

/** Release selected capacity only when no provider attempt claimed it. */
export function releaseUnclaimedSearchCredentialReservation(
  credentials: Pick<SearchAdmissionCredentials, "releaseAccountRequest"> | null | undefined
): void {
  const release = credentials?.releaseAccountRequest;
  if (typeof release === "function" && !producerOwnedReservations.has(release)) {
    release();
  }
}

/** Reserve only the cache producer's selected account for one provider attempt. */
export async function runWithSearchAccountAdmission<T>(options: {
  provider: string;
  credentials: SearchAdmissionCredentials;
  fallbackConnectionId?: string;
  signal?: AbortSignal;
  attempt: (admissionSignal?: AbortSignal) => Promise<T>;
}): Promise<SearchAdmissionOutcome<T>> {
  const { credentials, signal } = options;
  const selectedReservation = credentials.releaseAccountRequest;
  if (typeof selectedReservation === "function") {
    // The cache producer owns this slot until its upstream attempt ends. A
    // cancelled waiter may finish its route first, so route cleanup must not
    // release the producer's reservation while shared work is still running.
    producerOwnedReservations.add(selectedReservation);
  }
  // Credential selection can reserve before search coalescing so concurrent
  // distinct-query misses see that load. Reuse that slot for the producer
  // attempt instead of incrementing local occupancy a second time.
  const releaseLocal =
    typeof selectedReservation === "function"
      ? selectedReservation
      : reserveAccountRequest(
          credentials.connectionId || credentials.id || options.fallbackConnectionId
        );
  let sharedAdmission: Awaited<ReturnType<typeof acquireConfiguredSharedAccountAdmission>> = null;
  const throwIfCallerAborted = (cause?: unknown): never => {
    if (signal?.reason !== undefined) throw signal.reason;
    if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    throw cause;
  };

  try {
    const credentialOwner =
      typeof credentials.provider === "string" && credentials.provider.trim()
        ? resolveProviderId(credentials.provider.trim())
        : options.provider;
    try {
      sharedAdmission = await acquireConfiguredSharedAccountAdmission({
        provider: credentialOwner,
        credentials,
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throwIfCallerAborted(error);
      const admissionError = error as { code?: string; message?: string };
      if (admissionError.code === "ACCOUNT_ADMISSION_UNAVAILABLE") {
        return {
          admitted: false,
          error: admissionError.message || "Provider account capacity admission is unavailable",
        };
      }
      throw error;
    }

    if (signal?.aborted) throwIfCallerAborted();
    const value = await options.attempt(sharedAdmission?.signal);
    if (sharedAdmission?.signal.aborted && !signal?.aborted) {
      return {
        admitted: false,
        error: "Provider account capacity admission was lost during search",
      };
    }
    return { admitted: true, value };
  } catch (error) {
    if (signal?.aborted) throwIfCallerAborted(error);
    if (sharedAdmission?.signal.aborted) {
      return {
        admitted: false,
        error: "Provider account capacity admission was lost during search",
      };
    }
    throw error;
  } finally {
    sharedAdmission?.release();
    releaseLocal();
  }
}
