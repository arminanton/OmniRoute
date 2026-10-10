import { resolveQuotaIdentity } from "./quotaIdentity.ts";
import { acquireMany } from "./accountSemaphore.ts";

/** Internal control-flow marker for combo engines; it is never exposed as a response header. */
const terminalAdmissionFailureResponses = new WeakSet<Response>();

export function markAccountAdmissionFailureResponse(response: Response): Response {
  terminalAdmissionFailureResponses.add(response);
  return response;
}

export function isAccountAdmissionFailureResponse(response: Response): boolean {
  return terminalAdmissionFailureResponses.has(response);
}

type AdmissionCredentials = {
  connectionId?: string | null;
  id?: string | null;
  maxConcurrent?: number | null;
  providerSpecificData?: Record<string, unknown> | null;
};

export type ConfiguredSharedAccountAdmission = {
  signal: AbortSignal;
  release: () => void;
};

/** Distinguish a client disconnect from loss of the shared-capacity lease. */
export function getAccountAdmissionAbortStatus(
  callerSignal?: AbortSignal | null,
  admissionSignal?: AbortSignal | null
): 499 | 503 | null {
  if (callerSignal?.aborted) return 499;
  if (admissionSignal?.aborted) return 503;
  return null;
}

/**
 * Run one selected-account media request under the shared account cap when the
 * operator enabled shared admission and configured a positive account limit.
 * Unknown/unlimited accounts keep their existing behavior. The supplied signal
 * is also the lease-loss fence for the upstream operation.
 */
export async function acquireConfiguredSharedAccountAdmission(options: {
  provider: string;
  credentials: AdmissionCredentials | null | undefined;
  signal?: AbortSignal;
}): Promise<ConfiguredSharedAccountAdmission | null> {
  if (process.env.OMNI_SHARED_ADMISSION !== "true") return null;

  const credentials = options.credentials;
  if (!credentials) return null;
  const configuredCapacity = credentials.maxConcurrent;
  if (
    typeof configuredCapacity !== "number" ||
    !Number.isFinite(configuredCapacity) ||
    configuredCapacity <= 0
  ) {
    return null;
  }

  const connectionId = credentials.connectionId ?? credentials.id ?? null;
  const key = resolveQuotaIdentity(options.provider, connectionId, credentials);
  if (!key) return null;

  const controller = new AbortController();
  const callerSignal = options.signal;
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let releaseLease: (() => void) | undefined;
  let handedOff = false;
  try {
    try {
      releaseLease = await acquireMany(
        [{ key, maxConcurrency: Math.max(1, Math.trunc(configuredCapacity)) }],
        {
          signal: controller.signal,
          onLeaseLost: (error) => controller.abort(error),
        }
      );
    } catch (error) {
      throw Object.assign(
        new Error(
          controller.signal.aborted
            ? "Account capacity admission was cancelled"
            : "Account capacity admission is unavailable"
        ),
        {
          code: "ACCOUNT_ADMISSION_UNAVAILABLE",
          statusCode: controller.signal.aborted ? 499 : 503,
          cause: error,
        }
      );
    }

    controller.signal.throwIfAborted();
    let released = false;
    handedOff = true;
    return {
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        releaseLease?.();
        callerSignal?.removeEventListener("abort", abortFromCaller);
      },
    };
  } finally {
    if (!handedOff) {
      releaseLease?.();
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export async function withConfiguredSharedAccountAdmission<T>(
  options: {
    provider: string;
    credentials: AdmissionCredentials | null | undefined;
    signal?: AbortSignal;
  },
  operation: (signal?: AbortSignal) => Promise<T>
): Promise<T> {
  const lease = await acquireConfiguredSharedAccountAdmission(options);
  if (!lease) return operation(options.signal);
  try {
    return await operation(lease.signal);
  } finally {
    lease.release();
  }
}
